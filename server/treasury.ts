// ───────────────────────────────────────────────────────────────
//  公司金库：公司钱包里的（原生）SOL 就是公司资产
//  · accountSubscribe(每个公司钱包)        → SOL 余额毫秒级更新
//  · getSignaturesForAddress + getTransaction → 还原每笔交易后的余额（资产走势）和资金流水
//  · 余额变化后自动补拉新交易，并定时对账
//  钱包里持有的代币、Wrapped SOL 都不计入公司资产。
// ───────────────────────────────────────────────────────────────
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { LST_MINTS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT, type CompanyWalletConfig } from '../shared/constants';
import type { ActivityKind, ServerMessage, TreasuryActivity, TreasuryHistoryPoint, TreasurySnapshot, TreasuryWallet, WalletPreview } from '../shared/types';
import { getJson, sleep } from './http';
import type { SolPriceFeed } from './prices';
import type { RpcHttp, RpcSocket } from './rpc';
import { isValidPubkey } from './solana';
import { STABLES } from './stables';
import { JsonFile } from './store';
import { fetchTransactions } from './txfetch';

const LAMPORTS = 1e9;
const SNAPSHOT_ACTIVITY = 60;

interface TreasuryConfig {
  wallets: CompanyWalletConfig[];
  dividendRatio: number;
}

interface TreasuryState {
  version: 1;
  activity: TreasuryActivity[];
  scanned: Record<string, string>; // 钱包 → 已处理到的最新签名
  symbols: Record<string, string>; // 代币 mint → 符号
}

interface SigInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}

export interface TreasuryOptions {
  dataDir: string;
  rpc: RpcHttp;
  sock: RpcSocket;
  prices: SolPriceFeed;
  privateRpc: boolean;
  defaultWallets: CompanyWalletConfig[];
  defaultDividendRatio: number;
  /** 拿到不能设为公司钱包的地址（代币合约、池子）时给出原因 */
  rejectAddress: (address: string) => string | null;
  /** 已知代币的符号（当前跟踪的代币等），其余的从 Jupiter 查 */
  knownSymbol: (mint: string) => string | undefined;
  /** 公司钱包里的稳定币（快照里一起推给 App） */
  stables?: () => TreasurySnapshot['stables'];
  /** 其他已知的自己人地址（用于识别冒充它们的投毒地址） */
  extraKnown: () => string[];
  /** 质押中的 SOL（质押账户 + LST 折合），计入公司总资产；关闭"计入"时返回 0 */
  stakedSol?: () => number;
  includeStaked?: () => boolean;
  /** 日志前缀（内部质押钱包用另一个实例，日志标成 internal） */
  logTag?: string;
  warn: (label: string, e: unknown) => void;
}

/** 交易里的全部指令（外层 + 内层 CPI） */
function allInstructions(tx: any): any[] {
  return [...(tx?.transaction?.message?.instructions ?? []), ...(tx?.meta?.innerInstructions ?? []).flatMap((x: any) => x.instructions ?? [])];
}

/** 从 address 转出的每一笔 SOL（系统程序转账；同一收款人合并） */
function outgoingTransfers(address: string, ixs: any[]): { to: string; sol: number }[] {
  const by = new Map<string, number>();
  for (const ix of ixs) {
    const p = ix?.parsed;
    if (ix?.programId !== SYSTEM_PROGRAM || !p?.info || !/^transfer/.test(p.type ?? '')) continue;
    const to = p.info.destination;
    const lamports = Number(p.info.lamports ?? 0);
    if (p.info.source !== address || !to || to === address || !(lamports > 0)) continue;
    by.set(to, (by.get(to) ?? 0) + lamports);
  }
  return [...by].map(([to, l]) => ({ to, sol: l / LAMPORTS }));
}

/** 多久以内的交易算"新发生的"（用于推送提醒；更早的是历史回填，不提醒） */
const FRESH_SEC = 15 * 60;

const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';

/** 这笔交易让"质押中的本金"变了多少：质押 +x，取回 −x（不含网络费） */
function principalDelta(a: TreasuryActivity) {
  if (a.failed) return 0;
  if (a.kind === 'stake') return Math.max(0, -(a.deltaSol + a.fee));
  if (a.kind === 'unstake') return -Math.max(0, a.deltaSol + a.fee);
  return 0;
}

