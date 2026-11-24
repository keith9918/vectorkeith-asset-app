// ───────────────────────────────────────────────────────────────
//  公司内部质押：员工充值 SOL，按管理员设定的年化每天计提分息
//  · 员工充的钱是公司欠员工的，进单独的"内部质押钱包"、单独记账，不计入公司资产（否则股东分红会虚高）
//  · 链上自动记账：员工登记钱包 → 内部质押钱包 = 充值；内部质押钱包 → 员工 = 赎回；公司钱包 → 员工 = 分息
//    （管理员可以改类型、认领陌生地址的充值；用 App 一键发放时按发放时选的类型记）
//  · 线下的（现金、银行转账）由管理员手动补记，按当时的 SOL 价格折算
//  · 分息 = Σ 本金 × 当时年化 × 天数 / 365（单利；年化可以调整，调整前后分段计算）
// ───────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { InternalAccount, InternalProgram, InternalRecord, InternalTotals, InternalView, LedgerType, PreparedTransfer, RedeemRequest, TreasuryActivity } from '../shared/types';
import { HttpError, type HolderAuth, type Principal } from './access';
import type { SolPriceFeed } from './prices';
import type { RpcHttp } from './rpc';
import { isValidPubkey } from './solana';
import { buildTransfersTx } from './staketx';
import { JsonFile } from './store';
import type { Treasury } from './treasury';

interface MemberRec {
  id: string;
  name: string;
  wallets: string[];
  note?: string;
  code: string;
  codeVer: number;
  createdAt: number;
}

interface ManualRec {
  id: string;
  mid: string;
  ts: number;
  type: LedgerType;
  sol: number;
  usd: number;
  amount: number;
  currency: 'cny' | 'usd' | 'sol';
  note?: string;
}

interface FileData {
  version: 1;
  config: { enabled: boolean; name: string; poolWallet: string | null; rates: { from: number; apr: number }[]; minDeposit: number; lockDays: number; payoutNote: string };
  members: MemberRec[];
  manual: ManualRec[];
  overrides: Record<string, { type: LedgerType | 'ignore'; mid?: string }>;
  intents: Record<string, { to: string; type: LedgerType }[]>; // 交易签名 → 发放时选的类型
  requests: RedeemRequest[];
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const YEAR = 365 * 86400;
const FRESH_SEC = 15 * 60;
const MAX_ITEMS = 15; // 一笔交易最多转给 15 个地址（交易大小限制）
const round = (v: number, d = 9) => Math.round(v * 10 ** d) / 10 ** d;

export interface InternalEvent {
  mid?: string;
  member?: { title: string; body: string };
  admin?: { title: string; body: string };
}

interface Opts {
  dataDir: string;
  rpc: RpcHttp;
  prices: SolPriceFeed;
  company: Treasury; // 公司钱包流水（找发给员工的分息）
  pool: Treasury; // 内部质押钱包的流水（单独的实例，不计入公司资产）
  poolStaked: (wallet: string) => Promise<number>; // 资金池里拿去质押的 SOL
  isForbiddenWallet: (address: string) => string | null; // 公司钱包 / 股东钱包不能登记为员工钱包
  warn: (label: string, e: unknown) => void;
}

export class Internal extends EventEmitter {
  private file: JsonFile<FileData>;
  private d: FileData;
  rev = 1;
  private seen = new Set<string>();
  private chainCache: InternalRecord[] | null = null;
  /** 新的登录码不能和股东查看码、管理员密钥、访问密码撞上 */
  isReservedCode: (normalized: string) => boolean = () => false;

  constructor(private o: Opts) {
    super();
    this.file = new JsonFile(path.join(o.dataDir, 'internal', 'ledger.json'), 0);
    const f = this.file.read();
    this.d = {
      version: 1,
      config: {
        enabled: f?.config?.enabled ?? false,
        name: f?.config?.name ?? '公司内部质押',
        poolWallet: f?.config?.poolWallet ?? null,
        rates: f?.config?.rates?.length ? f.config.rates : [{ from: 0, apr: 5 }],
        minDeposit: f?.config?.minDeposit ?? 1,
        lockDays: f?.config?.lockDays ?? 30,
        payoutNote: f?.config?.payoutNote ?? '每月 1 号发放上个月的分息',
      },
      members: f?.members ?? [],
      manual: f?.manual ?? [],
      overrides: f?.overrides ?? {},
      intents: f?.intents ?? {},
      requests: f?.requests ?? [],
    };
    for (const r of this.chainRecords()) this.seen.add(r.id);
    this.chainCache = null;
    const re = () => this.recheck();
    o.pool.on('ingested', re);
    o.company.on('ingested', re);
  }

