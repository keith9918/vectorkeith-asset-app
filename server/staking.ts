// ───────────────────────────────────────────────────────────────
//  质押
//  · 验证者：Stakewiz（名字、头像、佣金、预计年化），取不到时退回链上 getVoteAccounts
//  · 期（epoch）：getEpochInfo + 出块速度 → 进度和下次发收益的倒计时
//  · 持仓：按提取权限 / 质押权限查质押账户（getProgramAccounts，官方节点支持）+ 钱包里的 LST
//  · 收益：getInflationReward（上一期的实际收益 → 年化）；公司累计收益 = 质押中的 SOL − 投入的本金
//  · 交易：只组装未签名交易并在链上模拟，签名在用户自己的钱包里完成
// ───────────────────────────────────────────────────────────────
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { LST_MINTS, TOKEN_PROGRAM, WSOL_MINT } from '../shared/constants';
import type { EpochInfoView, LstHolding, PreparedStakeTx, StakeAccountInfo, StakePositions, StakingView, ValidatorInfo } from '../shared/types';
import { HttpError } from './access';
import { getJson } from './http';
import type { SolPriceFeed } from './prices';
import type { RpcHttp } from './rpc';
import { isValidPubkey } from './solana';
import { STAKE_PROGRAM, STAKE_SPACE, buildDeactivateTx, buildStakeTx, buildWithdrawTx } from './staketx';
import { JsonFile } from './store';

const LAMPORTS = 1e9;
const NEVER = '18446744073709551615'; // u64::MAX：没有解除质押
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

interface Opts {
  dataDir: string;
  rpc: RpcHttp;
  prices: SolPriceFeed;
  companyWallets: () => string[];
  /** 公司钱包流水里记录的质押本金（质押出去的 − 取回的） */
  companyPrincipal: () => number;
  warn: (label: string, e: unknown) => void;
}

interface EpochState {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  slotMs: number;
  at: number;
}

export class Staking extends EventEmitter {
  private cfgFile: JsonFile<{ includeInAssets: boolean }>;
  includeInAssets: boolean;
  private validators = new Map<string, ValidatorInfo>();
  private recommended: ValidatorInfo[] = [];
  private networkApy = 0;
  private ep: EpochState | null = null;
  private posCache = new Map<string, { at: number; data: StakePositions }>();
  private rewardCache = new Map<string, { epoch: number; sol: number; post: number } | null>(); // `${epoch}:${address}`
  private lstRate: { at: number; rates: Record<string, number> } | null = null;
  private companyCache: StakePositions | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(private o: Opts) {
    super();
    this.cfgFile = new JsonFile(path.join(o.dataDir, 'staking', 'config.json'), 0);
    this.includeInAssets = this.cfgFile.read()?.includeInAssets ?? true;
  }