const byOrder = (a: TreasuryActivity, b: TreasuryActivity) => a.slot - b.slot || a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class Treasury extends EventEmitter {
  config: TreasuryConfig;
  private live = new Map<string, TreasuryWallet>();
  private activity: TreasuryActivity[] = [];
  private ids = new Set<string>();
  private scanned: Record<string, string> = {};
  private symbols: Record<string, string> = {};
  private subs = new Map<string, number>();
  private syncTimers = new Map<string, NodeJS.Timeout>();
  private syncing = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private emitTimer: NodeJS.Timeout | null = null;
  private backfilling = false;
  private gaps = false;
  private symbolQueue: string[] = [];
  private symbolBusy = false;
  status = { backfillDone: false, fetched: 0, total: 0 };
  private configFile: JsonFile<TreasuryConfig>;
  private stateFile: JsonFile<TreasuryState>;

  constructor(private o: TreasuryOptions) {
    super();
    const dir = path.join(o.dataDir, 'treasury');
    this.configFile = new JsonFile(path.join(dir, 'config.json'), 0);
    this.stateFile = new JsonFile(path.join(dir, 'state.json'), 3_000);
    const cfg = this.configFile.read();
    this.config = {
      wallets: cfg?.wallets ?? o.defaultWallets,
      dividendRatio: cfg?.dividendRatio ?? o.defaultDividendRatio,
    };
    if (!cfg) this.configFile.writeNow(this.config);
    const st = this.stateFile.read();
    if (st?.version === 1) {
      this.activity = st.activity.sort(byOrder);
      this.scanned = st.scanned ?? {};
      this.symbols = st.symbols ?? {};
      this.ids = new Set(this.activity.map((a) => a.id));
    }
    for (const w of this.config.wallets) this.live.set(w.address, this.blank(w));
  }

  private blank(w: CompanyWalletConfig): TreasuryWallet {
    return { address: w.address, label: w.label, sol: NaN, slot: 0, updatedAt: 0, lastDelta: 0, lastChangeMs: 0 };
  }

  walletConfigs() {
    return this.config.wallets;
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  async start() {
    console.log(`[${this.o.logTag ?? 'treasury'}] 公司钱包 ${this.config.wallets.map((w) => `${w.label}=${w.address}`).join(', ') || '（未设置）'}；已有流水 ${this.activity.length} 笔`);
    for (const w of this.config.wallets) this.subscribe(w.address);
    await this.refreshBalances().catch((e) => this.o.warn('读取公司钱包余额', e));
    void this.loadPriceAgo();
    void this.backfill();
    this.timers.push(setInterval(() => void this.refreshBalances().catch((e) => this.o.warn('公司钱包余额', e)), 60_000));
    this.timers.push(setInterval(() => this.config.wallets.forEach((w) => this.scheduleSync(w.address, 0)), 45_000));
    this.timers.push(setInterval(() => void this.loadPriceAgo(), 3600_000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.syncTimers.forEach(clearTimeout);
    this.persistNow();
  }

  private emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('message', { t: 'treasury', treasury: this.snapshot() } satisfies ServerMessage);
    }, 120);
  }

  private persistSoon() {
    this.stateFile.writeSoon(() => this.stateData());
  }

  private persistNow() {
    try {
      this.stateFile.writeNow(this.stateData());
    } catch {
      /* ignore */
    }
  }

  private stateData(): TreasuryState {
    return { version: 1, activity: this.activity, scanned: this.scanned, symbols: this.symbols };
  }

  // ─── 余额（实时） ─────────────────────────────────────────────

  private subscribe(address: string) {
    if (this.subs.has(address)) return;
    const key = this.o.sock.subscribe('accountSubscribe', [address, { encoding: 'base64', commitment: 'processed' }], (r: any) => {
      this.setBalance(address, Number(r?.value?.lamports ?? 0), Number(r?.context?.slot ?? 0));
      this.scheduleSync(address, 2_500); // 余额变了：稍后补拉这笔交易的详情
    });
    this.subs.set(address, key);
  }

  private unsubscribe(address: string) {
    const key = this.subs.get(address);
    if (key !== undefined) this.o.sock.unsubscribe(key);
    this.subs.delete(address);
  }

  private setBalance(address: string, lamports: number, slot: number) {
    const w = this.live.get(address);
    if (!w || slot < w.slot) return;
    const sol = lamports / LAMPORTS;
    if (sol !== w.sol) {
      if (Number.isFinite(w.sol)) {
        w.lastDelta = sol - w.sol;
        w.lastChangeMs = Date.now();
      }
      w.sol = sol;
    }
    w.slot = slot;
    w.updatedAt = Date.now();
    this.emitSoon();
    if ([...this.live.values()].every((x) => Number.isFinite(x.sol))) this.emit('balance', this.totalSol);
  }

  async refreshBalances() {
    const addrs = this.config.wallets.map((w) => w.address);
    if (!addrs.length) return;
    const res = await this.o.rpc.call<any>('getMultipleAccounts', [addrs, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
    addrs.forEach((a, i) => this.setBalance(a, Number(res.value[i]?.lamports ?? 0), res.context.slot));
  }

  // ─── 资金流水（交易历史） ──────────────────────────────────────

  private scheduleSync(address: string, ms: number) {
    clearTimeout(this.syncTimers.get(address));
    this.syncTimers.set(
      address,
      setTimeout(() => {
        this.syncTimers.delete(address);
        void this.syncWallet(address).catch((e) => this.o.warn('同步公司钱包流水', e));
      }, ms),
    );
  }

  /** 从新到旧翻页拉签名，直到上次处理到的位置 */
  private async collect(address: string, maxPages: number) {
    const infos: SigInfo[] = [];
    let before: string | undefined;
    let newest: string | undefined;
    const known = this.scanned[address];
    for (let page = 0; page < maxPages; page++) {
      const res = await this.o.rpc.call<SigInfo[]>('getSignaturesForAddress', [address, { limit: 1000, before, commitment: 'confirmed' }], { indexed: true });
      if (!res.length) break;
      newest ??= res[0].signature;
      const stop = res.findIndex((s) => s.signature === known);
      infos.push(...(stop >= 0 ? res.slice(0, stop) : res));
      if (stop >= 0 || res.length < 1000) break;
      before = res[res.length - 1].signature;
    }
    return { infos, newest };
  }

  private async syncWallet(address: string) {
    if (this.backfilling || this.syncing.has(address) || !this.live.has(address)) return;
    this.syncing.add(address);
    try {
      const { infos, newest } = await this.collect(address, 2);
      const todo = infos.filter((s) => !this.ids.has(`${s.signature}:${address}`));
      const left = todo.length ? await this.ingest(address, todo, false) : [];
      if (!left.length && newest && !this.gaps) this.scanned[address] = newest;
      if (todo.length) this.persistSoon();
    } finally {
      this.syncing.delete(address);
    }
  }

  async backfill() {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      const jobs: { address: string; infos: SigInfo[]; newest?: string }[] = [];
      for (const w of this.config.wallets) {
        const { infos, newest } = await this.collect(w.address, 50);
        jobs.push({ address: w.address, infos: infos.filter((s) => !this.ids.has(`${s.signature}:${w.address}`)), newest });
      }
      this.status = { backfillDone: false, fetched: 0, total: jobs.reduce((s, j) => s + j.infos.length, 0) };
      console.log(`[${this.o.logTag ?? 'treasury'}] 回填资金流水：需要解析 ${this.status.total} 笔交易`);
      this.emitSoon();
      let base = 0;
      let failed = 0;
      for (const j of jobs) {
        const left = await this.ingest(j.address, j.infos, true, base);
        base += j.infos.length;
        failed += left.length;
        if (!left.length && j.newest) this.scanned[j.address] = j.newest;
      }
      this.gaps = failed > 0;
      this.status = { backfillDone: true, fetched: this.status.total, total: this.status.total };
      this.persistNow();
      console.log(`[${this.o.logTag ?? 'treasury'}] 回填完成：共 ${this.activity.length} 笔流水${failed ? `（${failed} 笔待重试）` : ''}`);
      this.emitSoon();
      if (failed) setTimeout(() => void this.backfill(), 60_000);
      else void this.upgradeOuts().then(() => this.reclassifyStables());
    } catch (e) {
      this.o.warn('回填资金流水', e);
      setTimeout(() => void this.backfill(), 60_000);
    } finally {
      this.backfilling = false;
    }
  }

  /** 拉取并解析交易；每 40 笔入库并保存一次（中途重启不丢进度，App 里逐步显示）。返回没拉到的签名 */
  private async ingest(address: string, infos: SigInfo[], progress: boolean, base = 0): Promise<string[]> {
    const bySig = new Map(infos.map((s) => [s.signature, s]));
    let added: TreasuryActivity[] = [];
    const flush = async () => {
      if (!added.length) return;
      const batch = added;
      added = [];
      await this.fillSolUsd(batch);
      const fresh: TreasuryActivity[] = [];
      const added2: TreasuryActivity[] = [];
      const nowSec = Date.now() / 1000;
      for (const a of batch) {
        if (this.ids.has(a.id)) continue;
        this.ids.add(a.id);
        this.activity.push(a);
        added2.push(a);
        if (nowSec - a.ts < FRESH_SEC) fresh.push(a);
        for (const t of a.tokens) if (!this.symbols[t.mint] && !this.o.knownSymbol(t.mint)) this.queueSymbol(t.mint);
      }
      this.activity.sort(byOrder);
      this.persistSoon();
      this.emitSoon();
      if (added2.length) this.emit('ingested', added2);
      if (fresh.length) {
        const poison = this.poisonTargets(this.currentActivity());
        this.emit(
          'activity',
          fresh.map((a) => ({ ...a, poisonOf: a.counterparty ? poison.get(a.counterparty) : undefined, tokens: a.tokens.map((t) => ({ ...t, symbol: this.symbolOf(t.mint) })) })),
        );
      }
    };
    const left = await fetchTransactions(
      this.o.rpc,
      infos.map((s) => s.signature).reverse(),
      {
        privateRpc: this.o.privateRpc,
        warn: this.o.warn,
        onTx: async (sig, tx) => {
          const a = this.classify(address, bySig.get(sig)!, tx);
          if (a) added.push(a);
          if (added.length >= 40) await flush();
        },
        onProgress: progress
          ? (done) => {
              this.status.fetched = base + done;
              if (done % 20 === 0) {
                console.log(`[${this.o.logTag ?? 'treasury'}] 回填进度 ${this.status.fetched}/${this.status.total}`);
                this.emitSoon();
              }
            }
          : undefined,
      },
    );
    await flush();
    return left;
  }

  /** 一笔交易对这个钱包意味着什么：SOL 变化、代币变化、转入转出对象 */
  private classify(address: string, info: SigInfo, tx: any): TreasuryActivity | null {
    const keys: string[] = (tx?.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k.pubkey));
    const i = keys.indexOf(address);
    if (i < 0 || !tx.meta) return null;
    const pre = Number(tx.meta.preBalances?.[i] ?? 0);
    const post = Number(tx.meta.postBalances?.[i] ?? 0);
    const fee = keys[0] === address ? Number(tx.meta.fee ?? 0) / LAMPORTS : 0;
    const deltaSol = (post - pre) / LAMPORTS;
    const failed = !!tx.meta.err;
    const ixs: any[] = failed ? [] : allInstructions(tx);

    const tokenMap = new Map<string, number>();
    const amt = (b: any) => Number(b.uiTokenAmount?.amount ?? 0) / 10 ** Number(b.uiTokenAmount?.decimals ?? 0);
    for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === address) tokenMap.set(b.mint, (tokenMap.get(b.mint) ?? 0) - amt(b));
    for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === address) tokenMap.set(b.mint, (tokenMap.get(b.mint) ?? 0) + amt(b));
    const tokens = [...tokenMap]
      .filter(([mint, d]) => mint !== WSOL_MINT && Math.abs(d) > 0)
      .map(([mint, delta]) => ({ mint, delta }));

    // 质押：这个钱包出钱新建了一个质押账户；取回：从质押账户提取到这个钱包
    let stakeTarget: string | undefined;
    const fundsStake = ixs.some((ix) => ix?.program === 'system' && /^createAccount/.test(ix.parsed?.type ?? '') && ix.parsed.info?.source === address && ix.parsed.info?.owner === STAKE_PROGRAM);
    if (fundsStake) stakeTarget = ixs.find((ix) => ix?.program === 'stake' && ix.parsed?.type === 'delegate')?.parsed?.info?.voteAccount;
    const withdrawIx = ixs.find((ix) => ix?.program === 'stake' && ix.parsed?.type === 'withdraw' && ix.parsed.info?.destination === address);
    const lstIn = tokens.some((t) => LST_MINTS[t.mint] && t.delta > 0);
    const lstOut = tokens.some((t) => LST_MINTS[t.mint] && t.delta < 0);

    // 稳定币（官方 USDT / USDC）单独转入转出：SOL 只少了手续费（或押金），不是买卖
    const stableTok = tokens.filter((t) => STABLES[t.mint]);
    const otherTok = tokens.filter((t) => !STABLES[t.mint]);
    const solMoved = Math.abs(deltaSol + fee) > 0.0025; // 超过一个代币账户押金，说明 SOL 也参与了（例如用 SOL 买 USDT）
    let stable: { symbol: 'USDT' | 'USDC'; amount: number } | undefined;

    let kind: ActivityKind;
    if (failed) kind = 'fee';
    else if (stableTok.length === 1 && !otherTok.length && !solMoved) {
      const t = stableTok[0];
      kind = t.delta > 0 ? 'stableIn' : 'stableOut';
      stable = { symbol: STABLES[t.mint].symbol, amount: Math.abs(t.delta) };
    }
    else if (fundsStake && deltaSol < 0) kind = 'stake';
    else if (withdrawIx && deltaSol > 0) kind = 'unstake';
    else if (lstIn && deltaSol < 0) kind = 'stake';
    else if (lstOut && deltaSol > 0) kind = 'unstake';
    else if (tokens.length) {
      const gotTokens = tokens.some((t) => t.delta > 0);
      const gaveTokens = tokens.some((t) => t.delta < 0);
      kind = deltaSol < 0 && gotTokens ? 'buy' : deltaSol > 0 && gaveTokens ? 'sell' : 'other';
    } else if (deltaSol > 0) kind = 'in';
    else if (deltaSol < 0) kind = -deltaSol <= fee + 1e-9 ? 'fee' : 'out';
    else kind = 'other';

    // 转账对方：取这笔交易里和这个钱包有关、金额最大的 SOL 转账（0 SOL 的转账也记下来，用于识别地址投毒）
    let counterparty: string | undefined;
    let transferLamports = -1;
    if (stable) {
      // 稳定币转账的对方：另一边余额反向变化的代币账户所有人
      const mint = stableTok[0].mint;
      const others = new Map<string, number>();
      for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === mint && b.owner !== address) others.set(b.owner, (others.get(b.owner) ?? 0) - amt(b));
      for (const b of tx.meta.postTokenBalances ?? []) if (b.mint === mint && b.owner !== address) others.set(b.owner, (others.get(b.owner) ?? 0) + amt(b));
      const want = stableTok[0].delta > 0 ? -1 : 1;
      let best = 0;
      for (const [o, d] of others) if (Math.sign(d) === want && Math.abs(d) > best) (best = Math.abs(d)), (counterparty = o);
    }
    if (!failed && !tokens.length) {
      for (const ix of ixs) {
        const p = ix?.parsed;
        if (ix?.programId !== SYSTEM_PROGRAM || !p?.info || !/^transfer/.test(p.type ?? '')) continue;
        const lamports = Number(p.info.lamports ?? 0);
        const other = p.info.destination === address ? p.info.source : p.info.source === address ? p.info.destination : null;
        if (other && other !== address && lamports > transferLamports) {
          transferLamports = lamports;
          counterparty = other;
        }
      }
    }
    if (kind === 'stake' && stakeTarget) counterparty = stakeTarget; // 委托给哪个验证者
    if (kind === 'unstake' && withdrawIx) counterparty = withdrawIx.parsed.info.stakeAccount;
    const dust = counterparty !== undefined && transferLamports >= 0 && transferLamports < 1_000_000;

    // 关闭代币账户：账户里押的租金（每个约 0.002 SOL）退回到这个钱包
    let note: string | undefined;
    if (!failed && !counterparty && deltaSol > 0) {
      const closes = ixs.filter((ix: any) => ix?.parsed?.type === 'closeAccount' && ix.parsed.info?.destination === address).length;
      if (closes) {
        note = `关闭 ${closes} 个代币账户，收回押金`;
        // SOL 只多了押金那么点：不是卖出，只是清掉了账户里剩下的代币
        if (kind === 'sell' && deltaSol + fee <= closes * 0.00205) kind = 'other';
      }
    }

    return {
      id: `${info.signature}:${address}`,
      sig: info.signature,
      slot: Number(tx.slot ?? info.slot),
      ts: Number(tx.blockTime ?? info.blockTime ?? 0),
      wallet: address,
      deltaSol,
      fee,
      kind,
      counterparty,
      dust: dust || undefined,
      note,
      tokens,
      outs: outgoingTransfers(address, ixs),
      failed: failed || undefined,
      stable,
      balanceAfter: post / LAMPORTS,
      solUsd: 0,
    };
  }

  /** 早期版本没有记录"转出明细"的流水：重新拉这些交易补上（只需要转出类，几十笔） */
  private upgrading = false;
  private async upgradeOuts() {
    if (this.upgrading) return;
    const todo = this.activity.filter((a) => a.outs === undefined && !a.failed && (a.kind === 'out' || a.kind === 'other'));
    if (!todo.length) return;
    this.upgrading = true;
    try {
      const bySig = new Map<string, TreasuryActivity[]>();
      for (const a of todo) bySig.set(a.sig, [...(bySig.get(a.sig) ?? []), a]);
      console.log(`[${this.o.logTag ?? 'treasury'}] 补充转出明细：${bySig.size} 笔交易`);
      const left = await fetchTransactions(this.o.rpc, [...bySig.keys()], {
        privateRpc: this.o.privateRpc,
        warn: this.o.warn,
        onTx: (sig, tx) => {
          const ixs = tx?.meta?.err ? [] : allInstructions(tx);
          for (const a of bySig.get(sig) ?? []) a.outs = outgoingTransfers(a.wallet, ixs);
        },
      });
      console.log(`[${this.o.logTag ?? 'treasury'}] 转出明细补充完成${left.length ? `（${left.length} 笔下次再试）` : ''}`);
      this.persistSoon();
      this.emit('ingested', []);
    } catch (e) {
      this.o.warn('补充转出明细', e);
    } finally {
      this.upgrading = false;
    }
  }

  /** 稳定币识别上线之前入库的 USDT / USDC 转账（当时记成"其他"）：重新拉交易，按新规则分类（只做一次，几笔） */
  private reclassifying = false;
  private async reclassifyStables() {
    if (this.reclassifying) return;
    const todo = this.activity.filter((a) => !a.failed && !a.stable && a.kind === 'other' && a.tokens.some((t) => STABLES[t.mint]));
    if (!todo.length) return;
    this.reclassifying = true;
    try {
      const bySig = new Map<string, TreasuryActivity[]>();
      for (const a of todo) bySig.set(a.sig, [...(bySig.get(a.sig) ?? []), a]);
      console.log(`[${this.o.logTag ?? 'treasury'}] 重新识别稳定币转账：${bySig.size} 笔交易`);
      let changed = 0;
      await fetchTransactions(this.o.rpc, [...bySig.keys()], {
        privateRpc: this.o.privateRpc,
        warn: this.o.warn,
        onTx: (sig, tx) => {
          for (const a of bySig.get(sig) ?? []) {
            const fresh = this.classify(a.wallet, { signature: a.sig, slot: a.slot, blockTime: a.ts } as SigInfo, tx);
            if (!fresh?.stable) continue;
            a.kind = fresh.kind;
            a.stable = fresh.stable;
            a.counterparty = fresh.counterparty;
            changed++;
          }
        },
      });
      if (changed) {
        console.log(`[${this.o.logTag ?? 'treasury'}] 稳定币转账识别完成：${changed} 笔`);
        this.persistSoon();
        this.emitSoon();
      }
    } catch (e) {
      this.o.warn('重新识别稳定币转账', e);
    } finally {
      this.reclassifying = false;
    }
  }

  private async fillSolUsd(list: TreasuryActivity[]) {
    const ts = list.map((a) => a.ts).filter((t) => t > 0);
    if (!ts.length) return;
    try {
      await this.o.prices.loadHistory(Math.min(...ts) - 120, Math.max(...ts) + 120);
    } catch (e) {
      this.o.warn('SOL 历史价', e);
    }
    for (const a of list) a.solUsd = this.o.prices.usdAt(a.ts) || this.o.prices.price.usd;
  }

  private async loadPriceAgo() {
    const t = Math.floor(Date.now() / 1000) - 86400;
    try {
      await this.o.prices.loadHistory(t - 300, t + 300);
      this.emitSoon();
    } catch {
      /* 下次再试 */
    }
  }

  // ─── 代币符号（流水里显示"买入 xxx"用） ─────────────────────────

  private queueSymbol(mint: string) {
    if (this.symbolQueue.includes(mint)) return;
    this.symbolQueue.push(mint);
    void this.drainSymbols();
  }

  private async drainSymbols() {
    if (this.symbolBusy) return;
    this.symbolBusy = true;
    try {
      while (this.symbolQueue.length) {
        const mint = this.symbolQueue.shift()!;
        try {
          const r = await getJson<any[]>(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, 8_000);
          const hit = r.find((x) => x.id === mint);
          this.symbols[mint] = (hit?.symbol || '').trim() || `${mint.slice(0, 4)}…`;
        } catch {
          this.symbols[mint] = `${mint.slice(0, 4)}…`;
        }
        await sleep(1_200);
      }
      this.persistSoon();
      this.emitSoon();
    } finally {
      this.symbolBusy = false;
    }
  }

  symbolOf(mint: string) {
    return this.o.knownSymbol(mint) ?? this.symbols[mint];
  }

  // ─── 对外数据 ────────────────────────────────────────────────

  /** 当前公司钱包的全部流水（旧 → 新） */
  allActivity(): readonly TreasuryActivity[] {
    return this.currentActivity();
  }

  isCompanyWallet(address: string) {
    return this.config.wallets.some((w) => w.address === address);
  }

  private currentActivity() {
    const set = new Set(this.config.wallets.map((w) => w.address));
    return this.activity.filter((a) => set.has(a.wallet));
  }

  /** 公司总资产（SOL）= 钱包里的 SOL + 质押中的 SOL */
  get totalSol() {
    return this.walletSol + this.stakedSol;
  }

  get walletSol() {
    let s = 0;
    for (const w of this.live.values()) if (Number.isFinite(w.sol)) s += w.sol;
    return s;
  }

  get stakedSol() {
    return this.o.includeStaked?.() ? (this.o.stakedSol?.() ?? 0) : 0;
  }

  /** 流水里记录的质押本金（质押出去的 − 取回的） */
  stakePrincipal(): number {
    let p = 0;
    for (const a of this.currentActivity()) p = Math.max(0, p + principalDelta(a));
    return p;
  }

  /** 质押中的 SOL 变了：重新推送快照 */
  touch() {
    this.emitSoon();
  }

  /** 所有公司钱包 SOL 合计的历史曲线（每笔交易一个点，终点是实时余额） */
  history(): TreasuryHistoryPoint[] {
    const list = this.currentActivity();
    const solNow = this.o.prices.price.usd;
    const balance = new Map<string, number>();
    // 每个钱包在第一笔已知交易之前的余额
    for (const a of list) if (!balance.has(a.wallet)) balance.set(a.wallet, Math.max(0, a.balanceAfter - a.deltaSol));
    const withStake = !!this.o.includeStaked?.();
    let principal = 0;
    const sum = () => [...balance.values()].reduce((s, v) => s + v, 0) + principal;
    const out: TreasuryHistoryPoint[] = [];
    if (list.length) out.push({ t: list[0].ts - 1, sol: sum(), solUsd: list[0].solUsd || solNow });
    for (const a of list) {
      balance.set(a.wallet, a.balanceAfter);
      if (withStake) principal = Math.max(0, principal + principalDelta(a));
      const p: TreasuryHistoryPoint = { t: a.ts, sol: sum(), solUsd: a.solUsd || solNow, d: a.deltaSol, k: a.failed ? 'fee' : a.kind, n: 1 };
      const last = out[out.length - 1];
      if (last && last.n && p.t <= last.t) {
        // 同一秒的多笔交易合并成一个点：变化相加，类型取金额最大的那笔
        const bigger = Math.abs(a.deltaSol) > Math.abs(last.d ?? 0) ? p.k : last.k;
        out[out.length - 1] = { ...p, t: last.t, d: (last.d ?? 0) + a.deltaSol, k: bigger, n: (last.n ?? 1) + 1 };
      } else out.push(p);
    }
    const now = Math.floor(Date.now() / 1000);
    const lastT = out.length ? out[out.length - 1].t : 0;
    out.push({ t: Math.max(now, lastT + 1), sol: this.totalSol, solUsd: solNow });
    return out;
  }

  private totalAt(tSec: number): number | null {
    const list = this.currentActivity();
    if (!this.status.backfillDone && !list.length) return null;
    const balance = new Map<string, number>();
    for (const a of list) if (!balance.has(a.wallet)) balance.set(a.wallet, Math.max(0, a.balanceAfter - a.deltaSol));
    let principal = 0;
    const withStake = !!this.o.includeStaked?.();
    for (const a of list) {
      if (a.ts > tSec) break;
      balance.set(a.wallet, a.balanceAfter);
      if (withStake) principal = Math.max(0, principal + principalDelta(a));
    }
    // 没有任何流水的钱包：余额从未变过
    for (const w of this.live.values()) if (!balance.has(w.address) && Number.isFinite(w.sol)) balance.set(w.address, w.sol);
    return [...balance.values()].reduce((s, v) => s + v, 0) + principal;
  }

  /**
   * 地址投毒识别：骗子生成开头结尾都和你常用地址相同的地址，转来 0 或极小金额的 SOL，
   * 让它出现在交易记录里，等你从记录里复制错地址。已知地址 = 公司钱包 + 真正有金额往来的对方。
   */
  /** 全部疑似地址投毒的转账（成就"火眼金睛"用） */
  poisonEvents(): { ts: number; from: string; imitates: string }[] {
    const list = this.currentActivity();
    const poison = this.poisonTargets(list);
    return list.flatMap((a) => (a.counterparty && poison.has(a.counterparty) ? [{ ts: a.ts, from: a.counterparty, imitates: poison.get(a.counterparty)! }] : []));
  }

  private poisonTargets(list: TreasuryActivity[]) {
    const known = new Set<string>([...this.config.wallets.map((w) => w.address), ...this.o.extraKnown()]);
    for (const a of list) if (a.counterparty && !a.dust) known.add(a.counterparty);
    const same = (x: string, y: string, fromEnd: boolean) => {
      let n = 0;
      while (n < x.length && n < y.length && (fromEnd ? x[x.length - 1 - n] === y[y.length - 1 - n] : x[n] === y[n])) n++;
      return n;
    };
    const out = new Map<string, string>();
    for (const a of list) {
      const cp = a.counterparty;
      if (!a.dust || !cp || known.has(cp) || out.has(cp)) continue;
      for (const k of known) {
        const p = same(cp, k, false);
        const s = same(cp, k, true);
        if (p >= 3 && s >= 3 && p + s >= 6) {
          out.set(cp, k);
          break;
        }
      }
    }
    return out;
  }

  snapshot(): TreasurySnapshot {
    const list = this.currentActivity();
    const poison = this.poisonTargets(list);
    const t24 = Math.floor(Date.now() / 1000) - 86400;
    return {
      wallets: this.config.wallets.map((w) => this.live.get(w.address) ?? this.blank(w)),
      totalSol: this.totalSol,
      stakedSol: this.stakedSol,
      dividendRatio: this.config.dividendRatio,
      activity: list
        .slice(-SNAPSHOT_ACTIVITY)
        .reverse()
        .map((a) => ({
          ...a,
          poisonOf: a.counterparty ? poison.get(a.counterparty) : undefined,
          tokens: a.tokens.map((t) => ({ ...t, symbol: this.symbolOf(t.mint) })),
        })),
      activityCount: list.length,
      totalSol24hAgo: this.status.backfillDone ? this.totalAt(t24) : null,
      solUsd24hAgo: this.o.prices.usdAt(t24) || null,
      status: this.status,
      stables: this.o.stables?.(),
    };
  }

  // ─── 管理 ───────────────────────────────────────────────────

  /** 校验地址；填的是代币账户时换成它所属的钱包 */
  async normalize(raw: unknown): Promise<{ address: string; note?: string }> {
    const address = String(raw ?? '').trim();
    if (!isValidPubkey(address)) throw new Error(`无效地址：${address || '(空)'}`);
    const reason = this.o.rejectAddress(address);
    if (reason) throw new Error(reason);
    const acc = await this.o.rpc.call<any>('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const owner = acc?.value?.owner;
    if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) {
      const parsed = acc.value.data?.parsed;
      if (parsed?.type === 'account' && parsed.info?.owner) return { address: parsed.info.owner, note: '你填的是代币账户，已换成它所属的钱包地址' };
      if (parsed?.type === 'mint') throw new Error('这是代币合约地址，不是钱包地址');
    }
    return { address };
  }

  async previewWallet(raw: unknown): Promise<WalletPreview> {
    const { address, note } = await this.normalize(raw);
    const [acc, sigs] = await Promise.all([
      this.o.rpc.call<any>('getAccountInfo', [address, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]),
      this.o.rpc.call<SigInfo[]>('getSignaturesForAddress', [address, { limit: 1000, commitment: 'confirmed' }], { indexed: true }),
    ]);
    return {
      address,
      note,
      sol: Number(acc?.value?.lamports ?? 0) / LAMPORTS,
      txCount: sigs.length,
      firstTs: sigs.length ? sigs[sigs.length - 1].blockTime : null,
      lastTs: sigs.length ? sigs[0].blockTime : null,
      isSystemAccount: !acc?.value || acc.value.owner === SYSTEM_PROGRAM,
    };
  }

  async updateConfig(input: { companyWallets?: CompanyWalletConfig[]; dividendRatio?: number }) {
    if (input.companyWallets) {
      if (input.companyWallets.length > 20) throw new Error('公司钱包最多 20 个');
      const list: CompanyWalletConfig[] = [];
      const seen = new Set<string>();
      for (const w of input.companyWallets) {
        const { address } = await this.normalize(w.address);
        if (seen.has(address)) continue;
        seen.add(address);
        list.push({ address, label: String(w.label ?? '').trim().slice(0, 24) || `公司钱包 ${list.length + 1}` });
      }
      const before = new Set(this.config.wallets.map((w) => w.address));
      const after = new Set(list.map((w) => w.address));
      for (const a of before) if (!after.has(a)) {
        this.unsubscribe(a);
        this.live.delete(a);
      }
      for (const w of list) {
        const cur = this.live.get(w.address);
        if (cur) cur.label = w.label;
        else {
          this.live.set(w.address, this.blank(w));
          this.subscribe(w.address);
        }
      }
      this.config.wallets = list;
      if ([...after].some((a) => !before.has(a))) {
        void this.refreshBalances().catch(() => {});
        void this.backfill();
      }
    }
    if (input.dividendRatio !== undefined) {
      const r = Number(input.dividendRatio);
      if (!(r >= 0 && r <= 1)) throw new Error('分红比例需在 0–100% 之间');
      this.config.dividendRatio = r;
    }
    this.configFile.writeNow(this.config);
    this.emitSoon();
    return this.config;
  }
}
