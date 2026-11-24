// ───────────────────────────────────────────────────────────────
//  USVK 模拟盘（虚拟 SOL，不上链、不碰真钱）
//  · 账号：公司（管理员）+ 管理员添加的员工 / 内部客户，各自一个 8 位登录码
//  · 额度：公司 = 公司总资产；员工 / 客户 = 他在「内部质押」里的本金（关联后生效）
//  · 管理员买卖要先输交易密码（解锁 30 分钟）；员工 / 客户登录后直接买卖
//  · 登录：账号 + 密码（admin = 公司账号，只能管模拟盘；VK1–VK12 = 员工），也可以用 8 位登录码
//  · 盘口数学在 shared/sim.ts（App 报价和这里成交用同一套）
// ───────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { defaultSimParams, initialPool, quoteBuy, quoteSell, simCirculating, simPrice, type SimQuote } from '../shared/sim';
import type { SimAccountAdmin, SimHolder, SimKind, SimMe, SimParams, SimPool, SimRoundSummary, SimStats, SimTick, SimTrade, SimView } from '../shared/types';
import { HttpError, type HolderAuth, type Principal } from './access';
import { JsonFile } from './store';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉了容易看错的 0 O 1 I
const COMPANY_ID = 'company';
const MAX_TRADES = 5000;
const VIEW_TRADES = 300;
const UNLOCK_MS = 30 * 60_000;
const MAX_FAILS = 5; // 交易密码每 15 分钟最多输错 5 次
const MIN_BUY = 0.0001;
/** 初始交易密码（scrypt 哈希；管理员可以在模拟盘里修改，改后存在 data/sim/auth.json） */
const DEFAULT_AUTH = { salt: '90fba2dc6d550e26105da8c4750ba08e', hash: '782900d70aee68b504d2032c7558de4b4e514e466654a66f7a6fa4b3d39a3dbd' }; // 初始交易密码 changeme123：首次使用后立即修改
/** 登录系统的初始账号（2026-11-22 按用户要求）：admin + VK1–VK12，初始登录密码统一（scrypt 哈希），登录后可以自己改 */
const SEED_LOGIN = { salt: '0604a55ecf175aa2cdf5fcbc74e04288', hash: '82e2290da4058f1487f52aa4aa3ced7735fa9cc972fa2e0e9e85fe77accb090a' }; // 初始登录密码 changeme123：首次登录后立即修改
const SEED_STAFF = 12;
const USERNAME_RE = /^[a-z0-9_]{2,20}$/;

interface AccountRec {
  id: string;
  name: string;
  kind: SimKind;
  code: string; // 公司账号没有登录码（管理员用管理员密钥登录）
  codeVer: number;
  memberId?: string; // 关联的内部质押员工：额度 = 他的本金
  note?: string;
  createdAt: number;
  username?: string; // 登录账号（小写）
  pwSalt?: string; // 登录密码（scrypt）
  pwHash?: string;
  tokens: number;
  cost: number;
  spent: number;
  received: number;
  realized: number;
  buys: number;
  sells: number;
}

interface TradeRec extends Omit<SimTrade, 'name' | 'kind' | 'me' | 'aid'> {
  aid: string;
}

interface SimFile {
  version: 1;
  params: SimParams;
  round: number;
  startedAt: number;
  pool: SimPool;
  graduatedAt: number | null;
  stats: SimStats;
  accounts: AccountRec[];
  trades: TradeRec[];
  nextTradeId: number;
  past: SimRoundSummary[];
  seeded?: number; // 已经建过初始账号（之后管理员删掉的不会再自动加回来）
}

export interface SimOpts {
  dataDir: string;
  /** 公司总资产（SOL）= 公司的额度 */
  companySol: () => number;
  /** 内部质押：每位员工现在的本金 */
  principals: () => Map<string, { name: string; principal: number }>;
  solUsd: () => number;
}

const emptyStats = (): SimStats => ({ trades: 0, buys: 0, sells: 0, volumeSol: 0, protocolFees: 0, creatorFees: 0, lpFees: 0, athPrice: 0, athAt: 0, athMcap: 0, athMcapAt: 0 });

