// ───────────────────────────────────────────────────────────────
//  股东名册与分红发放
//  · 每位股东：名字、持股比例、收款钱包、查看码（发给股东，用来登录看自己的分红）
//  · 公司钱包转到股东收款钱包的 SOL → 自动记为分红发放（链上记录，可标记"不是分红"）
//  · 线下发的（例如人民币转账）→ 管理员手动补记
//  · 应得分红 = 分红池（公司总资产 × 分红比例）× 持股比例
// ───────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Payout, Shareholder, ShareholderView } from '../shared/types';
import { HttpError, type HolderAuth, type Principal } from './access';
import type { SolPriceFeed } from './prices';
import { JsonFile } from './store';
import type { Treasury } from './treasury';

interface StoredHolder extends Shareholder {
  code: string; // 规范化的查看码（8 位）
  codeVer: number; // 重新生成查看码时 +1，旧的登录立即失效
}

interface RegistryFile {
  version: 1;
  holders: StoredHolder[];
  manual: Payout[];
  excluded: string[]; // 标记为"不是分红"的链上记录 id
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉了容易看错的 0 O 1 I
const MAX_HOLDERS = 100;
const MAX_WALLETS = 5;
const FRESH_SEC = 15 * 60;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export class Shareholders extends EventEmitter {
  private file: JsonFile<RegistryFile>;
  private data: RegistryFile;
  private rev = 1;
  private chainCache: Payout[] | null = null;
  private seenChain = new Set<string>();
  /** 查看码不能和管理员密钥、访问密码撞上（由 Access 提供） */
  isReservedCode: (normalized: string) => boolean = () => false;
  /** 其他模块占用的钱包（员工钱包、内部质押钱包）不能登记为股东收款地址 */
  forbidWallet: (address: string) => string | null = () => null;

  constructor(
    dataDir: string,
    private treasury: Treasury,
    private prices: SolPriceFeed,
  ) {
    super();
    this.file = new JsonFile(path.join(dataDir, 'shareholders', 'registry.json'), 0);
    const d = this.file.read();
    this.data = { version: 1, holders: d?.holders ?? [], manual: d?.manual ?? [], excluded: d?.excluded ?? [] };
    // 启动时已有的链上分红都算"看过了"；之后新出现的（包括服务重启期间发生的）才推送提醒
    for (const p of this.chainPayouts()) this.seenChain.add(p.id);
    this.chainCache = null;
    // 公司钱包有新流水（或补充了转出明细）：重新匹配分红发放
    treasury.on('ingested', () => this.recheck());
  }

  // ─── 查询 ────────────────────────────────────────────────────

  auth(id: string): HolderAuth | undefined {
    return this.data.holders.find((h) => h.id === id);
  }

  authByCode(code: string): HolderAuth | undefined {
    if (code.length !== 8) return undefined;
    let hit: StoredHolder | undefined;
    for (const h of this.data.holders) if (crypto.timingSafeEqual(Buffer.from(h.code.padEnd(8)), Buffer.from(code))) hit = h;
    return hit;
  }

  totalPct() {
    return round(this.data.holders.reduce((s, h) => s + h.pct, 0), 6);
  }

  get count() {
    return this.data.holders.length;
  }

  /** 链上分红：公司钱包转到股东收款钱包的每一笔 SOL */
  private chainPayouts(): Payout[] {
    if (this.chainCache) return this.chainCache;
    const owner = new Map<string, string>(); // 收款钱包 → 股东 id
    for (const h of this.data.holders) for (const w of h.wallets) owner.set(w, h.id);
    const out: Payout[] = [];
    if (owner.size) {
      for (const a of this.treasury.allActivity()) {
        if (a.failed) continue;
        // 早期流水还没补充转出明细时，先用"转账对方 + SOL 变化"近似
        const outs = a.outs ?? (a.kind === 'out' && a.counterparty ? [{ to: a.counterparty, sol: Math.max(0, -(a.deltaSol + a.fee)) }] : []);
        for (const o of outs) {
          const sid = owner.get(o.to);
          if (!sid || !(o.sol > 0)) continue;
          out.push({ id: `${a.sig}:${o.to}`, sid, ts: a.ts, sol: o.sol, usd: o.sol * (a.solUsd || this.prices.price.usd), source: 'chain', sig: a.sig, wallet: a.wallet, to: o.to });
        }
      }
    }
    this.chainCache = out;
    return out;
  }

  /** 全部发放记录（新 → 旧），带"不是分红"标记 */
  payouts(): Payout[] {
    const ex = new Set(this.data.excluded);
    return [...this.chainPayouts().map((p) => (ex.has(p.id) ? { ...p, excluded: true } : p)), ...this.data.manual].sort(
      (a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /** 按身份返回能看到的内容 */
  view(p: Principal): ShareholderView {
    const base: ShareholderView = { role: p.role, count: 0, totalPct: 0, paidSol: 0, paidUsd: 0, holders: [], payouts: [] };
    if (p.role === 'public') return base;
    const all = this.payouts();
    const counted = all.filter((x) => !x.excluded);
    const agg: ShareholderView = {
      ...base,
      count: this.data.holders.length,
      totalPct: round(this.data.holders.reduce((s, h) => s + h.pct, 0), 6),
      paidSol: counted.reduce((s, x) => s + x.sol, 0),
      paidUsd: counted.reduce((s, x) => s + x.usd, 0),
    };
    if (p.role === 'admin') {
      return { ...agg, holders: this.data.holders.map(({ codeVer: _v, ...h }) => h), payouts: all };
    }
    if (p.role === 'holder') {
      const h = this.data.holders.find((x) => x.id === p.sid);
      if (!h) return agg;
      // 股东只看到自己：不含查看码、管理员备注，也不含被标记"不是分红"的转账
      return {
        ...agg,
        holders: [{ id: h.id, name: h.name, pct: h.pct, wallets: h.wallets, createdAt: h.createdAt }],
        payouts: counted.filter((x) => x.sid === h.id),
      };
    }
    return agg; // 访客：只有合计
  }

  /** 股东累计已收到（折合 SOL） */
  paidTo(sid: string) {
    return this.payouts()
      .filter((x) => x.sid === sid && !x.excluded)
      .reduce((s, x) => s + x.sol, 0);
  }

  nameOf(sid: string) {
    return this.data.holders.find((h) => h.id === sid)?.name;
  }

  /** 全部股东收款钱包（地址投毒识别：骗子最爱冒充你经常转账的地址） */
  allWallets(): string[] {
    return this.data.holders.flatMap((h) => h.wallets);
  }

  /** 收款钱包 → 股东名字（推送提醒里显示"转给 张三"） */
  labelOf(address: string) {
    return this.data.holders.find((h) => h.wallets.includes(address))?.name;
  }

  // ─── 变化检测 ────────────────────────────────────────────────

  private changed(markSeen = false) {
    this.chainCache = null;
    if (markSeen) for (const p of this.chainPayouts()) this.seenChain.add(p.id);
    this.rev++;
    this.emit('changed', this.rev);
  }

  /** 新流水入库后：找出新出现的链上分红（刚发生的才推送提醒） */
  private recheck() {
    this.chainCache = null;
    const list = this.chainPayouts();
    const fresh: Payout[] = [];
    let any = false;
    const nowSec = Date.now() / 1000;
    for (const p of list) {
      if (this.seenChain.has(p.id)) continue;
      this.seenChain.add(p.id);
      any = true;
      if (nowSec - p.ts < FRESH_SEC && !this.data.excluded.includes(p.id)) fresh.push(p);
    }
    if (any) {
      this.rev++;
      this.emit('changed', this.rev);
    }
    if (fresh.length) this.emit('payouts', fresh);
  }

  // ─── 管理 ───────────────────────────────────────────────────

  private save() {
    this.file.writeNow(this.data);
  }

  private newCode(): string {
    for (;;) {
      const code = [...crypto.randomBytes(8)].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
      if (!this.authByCode(code) && !this.isReservedCode(code)) return code;
    }
  }

  private get(id: unknown): StoredHolder {
    const h = this.data.holders.find((x) => x.id === id);
    if (!h) throw new HttpError(404, '股东不存在（可能已被删除）');
    return h;
  }

  /** 校验并整理股东资料 */
  private async clean(input: any, self?: StoredHolder) {
    const name = String(input?.name ?? self?.name ?? '').trim();
    if (!name) throw new Error('请填写股东名字');
    if (name.length > 24) throw new Error('名字最多 24 个字');
    if (this.data.holders.some((h) => h !== self && h.name === name)) throw new Error(`已经有一位叫「${name}」的股东了`);

    const pct = round(Number(input?.pct ?? self?.pct), 4);
    if (!(pct > 0 && pct <= 100)) throw new Error('持股比例需要在 0–100% 之间');
    const others = this.data.holders.filter((h) => h !== self).reduce((s, h) => s + h.pct, 0);
    if (others + pct > 100 + 1e-9) throw new Error(`持股比例合计不能超过 100%：其他股东已占 ${round(others, 4)}%，最多还能填 ${round(100 - others, 4)}%`);

    const rawWallets: string[] = Array.isArray(input?.wallets)
      ? input.wallets.map(String)
      : String(input?.wallets ?? '')
          .split(/[\s,，;；]+/)
          .filter(Boolean);
    const wallets: string[] = [];
    for (const raw of rawWallets.map((w) => w.trim()).filter(Boolean)) {
      const { address } = await this.treasury.normalize(raw); // 校验地址；填的是代币账户时换成它所属的钱包
      if (this.treasury.isCompanyWallet(address)) throw new Error(`${address.slice(0, 6)}… 是公司钱包，不能作为股东收款地址`);
      const why = this.forbidWallet(address);
      if (why) throw new Error(why);
      const other = this.data.holders.find((h) => h !== self && h.wallets.includes(address));
      if (other) throw new Error(`${address.slice(0, 6)}… 已经是「${other.name}」的收款钱包`);
      if (!wallets.includes(address)) wallets.push(address);
    }
    if (wallets.length > MAX_WALLETS) throw new Error(`每位股东最多 ${MAX_WALLETS} 个收款钱包`);

    const note = String(input?.note ?? self?.note ?? '').trim().slice(0, 60) || undefined;
    return { name, pct, wallets, note };
  }

  async add(input: unknown) {
    if (this.data.holders.length >= MAX_HOLDERS) throw new Error(`股东最多 ${MAX_HOLDERS} 位`);
    const c = await this.clean(input);
    const h: StoredHolder = { id: `h_${crypto.randomBytes(5).toString('hex')}`, ...c, code: this.newCode(), codeVer: 1, createdAt: Date.now() };
    this.data.holders.push(h);
    this.save();
    this.changed(true); // 已经发生过的转账不再推送"分红到账"
    return h.id;
  }

  async update(id: unknown, input: unknown) {
    const h = this.get(id);
    Object.assign(h, await this.clean(input, h));
    this.save();
    this.changed(true);
  }

  remove(id: unknown) {
    const h = this.get(id);
    this.data.holders = this.data.holders.filter((x) => x !== h);
    this.data.manual = this.data.manual.filter((p) => p.sid !== h.id);
    this.save();
    this.changed();
  }

  /** 重新生成查看码（旧码登录的设备立即失效） */
  regenerate(id: unknown) {
    const h = this.get(id);
    h.code = this.newCode();
    h.codeVer++;
    this.save();
    this.changed();
  }

  /** 手动补记一笔分红（线下发放）：按发放日期的 SOL 价格折算 */
  async addManual(input: any) {
    const h = this.get(input?.sid);
    const amount = Number(input?.amount);
    if (!(amount > 0 && amount < 1e10)) throw new Error('请填写正确的金额');
    const currency = input?.currency;
    if (currency !== 'cny' && currency !== 'usd' && currency !== 'sol') throw new Error('币种无效');
    const nowSec = Math.floor(Date.now() / 1000);
    const ts = input?.ts === undefined ? nowSec : Math.floor(Number(input.ts));
    if (!(ts >= 1577836800 && ts <= nowSec + 86400)) throw new Error('日期无效');
    if (nowSec - ts > 3600) {
      try {
        await this.prices.loadHistory(ts - 600, ts + 600);
      } catch {
        /* 取不到历史价格就用现价 */
      }
    }
    const solUsd = this.prices.usdAt(ts) || this.prices.price.usd;
    const usdCny = this.prices.price.usdCny;
    if (!(solUsd > 0)) throw new Error('暂时取不到 SOL 价格，请稍后再试');
    const usd = currency === 'usd' ? amount : currency === 'cny' ? amount / usdCny : amount * solUsd;
    const p: Payout = {
      id: `m_${crypto.randomBytes(6).toString('hex')}`,
      sid: h.id,
      ts,
      sol: currency === 'sol' ? amount : usd / solUsd,
      usd,
      source: 'manual',
      amount,
      currency,
      note: String(input?.note ?? '').trim().slice(0, 60) || undefined,
    };
    this.data.manual.push(p);
    this.save();
    this.changed();
    return p.id;
  }

  removeManual(id: unknown) {
    const before = this.data.manual.length;
    this.data.manual = this.data.manual.filter((p) => p.id !== id);
    if (this.data.manual.length === before) throw new HttpError(404, '记录不存在');
    this.save();
    this.changed();
  }

  /** 链上转账标记为"不是分红"（例如报销、借款），或取消标记 */
  setExcluded(id: unknown, excluded: boolean) {
    const key = String(id ?? '');
    if (!this.chainPayouts().some((p) => p.id === key)) throw new HttpError(404, '记录不存在');
    this.data.excluded = this.data.excluded.filter((x) => x !== key);
    if (excluded) this.data.excluded.push(key);
    this.save();
    this.changed();
  }
}