  get poolWallet() {
    return this.d.config.poolWallet;
  }

  private save() {
    this.file.writeNow(this.d);
  }

  private changed() {
    this.chainCache = null;
    this.rev++;
    this.emit('changed', this.rev);
  }

  // ─── 登录码 ─────────────────────────────────────────────────

  auth(id: string): HolderAuth | undefined {
    return this.d.members.find((m) => m.id === id);
  }

  authByCode(code: string): HolderAuth | undefined {
    if (code.length !== 8) return undefined;
    let hit: MemberRec | undefined;
    for (const m of this.d.members) if (crypto.timingSafeEqual(Buffer.from(m.code.padEnd(8)), Buffer.from(code))) hit = m;
    return hit;
  }

  allWallets() {
    return this.d.members.flatMap((m) => m.wallets);
  }

  /** USVK 模拟盘：每位员工现在的本金（模拟盘按它给同样多的虚拟额度） */
  principals(): Map<string, { name: string; principal: number }> {
    const records = this.allRecords();
    return new Map(this.d.members.map((m) => [m.id, { name: m.name, principal: this.account(m, records, false).principal }]));
  }

  private newCode(): string {
    for (;;) {
      const code = [...crypto.randomBytes(8)].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
      if (!this.authByCode(code) && !this.isReservedCode(code)) return code;
    }
  }

  // ─── 年化 ───────────────────────────────────────────────────

  private aprAt(t: number) {
    let apr = 0;
    for (const r of this.d.config.rates) if (r.from <= t) apr = r.apr;
    return apr;
  }

  get apr() {
    return this.aprAt(Date.now() / 1000);
  }

  // ─── 链上记录 ───────────────────────────────────────────────

  private memberOf(address: string) {
    return this.d.members.find((m) => m.wallets.includes(address));
  }

  private chainRecords(): InternalRecord[] {
    if (this.chainCache) return this.chainCache;
    const out: InternalRecord[] = [];
    const pool = this.d.config.poolWallet;
    const usd = (a: TreasuryActivity, sol: number) => sol * (a.solUsd || this.o.prices.price.usd);
    const push = (a: TreasuryActivity, id: string, addr: string, sol: number, from: 'pool' | 'company', auto: LedgerType) => {
      const ov = this.d.overrides[id];
      const intent = this.d.intents[a.sig]?.find((x) => x.to === addr)?.type;
      const m = ov?.mid ? this.d.members.find((x) => x.id === ov.mid) : this.memberOf(addr);
      const type = ov && ov.type !== 'ignore' ? ov.type : (intent ?? auto);
      out.push({ id, ts: a.ts, type, sol, usd: usd(a, sol), source: 'chain', sig: a.sig, from, addr, mid: m?.id, name: m?.name, auto: !ov && !intent, ignored: ov?.type === 'ignore' || undefined });
    };
    if (pool) {
      for (const a of this.o.pool.allActivity()) {
        if (a.failed || a.wallet !== pool) continue;
        // 转进资金池 = 充值（转出方就是员工的钱包）
        if (a.kind === 'in' && a.deltaSol > 0 && !a.dust && a.counterparty) push(a, `${a.sig}:in`, a.counterparty, a.deltaSol, 'pool', 'deposit');
        // 资金池转给员工 = 赎回（默认）
        for (const o of a.outs ?? []) if (this.memberOf(o.to)) push(a, `${a.sig}:${o.to}`, o.to, o.sol, 'pool', 'withdraw');
      }
    }
    // 公司钱包转给员工 = 分息（默认）。登记成员工之前的转账（工资、报销等）不算
    for (const a of this.o.company.allActivity()) {
      if (a.failed) continue;
      for (const o of a.outs ?? []) {
        const m = this.memberOf(o.to);
        if (m && a.ts * 1000 >= m.createdAt - 60_000) push(a, `${a.sig}:${o.to}`, o.to, o.sol, 'company', 'interest');
      }
    }
    this.chainCache = out;
    return out;
  }