const resetPosition = (a: AccountRec) => Object.assign(a, { tokens: 0, cost: 0, spent: 0, received: 0, realized: 0, buys: 0, sells: 0 });

/** 名字打码：张三 → 张*，王小明 → 王**，Alice → A** */
export function maskName(name: string): string {
  const chars = [...name.trim()];
  if (!chars.length) return '***';
  return chars[0] + '*'.repeat(Math.max(1, Math.min(2, chars.length - 1)));
}

function scrypt(pw: string, salt: string) {
  return crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}

export class SimMarket extends EventEmitter {
  private file: JsonFile<SimFile>;
  private authFile: string;
  private d: SimFile;
  private pw: { salt: string; hash: string };
  private unlocks = new Map<string, number>(); // 交易密码解锁令牌 → 过期时间（只在内存里，重启后要重新输）
  private fails = new Map<string, number[]>();
  rev = 1;
  /** 新登录码不能和管理员密钥、访问密码、股东查看码、员工登录码撞上（由 index.ts 设置） */
  isReservedCode: (normalized: string) => boolean = () => false;

  constructor(private o: SimOpts) {
    super();
    const dir = path.join(o.dataDir, 'sim');
    this.file = new JsonFile(path.join(dir, 'state.json'), 0);
    this.authFile = path.join(dir, 'auth.json');
    const f = this.file.read();
    const params = f?.params ?? defaultSimParams();
    this.d = {
      version: 1,
      params,
      round: f?.round ?? 1,
      startedAt: f?.startedAt ?? Date.now(),
      pool: f?.pool ?? initialPool(params),
      graduatedAt: f?.graduatedAt ?? null,
      stats: { ...emptyStats(), ...f?.stats },
      accounts: f?.accounts ?? [],
      trades: f?.trades ?? [],
      nextTradeId: f?.nextTradeId ?? 1,
      past: f?.past ?? [],
      seeded: f?.seeded,
    };
    if (!this.d.accounts.some((a) => a.id === COMPANY_ID)) {
      this.d.accounts.unshift(resetPosition({ id: COMPANY_ID, name: '公司', kind: 'admin', code: '', codeVer: 1, createdAt: Date.now() } as AccountRec));
    }
    if (!this.d.seeded) this.seed();
    else if (!f) this.save();
    let auth: { salt: string; hash: string } | null = null;
    try {
      auth = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
    } catch {
      /* 还没改过密码：用初始密码 */
    }
    this.pw = auth?.salt && auth?.hash ? auth : DEFAULT_AUTH;
  }

  private save() {
    this.file.writeNow(this.d);
  }

  /** 初始账号：admin（公司）+ VK1–VK12（员工），只建一次 */
  private seed() {
    const c = this.company;
    if (!c.username) Object.assign(c, { username: 'admin', pwSalt: SEED_LOGIN.salt, pwHash: SEED_LOGIN.hash });
    for (let i = 1; i <= SEED_STAFF; i++) {
      const name = `VK${i}`;
      if (this.d.accounts.some((a) => a.name === name || a.username === name.toLowerCase())) continue;
      this.d.accounts.push(
        resetPosition({ id: crypto.randomBytes(6).toString('hex'), name, kind: 'staff', code: '', codeVer: 1, username: name.toLowerCase(), pwSalt: SEED_LOGIN.salt, pwHash: SEED_LOGIN.hash, createdAt: Date.now() } as AccountRec),
      );
    }
    this.d.seeded = 1;
    this.save();
    console.log('[sim] 已建立初始账号：admin、VK1–VK12');
  }

  /** 模拟盘管理员：用管理员密钥登录的人，或者用 admin 账号登录的人（只能管模拟盘） */
  isSimAdmin(p: Principal) {
    return p.role === 'admin' || (p.role === 'trader' && p.sid === COMPANY_ID);
  }

  private accountOf(p: Principal): AccountRec | undefined {
    if (this.isSimAdmin(p)) return this.company;
    return p.role === 'trader' ? this.d.accounts.find((a) => a.id === p.sid && a.kind !== 'admin') : undefined;
  }

