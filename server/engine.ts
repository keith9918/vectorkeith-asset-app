// ───────────────────────────────────────────────────────────────
//  VectorKeith 链上引擎
//  · logsSubscribe(内盘 bonding curve / PumpSwap 池子) → 每一笔成交（processed，毫秒级）
//  · accountSubscribe(bonding curve) → 内盘储备 / 现价 / 毕业状态
//  · 毕业后：成交事件实时更新池子储备，并定时读取池子金库校准
//  · accountSubscribe(公司钱包 ATA)  → 公司持仓实时变动
//  · getSignaturesForAddress + getTransaction → 从链上完整回填历史成交（内盘 + 池子）
//  · 定时对账（补漏 + 剔除被回滚的 processed 成交）、getProgramAccounts 全量持仓排名
// ───────────────────────────────────────────────────────────────
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { compareTrades } from '../shared/candles';
import {
  DEFAULT_COMPANY_WALLETS_BY_MINT,
  DEFAULT_CREATOR_FEE_BPS,
  DEFAULT_DIVIDEND_RATIO,
  DEFAULT_PROTOCOL_FEE_BPS,
  INITIAL_REAL_TOKEN_RESERVES,
  RENT_EXEMPT_ZERO_BYTES,
  TOKEN_2022_PROGRAM,
  WATCH_TOP_HOLDERS,
  WSOL_MINT,
  type CompanyWalletConfig,
} from '../shared/constants';
import { marketFromCurve, marketFromPool, prePriceFromPost, quoteSell } from '../shared/curve';
import type {
  AppConfig,
  CompanyHistoryPoint,
  CompanyWallet,
  CreatorVault,
  CurveState,
  EngineStatus,
  Holder,
  MarketInfo,
  MarketStats,
  ServerMessage,
  Snapshot,
  TokenInfo,
  Trade,
  WindowStats,
} from '../shared/types';
import { getJson, sleep } from './http';
import { loadTokenInfo } from './meta';
import { SolPriceFeed } from './prices';
import { RpcHttp, RpcSocket, isRateLimited, type RpcEndpoint } from './rpc';
import {
  associatedTokenAddress,
  bondingCurveAddress,
  buildBurnCheckedTx,
  bs58encode,
  creatorVaultAddress,
  decodeBondingCurve,
  decodePumpSwapPool,
  decodeTokenAccount,
  isValidPubkey,
  parseTradeEvents,
  pumpSwapPoolAddress,
  type PumpSwapPool,
  type TradeEvent,
} from './solana';
import { JsonFile } from './store';

interface SigInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
  transactionIndex?: number;
}

interface TokenAccountState {
  owner: string;
  amount: number;
  slot: number;
}

interface PersistedState {
  version: 1;
  mint: string;
  trades: Trade[];
  /** 旧版：只扫描内盘地址时的最新签名 */
  scannedUntil?: string | null;
  /** 每个被扫描地址（内盘 / 池子）已处理到的最新签名 */
  scanned?: Record<string, string>;
  createdAt: number;
}

interface PersistedConfig {
  companyWallets: CompanyWalletConfig[];
  dividendRatio: number;
  ignoredWallets: string[];
}

export interface EngineOptions {
  /** 数据根目录；每个代币的数据存放在 <dataDir>/<mint>/ */
  dataDir: string;
  mint: string;
  http: RpcEndpoint[];
  ws: string[];
  adminEnabled: boolean;
}

/** 旧版把数据直接放在 data/ 下；现在按代币分目录。启动时把旧文件挪进它所属代币的目录，切回那个币时数据还在 */
function migrateLegacyData(root: string) {
  const legacy = path.join(root, 'state.json');
  if (!fs.existsSync(legacy)) return;
  let mint = '';
  try {
    mint = JSON.parse(fs.readFileSync(legacy, 'utf8')).mint ?? '';
  } catch {
    return;
  }
  if (!isValidPubkey(mint)) return;
  const dest = path.join(root, mint);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(root)) {
    if (!/^(state|config|token)\.json$|^token-image\./.test(f)) continue;
    const to = path.join(dest, f);
    if (!fs.existsSync(to)) fs.renameSync(path.join(root, f), to);
  }
  console.log(`[engine] 已把旧数据移到 ${dest}`);
}

const MAX_TRADES = 200_000;
const SNAPSHOT_TRADES = 300;
const MAX_HOLDERS_SENT = 100;
const WINDOWS: [WindowStats['window'], number][] = [
  ['5m', 300],
  ['1h', 3600],
  ['6h', 21600],
  ['24h', 86400],
];

export class Engine extends EventEmitter {
  readonly mint: string;
  readonly curveAddress: string;
  /** 毕业后 PumpSwap 标准池子地址（未毕业时这个账户还不存在） */
  readonly poolAddress: string;
  readonly dataDir: string;
  readonly rpc: RpcHttp;
  readonly sock: RpcSocket;
  readonly prices = new SolPriceFeed();

  decimals = 6;
  tokenProgram = TOKEN_2022_PROGRAM;
  token: TokenInfo | null = null;
  imageFile: string | null = null;
  curve: CurveState | null = null;
  amm: MarketInfo | null = null;
  trades: Trade[] = [];
  holders: Holder[] = [];
  holderCount = 0;
  company: CompanyWallet[] = [];
  creatorVault: CreatorVault | null = null;
  fees = { protocolBps: DEFAULT_PROTOCOL_FEE_BPS, creatorBps: DEFAULT_CREATOR_FEE_BPS };
  private feesSlot = 0;
  /** 代币实际总量（Mayhem 模式创建的币不是 10 亿）：启动时读 mint，之后每次持仓刷新用全部代币账户余额之和校准 */
  supply = 1e9;
  config: PersistedConfig;
  stats: MarketStats = emptyStats();
  status: EngineStatus;

  private tradeIds = new Set<string>();
  private tradeSigs = new Set<string>();
  private ignoredSigs = new Set<string>();
  private tokenAccounts = new Map<string, TokenAccountState>();
  private companySubs = new Map<string, number>();
  private slotTimes = new Map<number, number>();
  private scanned: Record<string, string> = {};
  private pool: PumpSwapPool | null = null;
  private poolSubscribed = false;
  private createdAt = 0;
  private holdersTimer: NodeJS.Timeout | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stateFile: JsonFile<PersistedState>;
  private configFile: JsonFile<PersistedConfig>;
  private tokenFile: JsonFile<TokenInfo>;
  private lastStatusBroadcast = 0;