  private allRecords(): InternalRecord[] {
    const manual: InternalRecord[] = this.d.manual.map((m) => ({
      id: m.id,
      ts: m.ts,
      type: m.type,
      sol: m.sol,
      usd: m.usd,
      source: 'manual',
      mid: m.mid,
      name: this.d.members.find((x) => x.id === m.mid)?.name,
      note: m.note,
      amount: m.amount,
      currency: m.currency,
    }));
    return [...this.chainRecords(), ...manual].sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
  }

  /** 新入库的链上记录：刚发生的推送提醒 */
  private recheck() {
    this.chainCache = null;
    const now = Date.now() / 1000;
    let any = false;
    const events: InternalEvent[] = [];
    for (const r of this.chainRecords()) {
      if (this.seen.has(r.id)) continue;
      this.seen.add(r.id);
      any = true;
      if (now - r.ts > FRESH_SEC || r.ignored) continue;
      const sol = `${r.sol.toFixed(4)} SOL`;
      if (r.type === 'deposit') {
        events.push(
          r.mid
            ? { mid: r.mid, member: { title: `充值到账 +${sol}`, body: `${this.d.config.name}：本金已增加，从现在开始按年化 ${this.apr}% 计算分息` }, admin: { title: `员工充值：${r.name} +${sol}`, body: `${this.d.config.name} 收到充值` } }
            : { admin: { title: `内部质押钱包收到 +${sol}`, body: `来自未登记的地址 ${r.addr?.slice(0, 4)}…${r.addr?.slice(-4)}，请在质押页认领给员工` } },
        );
      } else if (r.mid) {
        events.push({ mid: r.mid, member: { title: `${r.type === 'interest' ? '分息' : '赎回'}到账 +${sol}`, body: r.type === 'interest' ? `${this.d.config.name} 的分息已发到你的钱包` : '本金已退回你的钱包' } });
      }
    }
    if (any) this.changed();
    if (events.length) this.emit('events', events);
  }

  // ─── 账户计算 ───────────────────────────────────────────────

  private account(m: MemberRec, records: InternalRecord[], withAdmin: boolean): InternalAccount {
    const mine = records.filter((r) => r.mid === m.id && !r.ignored);
    const now = Date.now() / 1000;
    // 本金变化（按时间）
    const evs = mine
      .filter((r) => r.type !== 'interest')
      .map((r) => ({ ts: r.ts, d: r.type === 'deposit' ? r.sol : -r.sol }))
      .sort((a, b) => a.ts - b.ts);
    // 分段计息：断点 = 本金变化 + 年化调整
    const points = [...new Set([...evs.map((e) => e.ts), ...this.d.config.rates.map((r) => r.from).filter((t) => evs.length && t > evs[0].ts && t < now)])].sort((a, b) => a - b);
    let principal = 0;
    let accrued = 0;
    let k = 0;
    for (let i = 0; i < points.length; i++) {
      const t = points[i];
      while (k < evs.length && evs[k].ts <= t) principal = Math.max(0, principal + evs[k++].d);
      const next = i + 1 < points.length ? points[i + 1] : now;
      if (next > t && principal > 0) accrued += (principal * this.aprAt(t)) / 100 * ((next - t) / YEAR);
    }
    // 锁定：最近 lockDays 天内的充值不能赎回（先进先出）
    const lockFrom = now - this.d.config.lockDays * 86400;
    const recentDeposits = mine.filter((r) => r.type === 'deposit' && r.ts > lockFrom);
    const locked = Math.min(principal, recentDeposits.reduce((s, r) => s + r.sol, 0));
    const nextUnlock = recentDeposits.length ? Math.min(...recentDeposits.map((r) => r.ts)) + this.d.config.lockDays * 86400 : undefined;
    const paid = mine.filter((r) => r.type === 'interest').reduce((s, r) => s + r.sol, 0);
    const requests = this.d.requests.filter((r) => r.mid === m.id).sort((a, b) => b.ts - a.ts);
    return {
      id: m.id,
      name: m.name,
      wallets: m.wallets,
      note: withAdmin ? m.note : undefined,
      code: withAdmin ? m.code : undefined,
      principal: round(principal),
      locked: round(locked),
      available: round(Math.max(0, principal - locked)),
      nextUnlock,
      accrued: round(accrued),
      paid: round(paid),
      unpaid: round(Math.max(0, accrued - paid)),
      daily: (principal * this.apr) / 100 / 365,
      pendingRedeem: requests.filter((r) => r.status === 'pending').reduce((s, r) => s + r.sol, 0),
      records: records.filter((r) => r.mid === m.id),
      requests,
    };
  }