  private setLoginPassword(a: AccountRec, pw: string) {
    const salt = crypto.randomBytes(16).toString('hex');
    a.pwSalt = salt;
    a.pwHash = scrypt(pw, salt);
    a.codeVer++; // 用旧密码登录的设备全部失效
  }

  private cleanUsername(raw: unknown, self?: AccountRec): string | undefined {
    const u = String(raw ?? '').trim().toLowerCase();
    if (!u) return undefined;
    if (!USERNAME_RE.test(u)) throw new Error('账号只能用 2–20 位字母、数字或下划线');
    if (this.d.accounts.some((a) => a !== self && a.username === u)) throw new Error(`账号 ${u} 已经有人用了`);
    return u;
  }

  private cleanLoginPassword(raw: unknown) {
    const pw = String(raw ?? '');
    if (pw.length < 6 || pw.length > 64) throw new Error('登录密码要 6–64 位');
    return pw;
  }

  private changed() {
    this.rev++;
    this.emit('changed', this.rev);
  }

  /** 额度相关的数据（内部质押本金）变了：通知 App 刷新 */
  touch() {
    this.changed();
  }

  private get company() {
    return this.d.accounts.find((a) => a.id === COMPANY_ID)!;
  }

  // ─── 登录码（给 access.ts 用） ───────────────────────────────

  authById(id: string): (HolderAuth & { kind: SimKind }) | undefined {
    // 公司账号只能用 admin 账号 + 密码登录（没有登录码）
    const a = this.d.accounts.find((x) => x.id === id && (x.kind !== 'admin' || !!x.pwHash));
    return a ? { id: a.id, name: a.name, code: a.code, codeVer: a.codeVer, kind: a.kind } : undefined;
  }

  authByCode(code: string): (HolderAuth & { kind: SimKind }) | undefined {
    if (code.length !== 8) return undefined;
    let hit: AccountRec | undefined;
    for (const a of this.d.accounts) if (a.code && crypto.timingSafeEqual(Buffer.from(a.code.padEnd(8)), Buffer.from(code))) hit = a;
    return hit ? this.authById(hit.id) : undefined;
  }

  /** 账号 + 密码登录（账号不分大小写） */
  authByPassword(user: unknown, pw: unknown): (HolderAuth & { kind: SimKind }) | undefined {
    const u = String(user ?? '').trim().toLowerCase().slice(0, 40);
    const a = this.d.accounts.find((x) => !!x.username && x.username === u && !!x.pwHash);
    const given = Buffer.from(scrypt(String(pw ?? '').slice(0, 64), a?.pwSalt ?? DEFAULT_AUTH.salt), 'hex'); // 账号不存在也算一次，防止按耗时猜账号
    if (!a || !crypto.timingSafeEqual(given, Buffer.from(a.pwHash!, 'hex'))) return undefined;
    return this.authById(a.id);
  }

  /** 自己改登录密码（要先输对旧密码）；返回 true = 成功，旧登录全部失效 */
  changeOwnPassword(p: Principal, b: any, ip: string) {
    const a = this.accountOf(p);
    if (!a) throw new HttpError(403, '先登录模拟盘账号');
    const now = Date.now();
    const recent = (this.fails.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= MAX_FAILS) throw new HttpError(429, '输错次数太多，请 15 分钟后再试');
    if (a.pwHash) {
      const given = Buffer.from(scrypt(String(b?.old ?? '').slice(0, 64), a.pwSalt!), 'hex');
      if (!crypto.timingSafeEqual(given, Buffer.from(a.pwHash, 'hex'))) {
        recent.push(now);
        this.fails.set(ip, recent);
        throw new HttpError(403, '旧密码不对');
      }
    }
    this.setLoginPassword(a, this.cleanLoginPassword(b?.next));
    this.save();
    this.changed();
    return { id: a.id };
  }

  private newCode(): string {
    for (;;) {
      const code = [...crypto.randomBytes(8)].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
      if (!this.authByCode(code) && !this.isReservedCode(code)) return code;
    }
  }