  constructor(private opts: EngineOptions) {
    super();
    if (!isValidPubkey(opts.mint)) throw new Error(`TOKEN_MINT 无效：${opts.mint}`);
    this.mint = opts.mint;
    this.curveAddress = bondingCurveAddress(opts.mint);
    this.poolAddress = pumpSwapPoolAddress(opts.mint);
    migrateLegacyData(opts.dataDir);
    this.dataDir = path.join(opts.dataDir, opts.mint);
    this.rpc = new RpcHttp(opts.http);
    this.sock = new RpcSocket(opts.ws);
    this.stateFile = new JsonFile(path.join(this.dataDir, 'state.json'), 3_000);
    this.configFile = new JsonFile(path.join(this.dataDir, 'config.json'), 0);
    this.tokenFile = new JsonFile(path.join(this.dataDir, 'token.json'), 0);
    const cfg = this.configFile.read();
    this.config = {
      companyWallets: cfg?.companyWallets ?? DEFAULT_COMPANY_WALLETS_BY_MINT[opts.mint] ?? [],
      dividendRatio: cfg?.dividendRatio ?? DEFAULT_DIVIDEND_RATIO,
      ignoredWallets: cfg?.ignoredWallets ?? [],
    };
    this.status = {
      startedAt: Date.now(),
      rpcHttp: opts.http[0]?.name ?? '',
      rpcWs: opts.ws[0] ?? '',
      wsConnected: false,
      slot: 0,
      slotMs: 0,
      backfillDone: false,
      backfillTrades: 0,
      backfillTotal: 0,
      backfillFetched: 0,
      lastTradeMs: 0,
      lastHoldersMs: 0,
      errors: [],
    };
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  async start() {
    this.loadPersisted();
    this.token = this.tokenFile.read();
    this.prices.onUpdate = (p) => {
      this.emitMsg({ t: 'sol', solPrice: p });
    };
    await this.prices.start();

    console.log(`[engine] 跟踪代币 ${this.mint}（内盘 ${this.curveAddress} · 池子 ${this.poolAddress}）`);
    await this.retry('读取代币信息', () => this.detectTokenProgram());
    await this.retry('读取 bonding curve', () => this.fetchCurve());
    if (this.curve?.complete) await this.retry('读取 PumpSwap 池子', () => this.refreshPool());

    // 先建立实时订阅，再回填历史 —— 回填期间的新成交不会漏（按 id 去重）
    this.startSocket();
    await this.retry('持仓排名', () => this.refreshHolders());
    void this.refreshMeta();
    void this.refreshBalances();

    // 历史回填在后台进行（公共节点限速，成交多时首次同步需要十几分钟，进度会推送给 App）
    void this.retry('回填历史成交', () => this.backfill(), 5);

    this.timers.push(setInterval(() => void this.reconcile().catch((e) => this.warn('对账', e)), 20_000));
    this.timers.push(setInterval(() => void this.refreshHolders().catch((e) => this.warn('持仓排名', e)), 30_000));
    this.timers.push(setInterval(() => void this.refreshBalances().catch((e) => this.warn('余额', e)), 30_000));
    this.timers.push(
      setInterval(() => {
        this.recomputeStats();
        this.emitMsg({ t: 'stats', stats: this.stats });
      }, 15_000),
    );
    this.timers.push(setInterval(() => void this.refreshCurve().catch((e) => this.warn('内盘校验', e)), 60_000));
    // 毕业后：成交事件已实时更新池子储备，这里定时读取金库余额校准（手续费结算、添加/移除流动性不产生成交事件）
    this.timers.push(setInterval(() => this.curve?.complete && void this.refreshPool().catch((e) => this.warn('池子校验', e)), 15_000));
    this.timers.push(setInterval(() => void this.refreshMeta(), 6 * 3600_000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.sock.stop();
    this.prices.stop();
    this.persistNow();
  }

  private async retry(label: string, fn: () => Promise<void>, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try {
        await fn();
        return;
      } catch (e) {
        this.warn(`${label}（第 ${i + 1} 次）`, e);
        await sleep(1500 * (i + 1));
      }
    }
  }

  private warn(label: string, e: unknown) {
    const msg = `${new Date().toISOString().slice(11, 19)} ${label}: ${(e as Error)?.message ?? e}`;
    console.warn('[engine]', msg);
    this.status.errors = [msg, ...this.status.errors].slice(0, 8);
  }

  private emitMsg(msg: ServerMessage) {
    this.emit('message', msg);
  }

  // ─── 持久化 ─────────────────────────────────────────────────

  private loadPersisted() {
    const s = this.stateFile.read();
    if (s && s.mint === this.mint && Array.isArray(s.trades)) {
      // 按 id 去重（旧版本在"实时推送"与"对账补漏"同时拿到同一笔成交时可能重复入库）
      const unique = new Map<string, Trade>();
      for (const t of s.trades) if (t.status === 'confirmed') unique.set(t.id, t);
      this.trades = [...unique.values()].sort(compareTrades);
      this.scanned = s.scanned ?? (s.scannedUntil ? { [this.curveAddress]: s.scannedUntil } : {});
      this.createdAt = s.createdAt ?? 0;
      this.reindex();
      const dup = s.trades.filter((t) => t.status === 'confirmed').length - this.trades.length;
      console.log(`[engine] 已加载本地成交 ${this.trades.length} 笔${dup ? `（清理重复 ${dup} 笔）` : ''}`);
      if (dup) this.persistSoon();
    }
  }

  private snapshotState(): PersistedState {
    return {
      version: 1,
      mint: this.mint,
      trades: this.trades.filter((t) => t.status === 'confirmed'),
      scanned: this.scanned,
      createdAt: this.createdAt,
    };
  }

  private persistSoon() {
    this.stateFile.writeSoon(() => this.snapshotState());
  }

  private persistNow() {
    try {
      this.stateFile.writeNow(this.snapshotState());
    } catch {
      /* ignore */
    }
  }

  private reindex() {
    this.tradeIds = new Set(this.trades.map((t) => t.id));
    this.tradeSigs = new Set(this.trades.map((t) => t.sig));
  }

  // ─── 元数据 ─────────────────────────────────────────────────

  /** 持仓排名要按代币程序（SPL Token / Token-2022）查询，必须在第一次 refreshHolders 之前确定 */
  private async detectTokenProgram() {
    const res = await this.rpc.call<any>('getAccountInfo', [this.mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    if (!res?.value) throw new Error('代币 mint 账户不存在');
    this.tokenProgram = res.value.owner;
    const info = res.value.data?.parsed?.info;
    this.decimals = Number(info?.decimals ?? this.decimals);
    if (info?.supply) this.supply = Number(info.supply) / 10 ** this.decimals;
  }

  private async refreshMeta() {
    try {
      const { info, imageFile } = await loadTokenInfo(this.rpc, this.mint, this.dataDir, this.token);
      if (this.createdAt) info.createdAt = this.createdAt;
      this.token = info;
      this.imageFile = imageFile;
      this.decimals = info.decimals;
      this.tokenProgram = info.tokenProgram;
      this.tokenFile.writeNow(info);
      this.emitMsg({ t: 'token', token: info });
    } catch (e) {
      this.warn('元数据', e);
    }
  }

  // ─── 池子（内盘 bonding curve / 毕业后 PumpSwap）──────────────

  get market(): MarketInfo | null {
    if (!this.curve) return null;
    if (this.curve.complete) return this.amm ?? { ...marketFromCurve(this.curve), mode: 'amm', dex: 'PumpSwap' };
    return marketFromCurve(this.curve);
  }

  private applyCurve(data: Buffer, slot: number) {
    if (this.curve && slot < this.curve.slot) return;
    const raw = decodeBondingCurve(data, this.decimals);
    const wasComplete = this.curve?.complete ?? false;
    this.curve = { address: this.curveAddress, ...raw, slot, updatedAt: Date.now() };
    this.emitMsg({ t: 'curve', curve: this.curve, market: this.market });
    if (raw.complete && !wasComplete && this.status.slot) {
      console.log('[engine] bonding curve 已完成，代币已毕业迁移');
      void this.refreshPool().catch((e) => this.warn('读取 PumpSwap 池子', e));
    }
  }

  private async fetchCurve() {
    const res = await this.rpc.call<any>('getAccountInfo', [this.curveAddress, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!res?.value) throw new Error('bonding curve 账户不存在');
    this.applyCurve(Buffer.from(res.value.data[0], 'base64'), res.context.slot);
  }

  private async refreshCurve() {
    await this.fetchCurve();
  }

  /**
   * 毕业后：直接从链上读取 PumpSwap 池子（池子账户 → 两个金库余额 + LP 流通量）。
   * 少数早期代币迁移到了 Raydium 等其他池子，这时退回 DexScreener 的数据。
   */
  private async refreshPool() {
    if (!this.pool) {
      const res = await this.rpc.call<any>('getAccountInfo', [this.poolAddress, { encoding: 'base64', commitment: 'confirmed' }]);
      const pool = res?.value ? decodePumpSwapPool(Buffer.from(res.value.data[0], 'base64')) : null;
      if (!pool || pool.baseMint !== this.mint) return this.refreshAmmFromDexScreener();
      this.pool = pool;
      this.subscribePool();
    }
    const res = await this.rpc.call<any>('getMultipleAccounts', [
      [this.pool.baseVault, this.pool.quoteVault, this.pool.lpMint],
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    const [base, quote, lp] = res.value as any[];
    const baseReserve = Number(base?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? NaN);
    const quoteReserve = Number(quote?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? NaN);
    if (!Number.isFinite(baseReserve) || !Number.isFinite(quoteReserve)) throw new Error('池子金库读取失败');
    const lpSupply = Number(lp?.data?.parsed?.info?.supply ?? 0) / 10 ** Number(lp?.data?.parsed?.info?.decimals ?? 9);
    this.setPoolReserves(baseReserve, quoteReserve, lpSupply, res.context.slot);
  }

  private poolSlot = 0;

  private setPoolReserves(baseReserve: number, quoteReserve: number, lpSupply: number | undefined, slot: number) {
    if (slot < this.poolSlot) return;
    this.poolSlot = slot;
    this.amm = marketFromPool({ address: this.poolAddress, baseReserve, quoteReserve, lpSupply: lpSupply ?? this.amm?.lpSupply ?? 0 });
    if (this.curve) this.emitMsg({ t: 'curve', curve: this.curve, market: this.market });
  }

  private async refreshAmmFromDexScreener() {
    try {
      const pairs = await getJson<any[]>(`https://api.dexscreener.com/tokens/v1/solana/${this.mint}`);
      const p = pairs
        .filter((x) => x.quoteToken?.address === WSOL_MINT && x.dexId !== 'pumpfun')
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (!p) return;
      const poolSol = Number(p.liquidity?.quote ?? 0);
      const poolTokens = Number(p.liquidity?.base ?? 0);
      this.amm = {
        mode: 'amm',
        dex: p.dexId,
        poolAddress: p.pairAddress,
        priceSol: Number(p.priceNative),
        poolSol,
        poolTokens,
        reserveSol: poolSol,
        reserveTokens: poolTokens,
        progress: 1,
        solToGraduate: 0,
      };
      if (this.curve) this.emitMsg({ t: 'curve', curve: this.curve, market: this.market });
    } catch (e) {
      this.warn('AMM 行情', e);
    }
  }

  /** 毕业后订阅池子相关交易的日志：每笔 Buy/SellEvent 实时推送 */
  private subscribePool() {
    if (this.poolSubscribed) return;
    this.poolSubscribed = true;
    this.sock.subscribe('logsSubscribe', [{ mentions: [this.poolAddress] }, { commitment: 'processed' }], (r: any) => this.onLogs(r));
  }

  // ─── 实时订阅 ────────────────────────────────────────────────

  private startSocket() {
    this.sock.on('open', (url: string) => {
      console.log(`[engine] WebSocket 已连接 ${url}`);
      this.status.wsConnected = true;
      this.status.rpcWs = url;
      this.emitMsg({ t: 'status', status: this.status });
      // 断线期间可能漏单：重连后立即对账 + 刷新
      void this.reconcile().catch(() => {});
      void this.fetchCurve().catch(() => {});
    });
    this.sock.on('close', () => {
      this.status.wsConnected = false;
      this.emitMsg({ t: 'status', status: this.status });
    });
    this.sock.on('log', (m: string) => this.warn('WS', m));

    this.sock.subscribe('slotSubscribe', [], (r: { slot: number }) => {
      const now = Date.now();
      this.status.slot = r.slot;
      this.status.slotMs = now;
      this.slotTimes.set(r.slot, now);
      this.slotTimes.delete(r.slot - 3000);
      this.emitMsg({ t: 'slot', slot: r.slot, ms: now });
      if (now - this.lastStatusBroadcast > 10_000) {
        this.lastStatusBroadcast = now;
        this.emitMsg({ t: 'status', status: this.status });
      }
    });

    this.sock.subscribe('accountSubscribe', [this.curveAddress, { encoding: 'base64', commitment: 'processed' }], (r: any) => {
      if (r?.value?.data) this.applyCurve(Buffer.from(r.value.data[0], 'base64'), r.context.slot);
    });

    this.sock.subscribe('logsSubscribe', [{ mentions: [this.curveAddress] }, { commitment: 'processed' }], (r: any) =>
      this.onLogs(r),
    );

    // 代币总量：销毁（或增发）后毫秒级更新市值和持仓占比
    this.sock.subscribe('accountSubscribe', [this.mint, { encoding: 'jsonParsed', commitment: 'processed' }], (r: any) => {
      const raw = r?.value?.data?.parsed?.info?.supply;
      if (raw === undefined) return;
      const supply = Number(raw) / 10 ** this.decimals;
      if (supply > 0 && supply !== this.supply) {
        this.supply = supply;
        this.rebuildHolders();
        this.emitHolders();
      }
    });

    this.syncCompanySubs();
    this.sock.start();
  }

  /** 为每个公司钱包的 ATA 建立账户订阅（钱包增减持瞬间反映到公司资产） */
  private syncCompanySubs() {
    const want = new Map<string, string>();
    for (const w of this.config.companyWallets) {
      want.set(associatedTokenAddress(w.address, this.mint, this.tokenProgram), w.address);
    }
    for (const [ata, key] of this.companySubs) {
      if (!want.has(ata)) {
        this.sock.unsubscribe(key);
        this.companySubs.delete(ata);
      }
    }
    for (const [ata, owner] of want) {
      if (this.companySubs.has(ata)) continue;
      const key = this.sock.subscribe('accountSubscribe', [ata, { encoding: 'base64', commitment: 'processed' }], (r: any) => {
        const slot: number = r.context.slot;
        let amount = 0;
        if (r.value?.data) {
          const d = decodeTokenAccount(Buffer.from(r.value.data[0], 'base64'));
          if (d && d.mint === this.mint) amount = Number(d.amountRaw) / 10 ** this.decimals;
        }
        if (this.setTokenAccount(ata, owner, amount, slot)) {
          this.rebuildHolders();
          this.emitHolders();
        }
      });
      this.companySubs.set(ata, key);
    }
  }

  private onLogs(r: { context: { slot: number }; value: { signature: string; err: unknown; logs: string[] } }) {
    const { signature, err, logs } = r.value;
    if (err) return;
    const recvMs = Date.now();
    const events = parseTradeEvents(logs, this.mint, this.decimals, this.poolAddress);
    if (!events.length) return;
    let added = false;
    events.forEach((ev, i) => {
      const id = `${signature}:${i}`;
      if (this.tradeIds.has(id)) return;
      const trade = this.makeTrade(ev, signature, i, r.context.slot, -1, 'processed', recvMs);
      this.insertTrade(trade);
      this.updateFees(ev, r.context.slot);
      if (ev.venue === 'amm') {
        // 成交事件里带着成交后的池子余额：毫秒级更新价格，不必等定时校准
        this.setPoolReserves(ev.realTokenReserves, ev.realSolReserves, undefined, r.context.slot);
      } else if (this.curve && r.context.slot >= this.curve.slot) {
        this.curve = {
          ...this.curve,
          virtualSolReserves: ev.virtualSolReserves,
          virtualTokenReserves: ev.virtualTokenReserves,
          realSolReserves: ev.realSolReserves,
          realTokenReserves: ev.realTokenReserves,
          slot: r.context.slot,
          updatedAt: recvMs,
        };
      }
      this.status.lastTradeMs = recvMs;
      this.recomputeStats();
      this.emitMsg({ t: 'trade', trade, market: this.market, curve: this.curve, stats: this.stats });
      added = true;
    });
    if (added) {
      this.scheduleHoldersRefresh(2_500);
      this.persistSoon();
    }
  }

  private makeTrade(
    ev: TradeEvent,
    sig: string,
    idx: number,
    slot: number,
    txIndex: number,
    status: Trade['status'],
    recvMs?: number,
  ): Trade {
    return {
      id: `${sig}:${idx}`,
      sig,
      slot,
      txIndex,
      ts: ev.timestamp,
      chainMs: recvMs ? (this.slotTimes.get(slot) ?? recvMs) : undefined,
      recvMs,
      isBuy: ev.isBuy,
      sol: ev.solAmount,
      tokens: ev.tokenAmount,
      user: ev.user,
      priceSol: ev.virtualSolReserves / ev.virtualTokenReserves,
      prePriceSol: prePriceFromPost(ev.isBuy, ev.virtualSolReserves, ev.virtualTokenReserves, ev.solAmount, ev.tokenAmount),
      vSol: ev.virtualSolReserves,
      vTok: ev.virtualTokenReserves,
      rSol: ev.realSolReserves,
      rTok: ev.realTokenReserves,
      fee: ev.fee,
      creatorFee: ev.creatorFee,
      feeBps: ev.feeBps,
      creatorFeeBps: ev.creatorFeeBps,
      solUsd: recvMs ? this.prices.price.usd : this.prices.usdAt(ev.timestamp),
      status,
      venue: ev.venue,
    };
  }

  /** 费率取最新一笔成交的（PumpSwap 按市值动态调整费率；回填旧成交时不能把新费率覆盖回去） */
  private updateFees(ev: TradeEvent, slot: number) {
    if (slot < this.feesSlot || !(ev.feeBps > 0 || ev.creatorFeeBps > 0)) return;
    this.feesSlot = slot;
    this.fees = { protocolBps: ev.feeBps, creatorBps: ev.creatorFeeBps };
  }

  /**
   * 已存在同 id 的成交时不重复入库，只把"待确认"升级为"已确认"。
   * 实时推送与对账/回填是异步交错的：拿到交易详情之后、入库之前，同一笔成交可能已经从另一条路径进来了。
   */
  private absorbExisting(t: Trade): boolean {
    if (!this.tradeIds.has(t.id)) return false;
    const cur = this.trades.findLast((x) => x.id === t.id);
    if (cur && cur.status === 'processed' && t.status === 'confirmed') {
      cur.status = 'confirmed';
      if (t.txIndex >= 0) cur.txIndex = t.txIndex;
      this.emitMsg({ t: 'trade_update', trade: cur });
    }
    return true;
  }

  /** 插入一笔成交；返回是否为新成交 */
  private insertTrade(t: Trade): boolean {
    if (this.absorbExisting(t)) return false;
    const last = this.trades[this.trades.length - 1];
    this.trades.push(t);
    if (last && compareTrades(last, t) > 0) this.trades.sort(compareTrades);
    this.tradeIds.add(t.id);
    this.tradeSigs.add(t.sig);
    if (this.trades.length > MAX_TRADES) {
      this.trades.splice(0, this.trades.length - MAX_TRADES);
      this.reindex();
    }
    return true;
  }

  // ─── 历史回填 / 对账 ─────────────────────────────────────────

  get hasPrivateRpc() {
    return this.opts.http[0]?.name === 'custom';
  }

  /**
   * 拉取并解析交易。
   * · 配置了私有 RPC：20 条一批快速拉取。
   * · 公共节点分两轮：
   *   1. publicnode（实测 getTransaction 约 20 次/秒），但它只保留最近几天的交易，更早的返回 null；
   *   2. publicnode 查不到的，交给 Solana 官方节点（有完整历史，实测突发约 12 次后只能维持 ~0.8 次/秒）。
   *   逐条拉取，429 时退避后重试同一条。
   */
  private async ingestSignatures(infos: SigInfo[], progress = false): Promise<{ added: Trade[]; failed: number }> {
    const added: Trade[] = [];
    let failed = 0;
    // 2026 年起主网出现 v1 版本交易，必须声明支持到 v1，否则节点直接拒绝
    const txOpts = { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' };
    const handle = (s: SigInfo, tx: any) => {
      if (tx.meta?.err) {
        this.ignoredSigs.add(s.signature);
        return;
      }
      const evs = parseTradeEvents(tx.meta?.logMessages, this.mint, this.decimals, this.poolAddress);
      if (!evs.length) {
        this.ignoredSigs.add(s.signature);
        return;
      }
      evs.forEach((ev, idx) => {
        if (this.tradeIds.has(`${s.signature}:${idx}`)) return;
        added.push(this.makeTrade(ev, s.signature, idx, tx.slot, s.transactionIndex ?? -1, 'confirmed'));
        this.updateFees(ev, tx.slot);
      });
    };
    const report = (done: number) => {
      if (!progress) return;
      this.status.backfillFetched = done;
      if (done % 10 === 0 || done === infos.length) {
        console.log(`[engine] 回填进度 ${done}/${infos.length}`);
        this.emitMsg({ t: 'status', status: this.status });
      }
    };

    if (this.hasPrivateRpc) {
      for (let i = 0; i < infos.length; i += 20) {
        const chunk = infos.slice(i, i + 20);
        try {
          const txs = await this.rpc.batch<any>(chunk.map((s) => ['getTransaction', [s.signature, txOpts]]), { indexed: true });
          chunk.forEach((s, k) => (txs[k] ? handle(s, txs[k]) : failed++));
        } catch (e) {
          this.warn('getTransaction 批量', e);
          failed += chunk.length;
        }
        report(Math.min(infos.length, i + 20));
      }
      return { added, failed };
    }

    let done = 0;
    /** 逐条拉取；返回这个节点查不到（null）的签名。被持续限流时返回 null 表示本轮放弃 */
    const fetchLoop = async (list: SigInfo[], opts: { prefer?: string; indexed?: boolean }, basePace: number) => {
      const missing: SigInfo[] = [];
      let pace = basePace;
      let strikes = 0;
      for (let i = 0; i < list.length; ) {
        const s = list[i];
        let tx: any;
        try {
          tx = await this.rpc.call('getTransaction', [s.signature, txOpts], opts);
        } catch (e) {
          if (!isRateLimited(e)) {
            // 非限流错误（该笔交易本身的问题）：跳过这一笔，不阻塞队列
            this.warn(`getTransaction ${s.signature.slice(0, 10)}…`, e);
            failed++;
            i++;
            report(++done);
            continue;
          }
          strikes++;
          if (strikes > 6) {
            this.warn('getTransaction 持续限流（本轮暂停，稍后续跑）', e);
            failed += list.length - i;
            return null;
          }
          pace = Math.min(5_000, pace * 2 + 200);
          await sleep(3_000 * strikes);
          continue; // 限流：退避后重试同一条
        }
        strikes = 0;
        if (tx) {
          handle(s, tx);
          report(++done);
        } else missing.push(s);
        i++;
        if (i < list.length) await sleep(pace);
      }
      return missing;
    };

    const old = await fetchLoop(infos, { prefer: 'publicnode' }, 120);
    if (old?.length) {
      console.log(`[engine] ${old.length} 笔较早的交易 publicnode 没有，改用 Solana 官方节点补齐（较慢）`);
      const still = await fetchLoop(old, { indexed: true }, 1_300);
      if (still) failed += still.length; // 两个节点都查不到：留给下次续跑
    }
    return { added, failed };
  }

  private async fillSolUsd(trades: Trade[]) {
    const missing = trades.filter((t) => !(t.solUsd > 0));
    if (!missing.length) return;
    const from = Math.min(...missing.map((t) => t.ts));
    const to = Math.max(...missing.map((t) => t.ts));
    try {
      await this.prices.loadHistory(from - 120, to + 120);
    } catch (e) {
      this.warn('SOL 历史价', e);
    }
    for (const t of missing) t.solUsd = this.prices.usdAt(t.ts) || this.prices.price.usd;
  }

  private backfilling = false;
  /** 上一次回填还有没拉到的交易：此时对账不能把"已处理到的位置"往前推，否则更早的缺口就再也补不回来 */
  private backfillGaps = false;

  private async backfill() {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      await this.backfillOnce();
    } finally {
      this.backfilling = false;
    }
  }

  /** 从新到旧翻页拉取某个地址的签名，直到遇到上次处理到的位置或到达最早一笔 */
  private async collectSignatures(address: string) {
    const infos: SigInfo[] = [];
    let before: string | undefined;
    let newest: string | undefined;
    let reachedStart = false;
    const known = this.scanned[address];
    for (let page = 0; page < 40; page++) {
      const res = await this.rpc.call<SigInfo[]>(
        'getSignaturesForAddress',
        [address, { limit: 1000, before, commitment: 'confirmed' }],
        { indexed: true },
      );
      if (!res.length) {
        reachedStart = true;
        break;
      }
      newest ??= res[0].signature;
      const stop = res.findIndex((s) => s.signature === known);
      infos.push(...(stop >= 0 ? res.slice(0, stop) : res));
      if (stop >= 0) break;
      if (res.length < 1000) {
        reachedStart = true;
        break;
      }
      before = res[res.length - 1].signature;
    }
    return { infos, newest, reachedStart };
  }

  private async backfillOnce() {
    // 内盘地址 + 毕业后的池子地址；同一笔交易可能同时出现在两边（迁移交易），按签名去重
    const addresses = this.pool || this.curve?.complete ? [this.curveAddress, this.poolAddress] : [this.curveAddress];
    const scans = new Map<string, Awaited<ReturnType<Engine['collectSignatures']>>>();
    for (const a of addresses) scans.set(a, await this.collectSignatures(a));

    const curveScan = scans.get(this.curveAddress)!;
    if (curveScan.reachedStart && curveScan.infos.length) {
      const oldest = curveScan.infos[curveScan.infos.length - 1];
      if (oldest.blockTime) this.createdAt = oldest.blockTime;
    }
    if (this.token && this.createdAt) this.token.createdAt = this.createdAt;

    const bySig = new Map<string, SigInfo>();
    for (const s of [...scans.values()].flatMap((x) => x.infos)) bySig.set(s.signature, s);
    const infos = [...bySig.values()];
    const todo = infos
      .filter((s) => !s.err && !this.tradeSigs.has(s.signature) && !this.ignoredSigs.has(s.signature))
      .sort((a, b) => a.slot - b.slot || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0));
    console.log(`[engine] 回填：发现 ${infos.length} 个签名，需解析 ${todo.length} 笔交易`);
    this.status.backfillTotal = todo.length;
    this.status.backfillFetched = 0;
    this.emitMsg({ t: 'status', status: this.status });
    const { added, failed } = await this.ingestSignatures(todo, true);
    await this.fillSolUsd(added);
    for (const t of added) {
      if (this.absorbExisting(t)) continue;
      this.trades.push(t);
      this.tradeIds.add(t.id);
      this.tradeSigs.add(t.sig);
    }
    this.trades.sort(compareTrades);
    this.reindex();
    this.backfillGaps = failed > 0;
    if (!failed) for (const [a, s] of scans) if (s.newest) this.scanned[a] = s.newest;
    this.status.backfillDone = true;
    this.status.backfillTrades = this.trades.length;
    this.recomputeStats();
    this.persistNow();
    console.log(`[engine] 回填完成：新增 ${added.length} 笔，共 ${this.trades.length} 笔成交${failed ? `（${failed} 笔待重试）` : ''}`);
    this.emitMsg({ t: 'snapshot', data: this.getSnapshot() });
    if (failed) setTimeout(() => void this.backfill().catch((e) => this.warn('回填续跑', e)), 30_000);
  }

  /** 对账：补齐 WS 漏掉的成交；processed 成交确认后标记 confirmed；被回滚的剔除 */
  private async reconcile() {
    if (!this.status.backfillDone || this.backfilling) return;
    // 毕业后新成交都在池子里，对账看池子地址
    const activeAddress = this.pool ? this.poolAddress : this.curveAddress;
    const sigs = await this.rpc.call<SigInfo[]>(
      'getSignaturesForAddress',
      [activeAddress, { limit: 100, commitment: 'confirmed' }],
      { indexed: true },
    );
    const bySig = new Map(sigs.map((s) => [s.signature, s]));
    const missing = sigs.filter((s) => !s.err && !this.tradeSigs.has(s.signature) && !this.ignoredSigs.has(s.signature)).reverse();
    if (missing.length > 25) {
      // 缺口较大（例如长时间断线）：交给回填流程统一处理
      void this.backfill().catch((e) => this.warn('回填', e));
    } else if (missing.length) {
      const { added } = await this.ingestSignatures(missing);
      await this.fillSolUsd(added);
      let inserted = 0;
      for (const t of added) {
        if (!this.insertTrade(t)) continue;
        inserted++;
        this.recomputeStats();
        this.emitMsg({ t: 'trade', trade: t, market: this.market, curve: this.curve, stats: this.stats });
      }
      if (inserted) {
        console.log(`[engine] 对账补齐 ${inserted} 笔成交`);
        this.scheduleHoldersRefresh(1_000);
      }
    }
    const oldestCoveredSlot = sigs.length >= 100 ? sigs[sigs.length - 1].slot : 0;
    const now = Date.now();
    let changed = false;
    for (const t of [...this.trades.slice(-500)]) {
      if (t.status !== 'processed') continue;
      const s = bySig.get(t.sig);
      if (s) {
        t.status = 'confirmed';
        if (typeof s.transactionIndex === 'number') t.txIndex = s.transactionIndex;
        this.emitMsg({ t: 'trade_update', trade: t });
        changed = true;
      } else if (t.recvMs && now - t.recvMs > 90_000 && t.slot > oldestCoveredSlot) {
        this.trades.splice(this.trades.indexOf(t), 1);
        this.tradeIds.delete(t.id);
        this.tradeSigs.delete(t.sig);
        this.emitMsg({ t: 'trade_remove', id: t.id });
        console.log(`[engine] 剔除未确认成交 ${t.sig.slice(0, 12)}…`);
        changed = true;
      }
    }
    if (changed) {
      this.trades.sort(compareTrades);
      this.persistSoon();
    }
    if (sigs[0]) {
      const allKnown = sigs.every((s) => s.err || this.tradeSigs.has(s.signature) || this.ignoredSigs.has(s.signature));
      if (allKnown && !this.backfillGaps) this.scanned[activeAddress] = sigs[0].signature;
    }
  }

  // ─── 持仓排名 / 公司钱包 ─────────────────────────────────────

  private setTokenAccount(address: string, owner: string, amount: number, slot: number): boolean {
    const cur = this.tokenAccounts.get(address);
    if (cur && slot < cur.slot) return false;
    if (cur && cur.amount === amount && cur.owner === owner) {
      cur.slot = slot;
      return false;
    }
    this.tokenAccounts.set(address, { owner, amount, slot });
    return true;
  }

  private scheduleHoldersRefresh(ms: number) {
    if (this.holdersTimer) return;
    this.holdersTimer = setTimeout(() => {
      this.holdersTimer = null;
      void this.refreshHolders().catch((e) => this.warn('持仓排名', e));
    }, ms);
  }

  /** getProgramAccounts：拉取该 mint 的全部代币账户（只取 owner+amount 40 字节） */
  async refreshHolders() {
    const res = await this.rpc.call<any>(
      'getProgramAccounts',
      [
        this.tokenProgram,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          withContext: true,
          dataSlice: { offset: 32, length: 40 },
          filters: [{ memcmp: { offset: 0, bytes: this.mint } }],
        },
      ],
      { indexed: true, timeoutMs: 30_000 },
    );
    const slot: number = res.context.slot;
    const seen = new Set<string>();
    for (const { pubkey, account } of res.value as any[]) {
      const b = Buffer.from(account.data[0], 'base64');
      if (b.length < 40) continue;
      seen.add(pubkey);
      this.setTokenAccount(pubkey, bs58encode(b.subarray(0, 32)), Number(b.readBigUInt64LE(32)) / 10 ** this.decimals, slot);
    }
    // 所有代币都躺在代币账户里：全部余额之和就是当前总量（销毁后会变少）
    let total = 0;
    for (const { account } of res.value as any[]) {
      const b = Buffer.from(account.data[0], 'base64');
      if (b.length >= 40) total += Number(b.readBigUInt64LE(32)) / 10 ** this.decimals;
    }
    if (total > 0) this.supply = total;
    for (const [addr, st] of this.tokenAccounts) {
      if (!seen.has(addr) && st.slot <= slot) this.tokenAccounts.delete(addr);
    }
    this.status.lastHoldersMs = Date.now();
    this.rebuildHolders();
    this.emitHolders();
  }

  private rebuildHolders() {
    const byOwner = new Map<string, { amount: number; accounts: string[] }>();
    for (const [addr, st] of this.tokenAccounts) {
      if (!(st.amount > 0)) continue;
      const e = byOwner.get(st.owner) ?? { amount: 0, accounts: [] };
      e.amount += st.amount;
      e.accounts.push(addr);
      byOwner.set(st.owner, e);
    }
    const supply = this.supply;
    const companyMap = new Map(this.config.companyWallets.map((w) => [w.address, w]));
    const poolOwners = new Set([this.curveAddress, this.poolAddress, this.amm?.poolAddress].filter(Boolean) as string[]);
    const creator = this.curve?.creator;
    this.holders = [...byOwner]
      .map(([owner, v]): Holder => {
        const cw = companyMap.get(owner);
        return {
          owner,
          amount: v.amount,
          pct: (v.amount / supply) * 100,
          tag: poolOwners.has(owner) ? 'curve' : cw ? 'company' : 'external',
          label: poolOwners.has(owner) ? '池子' : cw?.label,
          isCreator: owner === creator,
          tokenAccounts: v.accounts,
        };
      })
      .sort((a, b) => b.amount - a.amount);
    this.holderCount = this.holders.length;

    const prev = new Map(this.company.map((w) => [w.address, w]));
    const rankOf = new Map(this.holders.map((h, i) => [h.owner, i + 1]));
    const now = Date.now();
    this.company = this.config.companyWallets.map((w) => {
      const tokens = byOwner.get(w.address)?.amount ?? 0;
      const p = prev.get(w.address);
      const delta = p ? tokens - p.tokens : 0;
      return {
        ...w,
        tokens,
        solBalance: p?.solBalance ?? null,
        rank: rankOf.get(w.address) ?? null,
        tokenAccount: associatedTokenAddress(w.address, this.mint, this.tokenProgram),
        isCreator: w.address === creator,
        lastChangeMs: Math.abs(delta) > 1e-9 ? now : (p?.lastChangeMs ?? 0),
        lastDelta: Math.abs(delta) > 1e-9 ? delta : (p?.lastDelta ?? 0),
      };
    });
  }

  private emitHolders() {
    this.emitMsg({
      t: 'holders',
      holders: this.holders.slice(0, MAX_HOLDERS_SENT),
      holderCount: this.holderCount,
      company: this.company,
      creatorVault: this.creatorVault,
      supply: this.supply,
    });
  }

  /** 公司钱包 SOL 余额 + 创作者金库（待领取手续费收益） */
  private async refreshBalances() {
    const wallets = this.config.companyWallets.map((w) => w.address);
    const vault = this.curve?.creator ? creatorVaultAddress(this.curve.creator) : null;
    const keys = vault ? [...wallets, vault] : wallets;
    const res = await this.rpc.call<any>('getMultipleAccounts', [keys, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    const vals: any[] = res?.value ?? [];
    let changed = false;
    this.company = this.company.map((w) => {
      const i = wallets.indexOf(w.address);
      const sol = i >= 0 ? (vals[i]?.lamports ?? 0) / 1e9 : w.solBalance;
      if (sol !== w.solBalance) changed = true;
      return { ...w, solBalance: sol };
    });
    if (vault) {
      const lamports = vals[keys.length - 1]?.lamports ?? 0;
      const totalEarnedSol = this.trades.reduce((s, t) => s + t.creatorFee, 0);
      const next: CreatorVault = {
        address: vault,
        claimableSol: Math.max(0, lamports - RENT_EXEMPT_ZERO_BYTES) / 1e9,
        totalEarnedSol,
      };
      if (JSON.stringify(next) !== JSON.stringify(this.creatorVault)) changed = true;
      this.creatorVault = next;
    }
    if (changed) this.emitHolders();
  }

  // ─── 统计 ───────────────────────────────────────────────────

  recomputeStats() {
    const now = Date.now() / 1000;
    const price = this.market?.priceSol ?? 0;
    const solUsdNow = this.prices.price.usd;
    const company = new Set(this.config.companyWallets.map((w) => w.address));
    const windows = WINDOWS.map(([key, sec]): WindowStats => {
      const from = now - sec;
      const w: WindowStats = { window: key, priceChange: 0, volumeSol: 0, volumeUsd: 0, buys: 0, sells: 0, buySol: 0, sellSol: 0, traders: 0, companyNetSol: 0 };
      const traders = new Set<string>();
      let startPrice = 0;
      for (let i = this.trades.length - 1; i >= 0; i--) {
        const t = this.trades[i];
        if (t.ts < from) {
          startPrice = t.priceSol;
          break;
        }
        startPrice = t.prePriceSol;
        w.volumeSol += t.sol;
        w.volumeUsd += t.sol * (t.solUsd || solUsdNow);
        traders.add(t.user);
        if (t.isBuy) {
          w.buys++;
          w.buySol += t.sol;
        } else {
          w.sells++;
          w.sellSol += t.sol;
        }
        if (company.has(t.user)) w.companyNetSol += t.isBuy ? t.sol : -t.sol;
      }
      w.traders = traders.size;
      w.priceChange = startPrice > 0 && price > 0 ? price / startPrice - 1 : 0;
      return w;
    });
    let ath = 0;
    let athUsd = 0;
    let athTs = 0;
    let atl = Infinity;
    let vol = 0;
    let creatorFees = 0;
    for (const t of this.trades) {
      if (t.priceSol > ath) {
        ath = t.priceSol;
        athTs = t.ts;
      }
      athUsd = Math.max(athUsd, t.priceSol * (t.solUsd || solUsdNow));
      atl = Math.min(atl, t.priceSol, t.prePriceSol);
      vol += t.sol;
      creatorFees += t.creatorFee;
    }
    this.stats = {
      windows,
      athPriceSol: ath,
      athPriceUsd: athUsd,
      athTs,
      atlPriceSol: Number.isFinite(atl) ? atl : 0,
      totalTrades: this.trades.length,
      totalVolumeSol: vol,
      totalCreatorFeeSol: creatorFees,
      firstTradeTs: this.trades[0]?.ts ?? 0,
    };
    if (this.creatorVault) this.creatorVault = { ...this.creatorVault, totalEarnedSol: creatorFees };
  }

  // ─── 对外接口 ────────────────────────────────────────────────

  /** 公司钱包与分红比例由公司金库（Treasury）统一管理：这里给出数据来源和快照里要附带的金库数据 */
  configProvider?: () => { companyWallets: CompanyWalletConfig[]; dividendRatio: number };
  extraSnapshot?: () => Pick<Snapshot, 'treasury' | 'goal'>;

  /** 由公司金库设置公司钱包名单：持仓排名里标注"公司"、成交统计里的"公司净买入"都按这个名单 */
  setCompanyWallets(list: CompanyWalletConfig[]) {
    this.config.companyWallets = list;
    this.syncCompanySubs();
    this.rebuildHolders();
    this.recomputeStats();
    this.emitMsg({ t: 'config', config: this.getConfig() });
    this.emitHolders();
  }

  getConfig(): AppConfig {
    const p = this.configProvider?.();
    return {
      companyWallets: p?.companyWallets ?? this.config.companyWallets,
      dividendRatio: p?.dividendRatio ?? this.config.dividendRatio,
      ignoredWallets: this.config.ignoredWallets,
      adminEnabled: this.opts.adminEnabled,
    };
  }

  getSnapshot(): Snapshot {
    const extra = this.extraSnapshot?.();
    return {
      serverTime: Date.now(),
      treasury: extra?.treasury ?? emptyTreasury(),
      goal: extra?.goal ?? null,
      mint: this.mint,
      supply: this.supply,
      token: this.token,
      curve: this.curve,
      market: this.market,
      solPrice: this.prices.price,
      fees: this.fees,
      stats: this.stats,
      holders: this.holders.slice(0, MAX_HOLDERS_SENT),
      holderCount: this.holderCount,
      company: this.company,
      creatorVault: this.creatorVault,
      config: this.getConfig(),
      trades: this.trades.slice(-SNAPSHOT_TRADES),
      status: this.status,
    };
  }

  /**
   * 公司持仓历史：以当前持仓为终点，沿成交记录倒推（撤销公司钱包的每笔买卖）。
   * 每个时点记录"当时全部流通代币卖回池子能换出的 SOL"与流通量，前端据此算出当时的公司资产，
   * 口径与资产页的总资产一致：内盘阶段 = 池内 SOL；毕业后按 PumpSwap 恒定乘积计算。
   */
  companyHistory(): CompanyHistoryPoint[] {
    const set = new Set(this.config.companyWallets.map((w) => w.address));
    let tokens = this.company.reduce((s, w) => s + w.tokens, 0);
    const solNow = this.prices.price.usd;
    const supply = this.supply;
    const at = (venue: Trade['venue'], rSol: number, rTok: number) => {
      if (venue === 'amm') {
        const circ = Math.max(0, supply - rTok);
        return { circ, payoutSol: rTok + circ > 0 ? (rSol * circ) / (rTok + circ) : 0 };
      }
      return { circ: Math.max(0, INITIAL_REAL_TOKEN_RESERVES - rTok), payoutSol: rSol };
    };
    // 通过转账（而非池子交易）获得的代币无法定位到具体时间：用"当时的流通量"封顶，
    // 保证任何时刻公司持仓都不超过当时已从池子流出的代币总量
    const m = this.market;
    const circNow = m ? Math.max(0, supply - m.poolTokens) : 0;
    const payoutNow = m ? quoteSell(m, circNow, 0).grossSol : 0;
    const pts: CompanyHistoryPoint[] = [
      { t: Math.floor(Date.now() / 1000), tokens: Math.min(tokens, circNow), priceSol: m?.priceSol ?? 0, solUsd: solNow, payoutSol: payoutNow, circ: circNow },
    ];
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const tr = this.trades[i];
      const s = at(tr.venue, tr.rSol, tr.rTok);
      pts.push({ t: tr.ts, tokens: Math.min(Math.max(0, tokens), s.circ), priceSol: tr.priceSol, solUsd: tr.solUsd || solNow, ...s });
      if (set.has(tr.user)) tokens += tr.isBuy ? -tr.tokens : tr.tokens;
    }
    const first = this.trades[0];
    if (first) {
      const preRTok = first.isBuy ? first.rTok + first.tokens : first.rTok - first.tokens;
      const preRSol = Math.max(0, first.isBuy ? first.rSol - first.sol : first.rSol + first.sol);
      const s = at(first.venue, preRSol, preRTok);
      pts.push({ t: first.ts - 1, tokens: Math.min(Math.max(0, tokens), s.circ), priceSol: first.prePriceSol, solUsd: first.solUsd || solNow, ...s });
    }
    pts.reverse();
    const out: CompanyHistoryPoint[] = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && p.t <= last.t) out[out.length - 1] = { ...p, t: last.t };
      else out.push(p);
    }
    return out;
  }

  /** 校验并规范化钱包地址：粘贴的若是本代币的代币账户（ATA），换成它所属的钱包地址 */
  private normalizeWallet(raw: unknown): string {
    const address = String(raw ?? '').trim();
    if (!isValidPubkey(address)) throw new Error(`无效地址：${address || '(空)'}`);
    if (address === this.mint) throw new Error('这是代币合约地址，不是钱包地址');
    const asTokenAccount = this.tokenAccounts.get(address);
    const wallet = asTokenAccount ? asTokenAccount.owner : address;
    if (wallet === this.curveAddress || wallet === this.poolAddress || wallet === this.amm?.poolAddress) throw new Error('池子地址不能设为公司钱包');
    return wallet;
  }

  async updateConfig(input: { companyWallets?: CompanyWalletConfig[]; dividendRatio?: number; ignoredWallets?: string[] }) {
    if (input.companyWallets) {
      const seen = new Set<string>();
      const list: CompanyWalletConfig[] = [];
      for (const w of input.companyWallets) {
        const address = this.normalizeWallet(w.address);
        if (seen.has(address)) continue;
        seen.add(address);
        list.push({ address, label: String(w.label ?? '').trim().slice(0, 24) || `VK-${String(list.length + 1).padStart(2, '0')}` });
      }
      if (list.length > 50) throw new Error('公司钱包最多 50 个');
      this.config.companyWallets = list;
    }
    if (input.dividendRatio !== undefined) {
      const r = Number(input.dividendRatio);
      if (!(r >= 0 && r <= 1)) throw new Error('分红比例需在 0–100% 之间');
      this.config.dividendRatio = r;
    }
    if (input.ignoredWallets) {
      if (input.ignoredWallets.length > 500) throw new Error('忽略列表最多 500 个地址');
      this.config.ignoredWallets = [...new Set(input.ignoredWallets.map((a) => this.normalizeWallet(a)))];
    }
    // 设为公司钱包的地址自动移出忽略列表
    const company = new Set(this.config.companyWallets.map((w) => w.address));
    this.config.ignoredWallets = this.config.ignoredWallets.filter((a) => !company.has(a));
    this.configFile.writeNow(this.config);
    this.syncCompanySubs();
    this.rebuildHolders();
    this.recomputeStats();
    this.emitMsg({ t: 'config', config: this.getConfig() });
    this.emitHolders();
    void this.refreshBalances().catch(() => {});
    return this.getConfig();
  }

  /** 按当前持仓前 N 名（排除池子）重新识别公司钱包；已有钱包保留原标签，新钱包取下一个未用编号 */
  /**
   * 组装一笔销毁交易交给用户钱包签名（服务器不持有、也不接触任何私钥）。
   * 先在链上模拟一遍：数量不够、账户不对等问题在钱包弹窗之前就能发现。
   */
  async prepareBurn(ownerRaw: unknown, amountRaw: unknown) {
    const owner = String(ownerRaw ?? '').trim();
    if (!isValidPubkey(owner)) throw new Error('钱包地址无效');
    const amountStr = String(amountRaw ?? '').trim();
    if (!/^\d+(\.\d+)?$/.test(amountStr)) throw new Error('销毁数量格式不对');
    const [intPart, frac = ''] = amountStr.split('.');
    if (frac.length > this.decimals) throw new Error(`最多 ${this.decimals} 位小数`);
    const unit = 10n ** BigInt(this.decimals);
    const amount = BigInt(intPart) * unit + BigInt(frac.padEnd(this.decimals, '0') || '0');
    if (amount <= 0n) throw new Error('销毁数量必须大于 0');

    const res = await this.rpc.call<any>('getTokenAccountsByOwner', [owner, { mint: this.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const accounts = ((res?.value ?? []) as any[])
      .map((a) => ({ address: a.pubkey as string, program: a.account.owner as string, balance: BigInt(a.account.data.parsed.info.tokenAmount.amount) }))
      .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
    if (!accounts.length) throw new Error('这个钱包里没有该代币');
    const acc = accounts.find((a) => a.balance >= amount);
    if (!acc) throw new Error(`这个钱包里最多只有 ${(Number(accounts[0].balance) / Number(unit)).toLocaleString('en-US')} 枚`);

    const bh = await this.rpc.call<any>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const tx = buildBurnCheckedTx({
      owner,
      tokenAccount: acc.address,
      mint: this.mint,
      tokenProgram: acc.program,
      amountRaw: amount,
      decimals: this.decimals,
      blockhash: bh.value.blockhash,
    });
    const sim = await this.rpc.call<any>('simulateTransaction', [
      tx.toString('base64'),
      { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
    ]);
    if (sim?.value?.err) {
      const logs = ((sim.value.logs ?? []) as string[]).filter((l) => /error|failed|insufficient/i.test(l)).slice(-2).join('；');
      throw new Error(`链上模拟失败：${JSON.stringify(sim.value.err)}${logs ? `（${logs}）` : ''}`);
    }
    return {
      transaction: tx.toString('base64'),
      tokenAccount: acc.address,
      amount: amountStr,
      amountRaw: amount.toString(),
      decimals: this.decimals,
      balanceRaw: acc.balance.toString(),
      lastValidBlockHeight: bh.value.lastValidBlockHeight as number,
    };
  }

  async autoDetectCompany() {
    await this.refreshHolders();
    const count = WATCH_TOP_HOLDERS;
    const ranked = this.holders.filter((h) => h.tag !== 'curve').slice(0, count);
    const labels = new Map(this.config.companyWallets.map((w) => [w.address, w.label]));
    const used = new Set(ranked.map((h) => labels.get(h.owner)).filter(Boolean));
    let n = 1;
    const nextLabel = () => {
      while (used.has(`VK-${String(n).padStart(2, '0')}`)) n++;
      const l = `VK-${String(n).padStart(2, '0')}`;
      used.add(l);
      return l;
    };
    const list = ranked.map((h) => ({ address: h.owner, label: labels.get(h.owner) ?? nextLabel() }));
    list.sort((a, b) => a.label.localeCompare(b.label));
    return this.updateConfig({ companyWallets: list });
  }
}

function emptyStats(): MarketStats {
  return {
    windows: [],
    athPriceSol: 0,
    athPriceUsd: 0,
    athTs: 0,
    atlPriceSol: 0,
    totalTrades: 0,
    totalVolumeSol: 0,
    totalCreatorFeeSol: 0,
    firstTradeTs: 0,
  };
}

function emptyTreasury(): Snapshot['treasury'] {
  return {
    wallets: [],
    totalSol: 0,
    stakedSol: 0,
    dividendRatio: DEFAULT_DIVIDEND_RATIO,
    activity: [],
    activityCount: 0,
    totalSol24hAgo: null,
    solUsd24hAgo: null,
    status: { backfillDone: false, fetched: 0, total: 0 },
  };
}