  private program(withWallet: boolean, withAdmin: boolean): InternalProgram {
    const c = this.d.config;
    return { enabled: c.enabled, name: c.name, apr: this.apr, minDeposit: c.minDeposit, lockDays: c.lockDays, payoutNote: c.payoutNote, poolWallet: withWallet ? (c.poolWallet ?? undefined) : undefined, rates: withAdmin ? c.rates : undefined };
  }

  async view(p: Principal): Promise<InternalView> {
    const records = this.allRecords();
    if (p.role === 'admin') {
      const members = this.d.members.map((m) => this.account(m, records, true));
      const sum = (k: keyof InternalAccount) => members.reduce((s, a) => s + (a[k] as number), 0);
      const pool = this.d.config.poolWallet;
      const poolWalletSol = pool ? this.o.pool.walletSol : 0;
      const poolStakedSol = pool ? await this.o.poolStaked(pool).catch(() => 0) : 0;
      const owed = sum('principal') + sum('unpaid');
      const totals: InternalTotals = {
        members: members.length,
        principal: sum('principal'),
        accrued: sum('accrued'),
        paid: sum('paid'),
        unpaid: sum('unpaid'),
        daily: sum('daily'),
        poolWalletSol,
        poolStakedSol,
        coverage: owed > 0 ? (poolWalletSol + poolStakedSol) / owed : null,
      };
      const names = new Map(this.d.members.map((m) => [m.id, m.name]));
      return {
        role: p.role,
        program: this.program(true, true),
        totals,
        members,
        unassigned: records.filter((r) => r.type === 'deposit' && !r.mid && r.source === 'chain'),
        requests: [...this.d.requests].sort((a, b) => b.ts - a.ts).map((r) => ({ ...r, name: names.get(r.mid) })),
        records,
      };
    }
    if (p.role === 'member') {
      const m = this.d.members.find((x) => x.id === p.sid);
      return { role: p.role, program: this.program(true, false), me: m ? this.account(m, records, false) : undefined };
    }
    return { role: p.role, program: this.program(false, false) };
  }

  // ─── 管理 ───────────────────────────────────────────────────