  // ─── 交易密码（管理员） ──────────────────────────────────────

  private checkPassword(pw: unknown, ip: string) {
    const now = Date.now();
    const recent = (this.fails.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= MAX_FAILS) throw new HttpError(429, '交易密码输错次数太多，请 15 分钟后再试');
    const given = Buffer.from(scrypt(String(pw ?? '').trim().slice(0, 64), this.pw.salt), 'hex');
    if (!crypto.timingSafeEqual(given, Buffer.from(this.pw.hash, 'hex'))) {
      recent.push(now);
      this.fails.set(ip, recent);
      if (this.fails.size > 1000) this.fails.clear();
      const left = MAX_FAILS - recent.length;
      throw new HttpError(403, left > 0 ? `交易密码不对（还能试 ${left} 次）` : '交易密码不对，请 15 分钟后再试');
    }
    this.fails.delete(ip);
  }

  private unlocked(token: unknown) {
    const t = String(token ?? '');
    const exp = this.unlocks.get(t);
    if (!t || !exp) return false;
    if (exp < Date.now()) {
      this.unlocks.delete(t);
      return false;
    }
    return true;
  }

  // ─── 额度 ───────────────────────────────────────────────────

  private budget(a: AccountRec, principals = this.o.principals()): { source: SimMe['budgetSource']; budget: number; linkedName?: string } {
    if (a.kind === 'admin') return { source: 'company', budget: this.o.companySol() };
    const m = a.memberId ? principals.get(a.memberId) : undefined;
    if (!m) return { source: 'none', budget: 0 };
    return { source: 'staking', budget: m.principal, linkedName: m.name };
  }

  private available(a: AccountRec, budget: number) {
    return Math.max(0, budget - a.spent + a.received);
  }

  // ─── 查看 ───────────────────────────────────────────────────