  async start() {
    await Promise.allSettled([this.refreshEpoch(), this.refreshValidators()]);
    void this.refreshCompany();
    this.timers.push(setInterval(() => void this.refreshEpoch().catch(() => {}), 5 * 60_000));
    this.timers.push(setInterval(() => void this.refreshValidators().catch(() => {}), 30 * 60_000));
    this.timers.push(setInterval(() => void this.refreshCompany(), 2 * 60_000));
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  // ─── 公司质押（计入总资产） ─────────────────────────────────

  /** 公司质押中的 SOL（质押账户 + LST 折合），同步读取缓存 */
  companyStakedSol() {
    return this.companyCache?.stakedSol ?? 0;
  }

  async refreshCompany() {
    const wallets = this.o.companyWallets();
    try {
      const before = this.companyCache?.stakedSol ?? 0;
      this.companyCache = wallets.length ? await this.positions(wallets, true) : null;
      if (Math.abs((this.companyCache?.stakedSol ?? 0) - before) > 1e-9) this.emit('company');
    } catch (e) {
      this.o.warn('公司质押', e);
    }
  }

  setIncludeInAssets(v: boolean) {
    this.includeInAssets = v;
    this.cfgFile.writeNow({ includeInAssets: v });
    this.emit('company');
  }

  // ─── 验证者 / 期 ────────────────────────────────────────────

  private async refreshValidators() {
    try {
      const list = await getJson<any[]>('https://api.stakewiz.com/validators', 25_000);
      if (!Array.isArray(list) || !list.length) throw new Error('空列表');
      const map = new Map<string, ValidatorInfo>();
      let w = 0;
      let sum = 0;
      for (const v of list) {
        if (!v?.vote_identity) continue;
        const apy = Number(v.total_apy ?? v.staking_apy);
        const info: ValidatorInfo = {
          vote: v.vote_identity,
          name: String(v.name || '').trim() || short(v.vote_identity),
          image: v.image || undefined,
          commission: Number(v.commission ?? 0),
          apy: Number.isFinite(apy) && apy > 0 ? apy : undefined,
          stake: Number(v.activated_stake) || undefined,
          uptime: Number(v.uptime) || undefined,
          skipRate: Number.isFinite(Number(v.skip_rate)) ? Number(v.skip_rate) : undefined,
          delinquent: !!v.delinquent,
          website: v.website || undefined,
        };
        map.set(info.vote, info);
        if (info.apy && info.stake && !info.delinquent) {
          w += info.stake;
          sum += info.stake * info.apy;
        }
      }
      this.validators = map;
      this.networkApy = w ? sum / w : this.networkApy;
      // 推荐：在线、佣金 ≤ 5%、在线率 ≥ 99%、有名字、有一定质押量，按 Stakewiz 综合评分排序
      const good = list.filter((v) => !v.delinquent && Number(v.commission) <= 5 && Number(v.uptime) >= 99 && v.name && Number(v.total_apy) > 0 && Number(v.jito_commission_bps ?? 0) <= 1000);
      // 两类：大型知名节点（质量最大的 4 个）+ Stakewiz 综合评分最高的中小节点（更去中心化，通常 0 佣金）
      const big = [...good].sort((a, b) => Number(b.activated_stake) - Number(a.activated_stake)).slice(0, 4);
      const top = good
        .filter((v) => Number(v.activated_stake) >= 50_000 && !big.includes(v))
        .sort((a, b) => Number(b.wiz_score) - Number(a.wiz_score))
        .slice(0, 10)
        .sort((a, b) => Number(b.total_apy) - Number(a.total_apy));
      this.recommended = [...big, ...top].map((v) => map.get(v.vote_identity)!);
    } catch (e) {
      this.o.warn('Stakewiz 验证者列表（改用链上数据）', e);
      if (this.validators.size) return;
      const va = await this.o.rpc.call<any>('getVoteAccounts', [{ commitment: 'confirmed' }]);
      for (const v of va.current ?? []) {
        this.validators.set(v.votePubkey, { vote: v.votePubkey, name: short(v.votePubkey), commission: v.commission, stake: v.activatedStake / LAMPORTS, delinquent: false });
      }
      this.recommended = [...this.validators.values()]
        .filter((v) => v.commission <= 5)
        .sort((a, b) => (b.stake ?? 0) - (a.stake ?? 0))
        .slice(0, 12);
    }
  }

  private async refreshEpoch() {
    const [ei, perf] = await Promise.all([
      this.o.rpc.call<any>('getEpochInfo', [{ commitment: 'confirmed' }]),
      this.o.rpc.call<any[]>('getRecentPerformanceSamples', [6]).catch(() => []),
    ]);
    const ms = perf.filter((p) => p.numSlots > 0).map((p) => (p.samplePeriodSecs * 1000) / p.numSlots);
    const slotMs = ms.length ? ms.reduce((s, v) => s + v, 0) / ms.length : 400;
    const prev = this.ep?.epoch;
    this.ep = { epoch: ei.epoch, slotIndex: ei.slotIndex, slotsInEpoch: ei.slotsInEpoch, slotMs, at: Date.now() };
    if (prev !== undefined && prev !== ei.epoch) {
      // 新的一期：收益刚发放，刷新持仓
      this.posCache.clear();
      void this.refreshCompany();
    }
  }

  epochView(): EpochInfoView {
    const e = this.ep;
    if (!e) return { epoch: 0, progress: 0, endsInSec: 0, epochSec: 2 * 86400 };
    const elapsed = (Date.now() - e.at) / e.slotMs;
    const idx = Math.min(e.slotsInEpoch, e.slotIndex + elapsed);
    const epochSec = (e.slotsInEpoch * e.slotMs) / 1000;
    return { epoch: e.epoch, progress: idx / e.slotsInEpoch, endsInSec: Math.max(0, ((e.slotsInEpoch - idx) * e.slotMs) / 1000), epochSec };
  }

  private get epochsPerYear() {
    return (365.25 * 86400) / this.epochView().epochSec;
  }

  // ─── 持仓 ───────────────────────────────────────────────────

  private status(d: any, epoch: number): StakeAccountInfo['status'] {
    if (!d) return 'inactive';
    const act = Number(d.activationEpoch);
    if (d.deactivationEpoch !== NEVER) return epoch > Number(d.deactivationEpoch) ? 'inactive' : 'deactivating';
    return epoch > act ? 'active' : 'activating';
  }

  private async lstRates(): Promise<Record<string, number>> {
    if (this.lstRate && Date.now() - this.lstRate.at < 10 * 60_000) return this.lstRate.rates;
    const ids = [WSOL_MINT, ...Object.keys(LST_MINTS)].join(',');
    const j = await getJson<Record<string, { usdPrice?: number }>>(`https://lite-api.jup.ag/price/v3?ids=${ids}`, 10_000);
    const sol = Number(j[WSOL_MINT]?.usdPrice) || this.o.prices.price.usd;
    const rates: Record<string, number> = {};
    for (const m of Object.keys(LST_MINTS)) if (j[m]?.usdPrice && sol > 0) rates[m] = Number(j[m].usdPrice) / sol;
    this.lstRate = { at: Date.now(), rates };
    return rates;
  }

  /** 上一期的实际收益（按期缓存，一期只查一次） */
  private async lastRewards(addresses: string[]): Promise<Map<string, { epoch: number; sol: number; post: number } | null>> {
    const out = new Map<string, { epoch: number; sol: number; post: number } | null>();
    const epoch = this.epochView().epoch - 1;
    if (epoch < 0 || !addresses.length) return out;
    const todo = addresses.filter((a) => !this.rewardCache.has(`${epoch}:${a}`));
    if (todo.length) {
      try {
        const res = await this.o.rpc.call<any[]>('getInflationReward', [todo, { epoch, commitment: 'confirmed' }], { indexed: true });
        todo.forEach((a, i) => {
          const r = res?.[i];
          this.rewardCache.set(`${epoch}:${a}`, r ? { epoch: r.epoch, sol: r.amount / LAMPORTS, post: r.postBalance / LAMPORTS } : null);
        });
        if (this.rewardCache.size > 5000) this.rewardCache.clear();
      } catch (e) {
        this.o.warn('质押收益', e);
      }
    }
    for (const a of addresses) out.set(a, this.rewardCache.get(`${epoch}:${a}`) ?? null);
    return out;
  }

  /** 一组钱包的全部质押：质押账户（提取权限或质押权限是这些钱包）+ LST */
  async positions(owners: string[], fresh = false): Promise<StakePositions> {
    const key = [...owners].sort().join(',');
    const hit = this.posCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.data;
    const epoch = this.epochView().epoch;
    const seen = new Map<string, any>();
    for (const owner of owners) {
      for (const offset of [44, 12]) {
        const accs = await this.o.rpc.call<any[]>('getProgramAccounts', [STAKE_PROGRAM, { encoding: 'jsonParsed', commitment: 'confirmed', filters: [{ dataSize: STAKE_SPACE }, { memcmp: { offset, bytes: owner } }] }], { indexed: true });
        for (const a of accs) seen.set(a.pubkey, a);
      }
    }
    const rewards = await this.lastRewards([...seen.keys()]);
    const accounts: StakeAccountInfo[] = [];
    for (const [address, a] of seen) {
      const info = a.account?.data?.parsed?.info;
      if (!info?.meta) continue;
      const d = info.stake?.delegation;
      const sol = Number(a.account.lamports) / LAMPORTS;
      const rent = Number(info.meta.rentExemptReserve) / LAMPORTS;
      const delegated = d ? Number(d.stake) / LAMPORTS : 0;
      const status = this.status(d, epoch);
      const r = rewards.get(address);
      const base = r ? r.post - r.sol : 0;
      accounts.push({
        address,
        owner: info.meta.authorized.withdrawer,
        staker: info.meta.authorized.staker,
        sol,
        delegated,
        status,
        vote: d?.voter,
        validator: d?.voter ? (this.validators.get(d.voter) ?? { vote: d.voter, name: short(d.voter), commission: 0 }) : undefined,
        activationEpoch: d ? Number(d.activationEpoch) : undefined,
        deactivationEpoch: d && d.deactivationEpoch !== NEVER ? Number(d.deactivationEpoch) : undefined,
        lastReward: r ? { epoch: r.epoch, sol: r.sol } : undefined,
        apr: r && base > 0 ? (r.sol / base) * this.epochsPerYear * 100 : undefined,
        withdrawable: status === 'inactive' ? sol : Math.max(0, sol - rent - delegated),
      });
    }
    accounts.sort((a, b) => b.sol - a.sol);

    // 钱包余额 + LST
    const balances = await this.o.rpc.call<any>('getMultipleAccounts', [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
    const walletSol = (balances?.value ?? []).reduce((s: number, v: any) => s + Number(v?.lamports ?? 0) / LAMPORTS, 0);
    const lst: LstHolding[] = [];
    let rates: Record<string, number> = {};
    for (const owner of owners) {
      const res = await this.o.rpc.call<any>('getTokenAccountsByOwner', [owner, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      for (const ta of res?.value ?? []) {
        const pi = ta.account?.data?.parsed?.info;
        const symbol = LST_MINTS[pi?.mint];
        const amount = Number(pi?.tokenAmount?.uiAmount ?? 0);
        if (!symbol || !(amount > 0)) continue;
        if (!Object.keys(rates).length) rates = await this.lstRates().catch(() => ({}));
        const solPerToken = rates[pi.mint] ?? 1;
        lst.push({ owner, mint: pi.mint, symbol, amount, solPerToken, sol: amount * solPerToken, apy: this.networkApy || undefined });
      }
    }

    const stakedSol = accounts.reduce((s, a) => s + a.sol, 0) + lst.reduce((s, l) => s + l.sol, 0);
    const lastEpochReward = accounts.reduce((s, a) => s + (a.lastReward?.sol ?? 0), 0);
    // 加权年化：质押账户按实际收益，LST 按全网平均
    let w = 0;
    let sum = 0;
    for (const a of accounts) {
      const apy = a.apr ?? (a.status === 'active' ? a.validator?.apy : undefined);
      if (apy && a.sol > 0) {
        w += a.sol;
        sum += a.sol * apy;
      }
    }
    for (const l of lst) {
      if (l.apy) {
        w += l.sol;
        sum += l.sol * l.apy;
      }
    }
    const data: StakePositions = { owners, walletSol, accounts, lst, stakedSol, lastEpochReward, apy: w ? sum / w : undefined };
    this.posCache.set(key, { at: Date.now(), data });
    if (this.posCache.size > 300) this.posCache.delete(this.posCache.keys().next().value!);
    return data;
  }

  async view(): Promise<StakingView> {
    if (!this.companyCache && this.o.companyWallets().length) await this.refreshCompany();
    const c = this.companyCache ?? { owners: [], walletSol: 0, accounts: [], lst: [], stakedSol: 0, lastEpochReward: 0 };
    const principal = this.o.companyPrincipal();
    return {
      epoch: this.epochView(),
      networkApy: this.networkApy,
      validators: this.recommended,
      company: { ...c, principal, rewardsSol: c.stakedSol > 0 ? Math.max(0, c.stakedSol - principal) : 0 },
      includeInAssets: this.includeInAssets,
    };
  }

  validatorName(vote: string) {
    return this.validators.get(vote)?.name;
  }

  // ─── 交易组装 ───────────────────────────────────────────────

  private async simulate(tx: Buffer) {
    const sim = await this.o.rpc.call<any>('simulateTransaction', [tx.toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
    const err = sim?.value?.err;
    if (!err) return;
    const custom = err?.InstructionError?.[1]?.Custom;
    if (custom === 12) throw new Error('低于最低质押额（1 SOL）');
    const logs = ((sim.value.logs ?? []) as string[]).filter((l) => /error|failed|insufficient/i.test(l)).slice(-2).join('；');
    if (/insufficient/i.test(JSON.stringify(err) + logs)) throw new Error('钱包里的 SOL 不够（还要留一点付网络费）');
    throw new Error(`链上模拟失败：${JSON.stringify(err)}${logs ? `（${logs}）` : ''}`);
  }

  async prepare(input: any): Promise<PreparedStakeTx> {
    const action = input?.action;
    const owner = String(input?.owner ?? '').trim();
    if (!isValidPubkey(owner)) throw new Error('钱包地址无效');
    const bh = (await this.o.rpc.call<any>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash as string;

    if (action === 'stake') {
      const vote = String(input?.vote ?? '').trim();
      const v = this.validators.get(vote);
      if (!v) throw new Error('请选择一个验证者');
      if (v.delinquent) throw new Error('这个验证者目前离线，请换一个');
      const amountStr = String(input?.amount ?? '').trim();
      if (!/^\d+(\.\d{1,9})?$/.test(amountStr)) throw new Error('质押数量格式不对');
      const [i, f = ''] = amountStr.split('.');
      const lamports = BigInt(i) * 1_000_000_000n + BigInt(f.padEnd(9, '0'));
      const [minRes, rentRes, bal] = await Promise.all([
        this.o.rpc.call<any>('getStakeMinimumDelegation', [{ commitment: 'confirmed' }]),
        this.o.rpc.call<number>('getMinimumBalanceForRentExemption', [STAKE_SPACE]),
        this.o.rpc.call<any>('getBalance', [owner, { commitment: 'confirmed' }]),
      ]);
      const min = BigInt(minRes?.value ?? 1_000_000_000);
      const rent = BigInt(rentRes);
      if (lamports < min) throw new Error(`最少质押 ${Number(min) / LAMPORTS} SOL`);
      if (BigInt(bal.value) < lamports + rent + 10_000n) {
        throw new Error(`钱包里只有 ${(bal.value / LAMPORTS).toFixed(4)} SOL，质押 ${amountStr} SOL 还需要 ${(Number(rent) / LAMPORTS).toFixed(5)} SOL 押金和一点网络费`);
      }
      const seed = `vk${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
      const { tx, stakeAccount } = buildStakeTx({ owner, vote, lamports: lamports + rent, seed, blockhash: bh });
      await this.simulate(tx);
      return { transaction: tx.toString('base64'), action, stakeAccount, sol: Number(lamports) / LAMPORTS, rent: Number(rent) / LAMPORTS };
    }

    if (action === 'deactivate' || action === 'withdraw') {
      const stake = String(input?.stake ?? '').trim();
      if (!isValidPubkey(stake)) throw new Error('质押账户地址无效');
      const acc = await this.o.rpc.call<any>('getAccountInfo', [stake, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const info = acc?.value?.data?.parsed?.info;
      if (acc?.value?.owner !== STAKE_PROGRAM || !info?.meta) throw new Error('这不是质押账户');
      const auth = info.meta.authorized;
      if (action === 'deactivate') {
        if (auth.staker !== owner) throw new Error('连接的钱包不是这个质押账户的质押权限');
        const d = info.stake?.delegation;
        if (!d || d.deactivationEpoch !== NEVER) throw new Error('这个账户已经在解除质押或没有在质押');
        const tx = buildDeactivateTx({ owner, stake, blockhash: bh });
        await this.simulate(tx);
        return { transaction: tx.toString('base64'), action, stakeAccount: stake, sol: Number(d.stake) / LAMPORTS };
      }
      if (auth.withdrawer !== owner) throw new Error('连接的钱包不是这个质押账户的提取权限');
      const epoch = this.epochView().epoch;
      const d = info.stake?.delegation;
      const lamports = Number(acc.value.lamports);
      const rent = Number(info.meta.rentExemptReserve);
      const st = this.status(d, epoch);
      const can = st === 'inactive' ? lamports : Math.max(0, lamports - rent - Number(d?.stake ?? 0));
      if (can <= 0) throw new Error(st === 'deactivating' ? '还在冷却中，下一期开始后才能提取' : '要先解除质押，等冷却完成后才能提取');
      const tx = buildWithdrawTx({ owner, stake, lamports: BigInt(can), blockhash: bh });
      await this.simulate(tx);
      return { transaction: tx.toString('base64'), action, stakeAccount: stake, sol: can / LAMPORTS };
    }
    throw new HttpError(400, '未知操作');
  }

  /** 交易发出后：清掉相关缓存，几秒后刷新 */
  touch(owner?: string) {
    for (const k of [...this.posCache.keys()]) if (!owner || k.split(',').includes(owner)) this.posCache.delete(k);
    if (!owner || this.o.companyWallets().includes(owner)) setTimeout(() => void this.refreshCompany(), 4_000);
  }
}