  private async cleanWallets(raw: unknown, self?: MemberRec): Promise<string[]> {
    const list = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[\s,，;；]+/)).map((x) => x.trim()).filter(Boolean);
    const out: string[] = [];
    for (const w of list) {
      if (!isValidPubkey(w)) throw new Error(`无效地址：${w}`);
      const why = this.o.isForbiddenWallet(w);
      if (why) throw new Error(why);
      if (w === this.d.config.poolWallet) throw new Error('这是内部质押钱包本身，不能登记为员工钱包');
      const other = this.d.members.find((m) => m !== self && m.wallets.includes(w));
      if (other) throw new Error(`${w.slice(0, 6)}… 已经是「${other.name}」的钱包`);
      if (!out.includes(w)) out.push(w);
    }
    if (out.length > 3) throw new Error('每位员工最多登记 3 个钱包');
    return out;
  }

  private getMember(id: unknown) {
    const m = this.d.members.find((x) => x.id === id);
    if (!m) throw new HttpError(404, '员工不存在（可能已被删除）');
    return m;
  }

  async admin(b: any): Promise<{ ok: true; id?: string }> {
    switch (b?.action) {
      case 'config': {
        const c = this.d.config;
        if (b.name !== undefined) c.name = String(b.name).trim().slice(0, 24) || '公司内部质押';
        if (b.minDeposit !== undefined) {
          const v = Number(b.minDeposit);
          if (!(v >= 0 && v <= 1e6)) throw new Error('最低充值金额无效');
          c.minDeposit = v;
        }
        if (b.lockDays !== undefined) {
          const v = Math.floor(Number(b.lockDays));
          if (!(v >= 0 && v <= 3650)) throw new Error('锁定天数无效');
          c.lockDays = v;
        }
        if (b.payoutNote !== undefined) c.payoutNote = String(b.payoutNote).trim().slice(0, 60);
        if (b.apr !== undefined) {
          const v = Number(b.apr);
          if (!(v >= 0 && v <= 100)) throw new Error('年化需要在 0–100% 之间');
          if (v !== this.apr) c.rates.push({ from: Math.floor(Date.now() / 1000), apr: v }); // 从现在起按新年化计算，之前的不变
        }
        if (b.poolWallet !== undefined) {
          const w = String(b.poolWallet ?? '').trim();
          if (w) {
            if (!isValidPubkey(w)) throw new Error('内部质押钱包地址无效');
            const why = this.o.isForbiddenWallet(w);
            if (why) throw new Error(why.replace('员工', '内部质押'));
            if (this.memberOf(w)) throw new Error('这是员工登记的钱包，不能作为内部质押钱包');
          }
          c.poolWallet = w || null;
          await this.o.pool.updateConfig({ companyWallets: w ? [{ address: w, label: '内部质押钱包' }] : [] });
        }
        if (b.enabled !== undefined) {
          if (b.enabled && !c.poolWallet) throw new Error('请先设置内部质押钱包');
          c.enabled = !!b.enabled;
        }
        break;
      }
      case 'add-member': {
        if (this.d.members.length >= 300) throw new Error('员工最多 300 位');
        const name = String(b.name ?? '').trim();
        if (!name || name.length > 24) throw new Error('请填写员工名字（最多 24 个字）');
        if (this.d.members.some((m) => m.name === name)) throw new Error(`已经有一位叫「${name}」的员工了`);
        const m: MemberRec = { id: `e_${crypto.randomBytes(5).toString('hex')}`, name, wallets: await this.cleanWallets(b.wallets), note: String(b.note ?? '').trim().slice(0, 60) || undefined, code: this.newCode(), codeVer: 1, createdAt: Date.now() };
        this.d.members.push(m);
        this.save();
        this.changed();
        for (const r of this.chainRecords()) this.seen.add(r.id); // 已经发生过的转账不再推送提醒
        return { ok: true, id: m.id };
      }
      case 'update-member': {
        const m = this.getMember(b.id);
        if (b.name !== undefined) {
          const name = String(b.name).trim();
          if (!name || name.length > 24) throw new Error('名字无效');
          if (this.d.members.some((x) => x !== m && x.name === name)) throw new Error(`已经有一位叫「${name}」的员工了`);
          m.name = name;
        }
        if (b.wallets !== undefined) m.wallets = await this.cleanWallets(b.wallets, m);
        if (b.note !== undefined) m.note = String(b.note).trim().slice(0, 60) || undefined;
        this.chainCache = null;
        for (const r of this.chainRecords()) this.seen.add(r.id);
        break;
      }
      case 'remove-member': {
        const m = this.getMember(b.id);
        const acc = this.account(m, this.allRecords(), false);
        if (acc.principal > 1e-6 || acc.unpaid > 1e-6) throw new Error(`${m.name} 还有本金 ${acc.principal.toFixed(4)} SOL、待发分息 ${acc.unpaid.toFixed(6)} SOL，结清后才能删除`);
        this.d.members = this.d.members.filter((x) => x !== m);
        this.d.manual = this.d.manual.filter((r) => r.mid !== m.id);
        this.d.requests = this.d.requests.filter((r) => r.mid !== m.id);
        break;
      }
      case 'regen': {
        const m = this.getMember(b.id);
        m.code = this.newCode();
        m.codeVer++;
        break;
      }
      case 'manual': {
        const m = this.getMember(b.mid);
        const type = b.type as LedgerType;
        if (!['deposit', 'withdraw', 'interest'].includes(type)) throw new Error('类型无效');
        const amount = Number(b.amount);
        if (!(amount > 0 && amount < 1e10)) throw new Error('请填写正确的金额');
        const currency = b.currency;
        if (!['cny', 'usd', 'sol'].includes(currency)) throw new Error('币种无效');
        const nowSec = Math.floor(Date.now() / 1000);
        const ts = b.ts === undefined ? nowSec : Math.floor(Number(b.ts));
        if (!(ts >= 1577836800 && ts <= nowSec + 86400)) throw new Error('日期无效');
        if (nowSec - ts > 3600) await this.o.prices.loadHistory(ts - 600, ts + 600).catch(() => {});
        const solUsd = this.o.prices.usdAt(ts) || this.o.prices.price.usd;
        if (!(solUsd > 0)) throw new Error('暂时取不到 SOL 价格，请稍后再试');
        const usd = currency === 'usd' ? amount : currency === 'cny' ? amount / this.o.prices.price.usdCny : amount * solUsd;
        const rec: ManualRec = { id: `m_${crypto.randomBytes(6).toString('hex')}`, mid: m.id, ts, type, sol: currency === 'sol' ? amount : usd / solUsd, usd, amount, currency, note: String(b.note ?? '').trim().slice(0, 60) || undefined };
        this.d.manual.push(rec);
        this.save();
        this.changed();
        return { ok: true, id: rec.id };
      }
      case 'remove-manual': {
        const before = this.d.manual.length;
        this.d.manual = this.d.manual.filter((r) => r.id !== b.id);
        if (this.d.manual.length === before) throw new HttpError(404, '记录不存在');
        break;
      }
      case 'override': {
        // 改链上记录的类型 / 认领给某位员工 / 不计入；type = 'auto' 恢复自动判断
        const id = String(b.id ?? '');
        if (!this.chainRecords().some((r) => r.id === id)) throw new HttpError(404, '记录不存在');
        if (b.type === 'auto') delete this.d.overrides[id];
        else {
          if (!['deposit', 'withdraw', 'interest', 'ignore'].includes(b.type)) throw new Error('类型无效');
          if (b.mid) this.getMember(b.mid);
          this.d.overrides[id] = { type: b.type, mid: b.mid || this.d.overrides[id]?.mid };
        }
        break;
      }
      case 'request': {
        const r = this.d.requests.find((x) => x.id === b.id);
        if (!r) throw new HttpError(404, '申请不存在');
        if (b.status !== 'done' && b.status !== 'cancelled') throw new Error('状态无效');
        r.status = b.status;
        r.doneAt = Date.now();
        break;
      }
      default:
        throw new Error('未知操作');
    }
    this.save();
    this.changed();
    return { ok: true };
  }

  /** 员工申请赎回（本金）：管理员处理后转回 */
  requestRedeem(p: Principal, b: any) {
    if (p.role !== 'member' || !p.sid) throw new HttpError(403, '员工登录后才能申请');
    const m = this.getMember(p.sid);
    if (b?.cancel) {
      const r = this.d.requests.find((x) => x.id === b.cancel && x.mid === m.id && x.status === 'pending');
      if (!r) throw new HttpError(404, '申请不存在');
      r.status = 'cancelled';
      r.doneAt = Date.now();
    } else {
      const acc = this.account(m, this.allRecords(), false);
      const sol = Number(b?.sol);
      if (!(sol > 0)) throw new Error('请填写赎回数量');
      if (sol > acc.available - acc.pendingRedeem + 1e-9) throw new Error(`最多能申请 ${Math.max(0, acc.available - acc.pendingRedeem).toFixed(4)} SOL（锁定期内的充值暂时不能赎回）`);
      const r: RedeemRequest = { id: `r_${crypto.randomBytes(5).toString('hex')}`, mid: m.id, ts: Math.floor(Date.now() / 1000), sol, status: 'pending', note: String(b?.note ?? '').trim().slice(0, 60) || undefined };
      this.d.requests.push(r);
      this.emit('events', [{ admin: { title: `赎回申请：${m.name} ${sol.toFixed(4)} SOL`, body: `${this.d.config.name}：请在质押页处理` } }] satisfies InternalEvent[]);
    }
    this.save();
    this.changed();
    return { ok: true };
  }

  // ─── 交易 ───────────────────────────────────────────────────

  private async simulate(tx: Buffer) {
    const sim = await this.o.rpc.call<any>('simulateTransaction', [tx.toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
    const err = sim?.value?.err;
    if (!err) return;
    const logs = ((sim.value.logs ?? []) as string[]).join(' ');
    if (/insufficient/i.test(JSON.stringify(err) + logs) || JSON.stringify(err).includes('"Custom":1')) throw new Error('钱包里的 SOL 不够（还要留一点付网络费）');
    throw new Error(`链上模拟失败：${JSON.stringify(err)}`);
  }

  private lamports(sol: number) {
    if (!(sol > 0)) throw new Error('金额无效');
    return BigInt(Math.round(sol * 1e9));
  }

  async prepare(p: Principal, b: any): Promise<PreparedTransfer> {
    const owner = String(b?.owner ?? '').trim();
    if (!isValidPubkey(owner)) throw new Error('钱包地址无效');
    const bh = (await this.o.rpc.call<any>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash as string;
    const c = this.d.config;

    if (b?.action === 'deposit') {
      if (!c.enabled || !c.poolWallet) throw new Error('内部质押还没有开放');
      const m = this.memberOf(owner);
      if (!m) throw new Error('这个钱包没有登记：请用你登记的钱包充值，否则无法自动记到你名下（可以请管理员帮你登记）');
      if (p.role === 'member' && m.id !== p.sid) throw new Error('这个钱包登记在别的员工名下');
      if (p.role !== 'member' && p.role !== 'admin') throw new HttpError(403, '员工登录后才能充值');
      const sol = Number(b.sol);
      if (!(sol >= c.minDeposit)) throw new Error(`最低充值 ${c.minDeposit} SOL`);
      const tx = buildTransfersTx({ owner, items: [{ to: c.poolWallet, lamports: this.lamports(sol) }], blockhash: bh });
      await this.simulate(tx);
      return { transaction: tx.toString('base64'), items: [{ to: c.poolWallet, sol, type: 'deposit', mid: m.id }] };
    }

    if (b?.action === 'payout') {
      if (p.role !== 'admin') throw new HttpError(403, '只有管理员可以发放');
      const items: PreparedTransfer['items'] = [];
      for (const it of Array.isArray(b.items) ? b.items : []) {
        const m = this.getMember(it.mid);
        const to = String(it.to || m.wallets[0] || '');
        if (!m.wallets.includes(to)) throw new Error(`${m.name} 没有登记钱包，只能线下发放后手动补记`);
        const sol = Number(it.sol);
        if (!(sol >= 0.000001)) continue;
        const type = it.type === 'withdraw' ? 'withdraw' : 'interest';
        items.push({ to, sol: round(sol), type, mid: m.id });
      }
      if (!items.length) throw new Error('没有需要发放的金额');
      if (items.length > MAX_ITEMS) throw new Error(`一次最多发给 ${MAX_ITEMS} 个人，请分批发放`);
      const tx = buildTransfersTx({ owner, items: items.map((x) => ({ to: x.to, lamports: this.lamports(x.sol) })), blockhash: bh });
      await this.simulate(tx);
      return { transaction: tx.toString('base64'), items };
    }
    throw new HttpError(400, '未知操作');
  }

  /** 管理员用 App 发放后：记下这笔交易每个收款人的类型（分息 / 赎回），链上记录出现时按它归类 */
  sent(p: Principal, b: any) {
    const sig = String(b?.sig ?? '');
    if (p.role !== 'admin' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return { ok: true };
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ITEMS).map((x: any) => ({ to: String(x.to), type: x.type === 'withdraw' ? ('withdraw' as const) : ('interest' as const) }));
    this.d.intents[sig] = items;
    const keys = Object.keys(this.d.intents);
    if (keys.length > 2000) delete this.d.intents[keys[0]];
    this.save();
    this.changed();
    return { ok: true };
  }
}