  private meOf(a: AccountRec, principals: Map<string, { name: string; principal: number }>): Omit<SimMe, 'needPassword'> {
    const b = this.budget(a, principals);
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      budgetSource: b.source,
      budget: b.budget,
      linkedName: b.linkedName,
      available: this.available(a, b.budget),
      tokens: a.tokens,
      cost: a.cost,
      spent: a.spent,
      received: a.received,
      realized: a.realized,
      buys: a.buys,
      sells: a.sells,
    };
  }

  view(p: Principal): SimView {
    const isAdmin = this.isSimAdmin(p);
    const mine = this.accountOf(p);
    const byId = new Map(this.d.accounts.map((a) => [a.id, a]));
    // 公司不打码；别人的名字只有管理员能看全
    const label = (a: AccountRec | undefined) => (!a ? '已删除的账号' : a.kind === 'admin' ? '公司' : isAdmin || a === mine ? a.name : maskName(a.name));
    const holders: SimHolder[] = this.d.accounts
      .filter((a) => a.tokens > 1e-9)
      .sort((x, y) => y.tokens - x.tokens)
      .map((a) => ({ name: label(a), kind: a.kind, tokens: a.tokens, me: a === mine || undefined, aid: isAdmin ? a.id : undefined }));
    const trades: SimTrade[] = this.d.trades
      .slice(-VIEW_TRADES)
      .reverse()
      .map(({ aid, ...t }) => {
        const a = byId.get(aid);
        return { ...t, name: label(a), kind: a?.kind ?? 'client', me: (!!mine && aid === mine.id) || undefined, aid: isAdmin ? aid : undefined };
      });
    const principals = mine || isAdmin ? this.o.principals() : new Map<string, { name: string; principal: number }>();
    const view: SimView = {
      rev: this.rev,
      params: this.d.params,
      round: this.d.round,
      startedAt: this.d.startedAt,
      pool: this.d.pool,
      graduatedAt: this.d.graduatedAt,
      stats: this.d.stats,
      holders,
      holderCount: holders.length,
      trades,
      past: this.d.past.slice(-10).reverse(),
      companySol: this.o.companySol(),
      me: mine ? { ...this.meOf(mine, principals), username: mine.username, needPassword: mine.kind === 'admin' } : null,
    };
    if (isAdmin) {
      view.admin = {
        accounts: this.d.accounts
          .filter((a) => a.kind !== 'admin')
          .map((a): SimAccountAdmin => ({ ...this.meOf(a, principals), username: a.username, hasPassword: !!a.pwHash, code: a.code || undefined, memberId: a.memberId, note: a.note, createdAt: a.createdAt })),
        members: [...principals].map(([id, m]) => ({ id, name: m.name, principal: m.principal })),
      };
    }
    return view;
  }

  /** K 线：这一轮的全部成交（精简格式）。afterId = App 已经有的最后一笔，只返回之后的 */
  ticks(p: Principal, afterId = 0): { startedAt: number; ticks: SimTick[] } {
    const mine = this.accountOf(p)?.id;
    const out: SimTick[] = [];
    let circ = 0;
    for (const t of this.d.trades) {
      const ca = t.circAfter ?? Math.max(0, circ + (t.side === 'buy' ? t.tokens : -t.tokens));
      const cb = Math.max(0, t.side === 'buy' ? ca - t.tokens : ca + t.tokens);
      circ = ca;
      if (t.id <= afterId) continue;
      out.push({ id: t.id, ts: t.ts, side: t.side, sol: t.sol, tokens: t.tokens, pb: t.priceBefore, pa: t.priceAfter, cb, ca, me: (!!mine && t.aid === mine) || undefined, grad: t.graduated });
    }
    return { startedAt: this.d.startedAt, ticks: out };
  }

  // ─── 买卖 ───────────────────────────────────────────────────

  trade(p: Principal, b: any): { trade: SimTrade; view: SimView } {
    const acc = this.accountOf(p);
    if (!acc) throw new HttpError(403, '用模拟盘账号登录后才能买卖');
    if (acc.kind === 'admin' && !this.unlocked(b?.unlock)) throw new HttpError(403, '请先输入交易密码');
    const side = b?.side === 'sell' ? 'sell' : b?.side === 'buy' ? 'buy' : null;
    if (!side) throw new Error('买还是卖？');
    const minOut = Math.max(0, Number(b?.minOut) || 0);
    const { params, pool } = this.d;
    let q: SimQuote;
    if (side === 'buy') {
      const bud = this.budget(acc);
      const avail = this.available(acc, bud.budget);
      if (avail < MIN_BUY) {
        throw new Error(
          bud.source === 'none'
            ? '还没有额度：你的额度 = 你在「内部质押」里的本金，请联系管理员关联'
            : bud.source === 'staking' && bud.budget <= 0
              ? '还没有额度：先在「质押 → 内部质押」里存入 SOL，本金多少额度就是多少'
              : '额度已经用完了（卖出后到手的 SOL 会回到额度里）',
        );
      }
      let spend = b?.all === true ? avail : Number(b?.sol);
      if (!(spend > 0) || !Number.isFinite(spend)) throw new Error('请输入买入金额');
      if (spend < MIN_BUY) throw new Error(`最少买 ${MIN_BUY} SOL`);
      if (spend > avail + 1e-9) throw new Error(`超出可用额度（现在可用 ${avail.toFixed(4)} SOL）`);
      spend = Math.min(spend, avail);
      q = quoteBuy(params, pool, spend);
      if (!(q.tokens > 0)) throw new Error('池子里没有可买的代币了');
      if (q.tokens < minOut) throw new Error('价格变了，超出了你设的滑点，请重新确认');
    } else {
      const pct = Number(b?.pct);
      let tokens = pct > 0 ? (pct >= 100 ? acc.tokens : (acc.tokens * pct) / 100) : Number(b?.tokens);
      if (!(tokens > 0) || !Number.isFinite(tokens)) throw new Error('请输入卖出数量');
      if (tokens > acc.tokens * (1 + 1e-9) + 1e-6) throw new Error(`你只有 ${acc.tokens.toFixed(2)} 枚`);
      tokens = Math.min(tokens, acc.tokens);
      q = quoteSell(params, pool, tokens);
      if (q.sol < minOut) throw new Error('价格变了，超出了你设的滑点，请重新确认');
    }

    // 记账
    this.d.pool = q.after;
    if (side === 'buy') {
      acc.tokens += q.tokens;
      acc.cost += q.sol;
      acc.spent += q.sol;
      acc.buys++;
    } else {
      const share = acc.tokens > 0 ? q.tokens / acc.tokens : 1;
      const costOut = acc.cost * Math.min(1, share);
      acc.cost -= costOut;
      acc.realized += q.sol - costOut;
      acc.tokens -= q.tokens;
      if (acc.tokens < 1e-6) {
        acc.tokens = 0;
        acc.cost = 0;
      }
      acc.received += q.sol;
      acc.sells++;
    }
    const s = this.d.stats;
    s.trades++;
    if (side === 'buy') s.buys++;
    else s.sells++;
    s.volumeSol += side === 'buy' ? q.sol : q.sol + q.fee;
    s.protocolFees += q.protocolFee;
    s.creatorFees += q.creatorFee;
    s.lpFees += q.lpFee;
    const now = Date.now();
    if (q.priceAfter > s.athPrice) {
      s.athPrice = q.priceAfter;
      s.athAt = now;
    }
    const circAfter = simCirculating(params, q.after);
    if (q.priceAfter * circAfter > s.athMcap) {
      s.athMcap = q.priceAfter * circAfter;
      s.athMcapAt = now;
    }
    if (q.graduated && !this.d.graduatedAt) this.d.graduatedAt = now;
    const rec: TradeRec = {
      id: this.d.nextTradeId++,
      ts: now,
      aid: acc.id,
      side,
      venue: q.venue,
      sol: q.sol,
      tokens: q.tokens,
      fee: q.fee,
      priceBefore: q.priceBefore,
      priceAfter: q.priceAfter,
      graduated: q.graduated || undefined,
      solUsd: this.o.solUsd(),
      circAfter,
    };
    this.d.trades.push(rec);
    if (this.d.trades.length > MAX_TRADES) this.d.trades = this.d.trades.slice(-MAX_TRADES);
    this.save();
    this.changed();
    console.log(`[sim] ${acc.name} ${side === 'buy' ? '买入' : '卖出'} ${q.sol.toFixed(4)} SOL / ${q.tokens.toFixed(0)} 枚，现价 ${q.priceAfter.toExponential(4)} SOL${q.graduated ? '（毕业）' : ''}`);
    const view = this.view(p);
    return { trade: view.trades[0], view };
  }

  // ─── 管理员 ─────────────────────────────────────────────────

  private getAccount(id: unknown, allowCompany = false) {
    const a = this.d.accounts.find((x) => x.id === String(id) && (allowCompany || x.kind !== 'admin'));
    if (!a) throw new Error('账号不存在');
    return a;
  }

  private cleanName(raw: unknown, self?: AccountRec) {
    const name = String(raw ?? '').trim().slice(0, 20);
    if (!name) throw new Error('请填写名字');
    if (name === '公司' || this.d.accounts.some((a) => a !== self && a.name === name)) throw new Error(`已经有叫"${name}"的账号了`);
    return name;
  }

  private cleanMember(raw: unknown): string | undefined {
    const id = String(raw ?? '').trim();
    if (!id) return undefined;
    if (!this.o.principals().has(id)) throw new Error('内部质押里没有这个员工');
    return id;
  }

  /** 返回值里 revoke = true：有人的登录码失效了（index.ts 会断开他们的连接） */
  admin(b: any, ip: string): { ok: true; id?: string; code?: string; unlock?: string; expiresAt?: number; revoke?: boolean } {
    switch (b?.action) {
      case 'unlock': {
        this.checkPassword(b.password, ip);
        const token = crypto.randomBytes(18).toString('base64url');
        const expiresAt = Date.now() + UNLOCK_MS;
        for (const [t, exp] of this.unlocks) if (exp < Date.now()) this.unlocks.delete(t);
        this.unlocks.set(token, expiresAt);
        return { ok: true, unlock: token, expiresAt };
      }
      case 'lock':
        this.unlocks.delete(String(b.unlock ?? ''));
        return { ok: true };
      case 'password': {
        this.checkPassword(b.old, ip);
        const next = String(b.next ?? '').trim();
        if (next.length < 6 || next.length > 32) throw new Error('新交易密码要 6–32 位');
        const salt = crypto.randomBytes(16).toString('hex');
        this.pw = { salt, hash: scrypt(next, salt) };
        fs.writeFileSync(this.authFile, JSON.stringify(this.pw), { mode: 0o600 });
        this.unlocks.clear();
        return { ok: true };
      }
      case 'reset': {
        this.checkPassword(b.password, ip);
        const d = this.d;
        if (d.stats.trades > 0) {
          d.past.push({
            round: d.round,
            startedAt: d.startedAt,
            endedAt: Date.now(),
            trades: d.stats.trades,
            traders: new Set(d.trades.map((t) => t.aid)).size,
            volumeSol: d.stats.volumeSol,
            peakPrice: d.stats.athPrice,
            peakMcap: d.stats.athMcap,
            endPrice: simPrice(d.pool),
            graduated: !!d.graduatedAt,
          });
          if (d.past.length > 50) d.past = d.past.slice(-50);
        }
        d.round += d.stats.trades > 0 ? 1 : 0;
        d.startedAt = Date.now();
        d.pool = initialPool(d.params);
        d.graduatedAt = null;
        d.stats = emptyStats();
        d.trades = [];
        for (const a of d.accounts) resetPosition(a);
        this.save();
        this.changed();
        console.log(`[sim] 重新开盘：第 ${d.round} 轮`);
        return { ok: true };
      }
      case 'add': {
        const kind: SimKind = b.kind === 'client' ? 'client' : 'staff';
        const id = crypto.randomBytes(6).toString('hex');
        const code = this.newCode();
        const rec = resetPosition({ id, name: this.cleanName(b.name), kind, code, codeVer: 1, memberId: this.cleanMember(b.memberId), note: String(b.note ?? '').trim().slice(0, 60) || undefined, createdAt: Date.now() } as AccountRec);
        rec.username = this.cleanUsername(b.username);
        if (rec.username) this.setLoginPassword(rec, this.cleanLoginPassword(b.password));
        this.d.accounts.push(rec);
        this.save();
        this.changed();
        return { ok: true, id, code };
      }
      case 'update': {
        const a = this.getAccount(b.id);
        if (b.name !== undefined) a.name = this.cleanName(b.name, a);
        if (b.kind === 'staff' || b.kind === 'client') a.kind = b.kind;
        if (b.memberId !== undefined) a.memberId = this.cleanMember(b.memberId);
        if (b.note !== undefined) a.note = String(b.note ?? '').trim().slice(0, 60) || undefined;
        if (b.username !== undefined) {
          const u = this.cleanUsername(b.username, a);
          if (u && !a.pwHash && !b.password) throw new Error('设账号时要同时设一个登录密码');
          a.username = u;
        }
        if (b.password) this.setLoginPassword(a, this.cleanLoginPassword(b.password));
        this.save();
        this.changed();
        return { ok: true, revoke: !!b.password };
      }
      case 'setpw': {
        // 重置某人的登录密码（公司 admin 账号也可以）
        const a = this.getAccount(b.id, true);
        if (!a.username) throw new Error('这个账号还没有设登录账号');
        this.setLoginPassword(a, this.cleanLoginPassword(b.password));
        this.save();
        this.changed();
        return { ok: true, revoke: true };
      }
      case 'regen': {
        const a = this.getAccount(b.id);
        a.code = this.newCode();
        a.codeVer++;
        this.save();
        this.changed();
        return { ok: true, code: a.code, revoke: true };
      }
      case 'remove': {
        const a = this.getAccount(b.id);
        if (a.tokens > 1e-6) throw new Error(`${a.name} 还持有 ${a.tokens.toFixed(0)} 枚，先让他卖掉，或者重新开盘`);
        this.d.accounts = this.d.accounts.filter((x) => x !== a);
        this.save();
        this.changed();
        return { ok: true, revoke: true };
      }
      default:
        throw new Error('未知操作');
    }
  }
}

