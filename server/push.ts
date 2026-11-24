// ───────────────────────────────────────────────────────────────
//  手机推送提醒
//  · 每台设备在 App 里开启后登记一个订阅（iPhone 需要先把 App 添加到主屏幕，iOS 16.4+）
//  · 触发：公司钱包转入/转出（≥ 设定金额）、买卖代币、地址投毒、分红发放、总资产低于设定值
//  · 3 秒内的多笔变动合并成一条，避免连续刷屏
//  · 每次发送前重新校验订阅时的登录身份：改访问密码、删除股东后自动停止给对方推送
// ───────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GoalView, Payout, PushPrefs, PushSettings, TreasuryActivity } from '../shared/types';
import { HttpError, type Access, type Principal } from './access';
import type { Unlock } from './achievements';
import type { InternalEvent } from './internal';
import { JsonFile } from './store';
import { generateVapidKeys, isPushEndpoint, sendPush, type VapidKeys } from './webpush';

interface Sub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  token?: string; // 订阅时的登录令牌
  prefs: PushPrefs;
  subject: string; // VAPID 联系方式：App 网址
  device?: string;
  createdAt: number;
  lastOkAt?: number;
  fails: number;
}

interface PushConfig {
  minSol: number;
  lowSol: number;
}

type Ev =
  | { kind: 'flow' | 'trade' | 'poison'; a: TreasuryActivity }
  | { kind: 'payout'; p: Payout }
  | { kind: 'low'; total: number }
  | { kind: 'badge'; u: Unlock }
  | { kind: 'internal'; e: InternalEvent }
  | { kind: 'goal'; g: GoalView; total: number };

interface Msg {
  title: string;
  body: string;
  url: string;
  tag: string;
  urgency?: 'normal' | 'high';
}

export interface PushContext {
  solTo: () => { usd: number; cny: number }; // 1 SOL 折合
  totalSol: () => number;
  /** 地址 → 名字（公司钱包、股东收款钱包、以前登记过的自己人钱包） */
  labelOf: (address: string) => string | undefined;
  holderName: (sid: string) => string | undefined;
  holderPaid: (sid: string) => number;
  warn: (label: string, e: unknown) => void;
}

export const DEFAULT_PREFS: PushPrefs = { flow: true, trade: false, poison: true, payout: true, badge: true };
const MAX_SUBS = 500;

// ─── 文案格式 ─────────────────────────────────────────────────
const num = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
// 极小金额（投毒常用 0.000001 SOL）显示到最后一位有效数字，不要显示成 0.0000
const solAmt = (v: number, signed = false) => {
  const x = Math.abs(v);
  const body = x > 0 && x < 0.0001 ? x.toFixed(9).replace(/0+$/, '') : num(x, 4);
  return `${signed ? (v > 0 ? '+' : v < 0 ? '−' : '') : ''}${body} SOL`;
};
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
function compact(v: number) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(a / 1e3).toFixed(2)}K`;
  return num(a, a >= 100 ? 0 : 2);
}

export class Push {
  private vapid: VapidKeys;
  private subsFile: JsonFile<Sub[]>;
  private cfgFile: JsonFile<PushConfig>;
  private subs: Sub[];
  config: PushConfig;
  private queue: Ev[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lowInit = false;
  private lowArmed = true;

  constructor(
    dataDir: string,
    private access: Access,
    private ctx: PushContext,
  ) {
    const dir = path.join(dataDir, 'push');
    fs.mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, 'vapid.json');
    let keys: VapidKeys | null = null;
    try {
      keys = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    } catch {
      /* 第一次启动 */
    }
    if (!keys?.publicKey || !keys?.privateKey) {
      keys = generateVapidKeys();
      fs.writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
    }
    this.vapid = keys;
    this.subsFile = new JsonFile(path.join(dir, 'subs.json'), 1_000);
    this.cfgFile = new JsonFile(path.join(dir, 'config.json'), 0);
    this.subs = this.subsFile.read() ?? [];
    const cfg = this.cfgFile.read();
    this.config = { minSol: cfg?.minSol ?? 1, lowSol: cfg?.lowSol ?? 0 };
  }

  get publicKey() {
    return this.vapid.publicKey;
  }

  private save() {
    this.subsFile.writeSoon(() => this.subs);
  }

  // ─── 订阅管理 ────────────────────────────────────────────────

  private find(endpoint: unknown) {
    return this.subs.find((s) => s.endpoint === String(endpoint ?? ''));
  }

  private cleanPrefs(raw: any): Partial<PushPrefs> {
    const out: Partial<PushPrefs> = {};
    for (const k of Object.keys(DEFAULT_PREFS) as (keyof PushPrefs)[]) if (typeof raw?.[k] === 'boolean') out[k] = raw[k];
    return out;
  }

  /** 登记或更新订阅（同一台设备再次调用 = 修改提醒类型） */
  subscribe(input: any, who: Principal, subject: string, device?: string): { prefs: PushPrefs } {
    if (!this.access.canView(who)) throw new HttpError(401, '需要先输入访问码');
    const endpoint = String(input?.subscription?.endpoint ?? '');
    const p256dh = String(input?.subscription?.keys?.p256dh ?? '');
    const auth = String(input?.subscription?.keys?.auth ?? '');
    if (!isPushEndpoint(endpoint) || endpoint.length > 1000) throw new Error('不支持的推送服务');
    const pk = Buffer.from(p256dh, 'base64url');
    if (pk.length !== 65 || pk[0] !== 4 || Buffer.from(auth, 'base64url').length !== 16) throw new Error('订阅密钥无效');
    // 管理员用密钥直接调用时没有令牌：补发一个，之后发送前可以重新校验
    const token = who.token ?? (who.role !== 'public' ? this.access.issue(who.role, who.sid) : undefined);
    const old = this.find(endpoint);
    const prefs: PushPrefs = { ...DEFAULT_PREFS, ...old?.prefs, ...this.cleanPrefs(input?.prefs) };
    if (old) Object.assign(old, { p256dh, auth, token, prefs, subject, device: device ?? old.device, fails: 0 });
    else {
      if (this.subs.length >= MAX_SUBS) throw new Error('订阅设备太多，请先清理');
      this.subs.push({ id: crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16), endpoint, p256dh, auth, token, prefs, subject, device, createdAt: Date.now(), fails: 0 });
    }
    this.save();
    return { prefs };
  }

  unsubscribe(endpoint: unknown) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== String(endpoint ?? ''));
    if (this.subs.length !== before) this.save();
  }

  status(endpoint: unknown): { subscribed: boolean; prefs: PushPrefs; minSol: number } {
    const s = this.find(endpoint);
    return { subscribed: !!s, prefs: s?.prefs ?? DEFAULT_PREFS, minSol: this.config.minSol };
  }

  /** 浏览器自动更换了订阅（Service Worker 的 pushsubscriptionchange）：旧地址作为凭证 */
  resubscribe(input: any) {
    const s = this.find(input?.oldEndpoint);
    if (!s) throw new HttpError(404, '原订阅不存在');
    const endpoint = String(input?.subscription?.endpoint ?? '');
    const p256dh = String(input?.subscription?.keys?.p256dh ?? '');
    const auth = String(input?.subscription?.keys?.auth ?? '');
    if (!isPushEndpoint(endpoint) || Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) throw new Error('订阅无效');
    Object.assign(s, { endpoint, p256dh, auth, fails: 0, id: crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16) });
    this.save();
  }

  async test(endpoint: unknown) {
    const s = this.find(endpoint);
    if (!s) throw new HttpError(404, '这台设备还没有开启提醒');
    const total = this.ctx.totalSol();
    const ok = await this.deliver(s, {
      title: 'VectorKeith 提醒测试',
      body: `收到这条，说明这台设备的提醒已经开启。现在公司总资产 ${solAmt(total)}（${this.money(total)}）`,
      url: '/#/assets',
      tag: 'test',
    });
    if (!ok) throw new Error(this.find(endpoint) ? '推送服务暂时没有响应，请稍后再试' : '订阅已失效，请关闭后重新开启提醒');
  }

  settings(): PushSettings {
    return { ...this.config, subscribers: this.subs.length };
  }

  updateSettings(input: any): PushSettings {
    if (input?.minSol !== undefined) {
      const v = Number(input.minSol);
      if (!(v >= 0 && v <= 1e6)) throw new Error('提醒金额无效');
      this.config.minSol = v;
    }
    if (input?.lowSol !== undefined) {
      const v = Number(input.lowSol);
      if (!(v >= 0 && v <= 1e7)) throw new Error('低余额提醒值无效');
      this.config.lowSol = v;
      this.lowInit = false; // 下一次读到余额时重新判断，不会因为改设置立刻提醒
    }
    this.cfgFile.writeNow(this.config);
    return this.settings();
  }

  // ─── 事件 → 提醒 ─────────────────────────────────────────────

  /** 公司钱包新发生的流水（已带投毒标记） */
  onActivity(list: TreasuryActivity[]) {
    for (const a of list) {
      if (a.failed) continue;
      if (a.poisonOf) this.enqueue({ kind: 'poison', a });
      else if (a.dust) continue;
      else if (a.stable) {
        if (a.stable.amount >= 1) this.enqueue({ kind: 'flow', a }); // 稳定币：1 美元以上就提醒
      } else if (Math.abs(a.deltaSol) < this.config.minSol) continue;
      else if (a.kind === 'in' || a.kind === 'out' || a.kind === 'stake' || a.kind === 'unstake') this.enqueue({ kind: 'flow', a });
      else if (a.kind === 'buy' || a.kind === 'sell') this.enqueue({ kind: 'trade', a });
    }
  }

  /** 内部质押：员工充值 / 分息 / 赎回到账，赎回申请 */
  onInternal(list: InternalEvent[]) {
    for (const e of list) this.enqueue({ kind: 'internal', e });
  }

  /** 公司达成目标：推送给所有能看 App 的设备 */
  onGoal(g: GoalView, total: number) {
    this.enqueue({ kind: 'goal', g, total });
  }

  /** 解锁了新成就 */
  onUnlock(list: Unlock[]) {
    for (const u of list) this.enqueue({ kind: 'badge', u });
  }

  onPayouts(list: Payout[]) {
    for (const p of list) this.enqueue({ kind: 'payout', p });
  }

  onBalance(total: number) {
    const low = this.config.lowSol;
    if (!(low > 0)) return;
    if (!this.lowInit) {
      this.lowInit = true;
      this.lowArmed = total >= low; // 启动时已经低于阈值：不重复提醒
      return;
    }
    if (this.lowArmed && total < low) {
      this.lowArmed = false;
      this.enqueue({ kind: 'low', total });
    } else if (!this.lowArmed && total >= low * 1.02) this.lowArmed = true;
  }

  private enqueue(e: Ev) {
    this.queue.push(e);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 3_000);
  }

  private money(sol: number) {
    const r = this.ctx.solTo();
    return `≈ ¥${num(Math.abs(sol) * r.cny, 2)} / $${num(Math.abs(sol) * r.usd, 2)}`;
  }

  private totalLine() {
    const t = this.ctx.totalSol();
    return `总资产 ${solAmt(t)}（¥${num(t * this.ctx.solTo().cny, 0)}）`;
  }

  private flowMsg(a: TreasuryActivity): Msg {
    const label = (x: string) => {
      const l = this.ctx.labelOf(x);
      return l ? `${l}（${short(x)}）` : short(x);
    };
    if (a.stable) {
      const s = a.stable;
      const amt = s.amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
      const cny = s.amount * (this.ctx.solTo().cny / Math.max(1e-9, this.ctx.solTo().usd));
      const p2 = [`≈ $${amt} · ¥${Math.round(cny).toLocaleString('en-US')}`];
      if (a.counterparty) p2.push(`${a.kind === 'stableIn' ? '来自' : '转给'} ${label(a.counterparty)}`);
      p2.push('稳定币计入公司总资产，不计入分红');
      return { title: `公司钱包${a.kind === 'stableIn' ? '收到' : '转出'} ${amt} ${s.symbol}`, body: p2.join(' · '), url: '/#/assets', tag: `flow-${a.sig.slice(0, 10)}` };
    }
    const parts = [this.money(a.deltaSol)];
    let what: string;
    if (a.kind === 'stake' || a.kind === 'unstake') {
      what = a.kind === 'stake' ? '质押' : '取回质押';
      const tk = a.tokens.find((t) => t.symbol);
      if (a.kind === 'stake' && a.counterparty) parts.push(`委托给 ${label(a.counterparty)}`);
      else if (tk) parts.push(`${tk.delta > 0 ? '换成' : '卖出'} ${compact(tk.delta)} ${tk.symbol}`);
      parts.push('质押中的 SOL 仍计入公司总资产');
    } else if (a.kind === 'in') {
      what = '转入';
      if (a.counterparty) parts.push(`来自 ${label(a.counterparty)}`);
    } else if (a.kind === 'out') {
      what = '转出';
      const to = a.outs?.length === 1 ? a.outs[0].to : a.counterparty;
      if (to) parts.push(`转给 ${label(to)}`);
      else if ((a.outs?.length ?? 0) > 1) parts.push(`转给 ${a.outs!.length} 个地址`);
    } else {
      what = a.kind === 'buy' ? '买入代币' : '卖出代币';
      const tk = a.tokens.map((t) => `${t.delta > 0 ? '+' : '−'}${compact(t.delta)} ${t.symbol ?? short(t.mint)}`).join(' ');
      if (tk) parts.unshift(tk);
    }
    parts.push(this.totalLine());
    return { title: `公司钱包${what} ${solAmt(a.deltaSol, true)}`, body: parts.join(' · '), url: '/#/assets', tag: `flow-${a.sig.slice(0, 10)}` };
  }

  private summaryMsg(list: TreasuryActivity[]): Msg {
    const net = list.reduce((s, a) => s + a.deltaSol, 0);
    const groups = new Map<string, { n: number; sol: number }>();
    const name: Record<string, string> = { in: '转入', out: '转出', buy: '买入代币', sell: '卖出代币', stake: '质押', unstake: '取回质押', stableIn: '稳定币转入', stableOut: '稳定币转出' };
    for (const a of list) {
      const g = groups.get(a.kind) ?? { n: 0, sol: 0 };
      g.n++;
      g.sol += a.deltaSol;
      groups.set(a.kind, g);
    }
    const detail = [...groups].map(([k, g]) => `${name[k] ?? k} ${g.n} 笔 ${solAmt(g.sol, true)}`).join(' · ');
    return { title: `公司钱包 ${list.length} 笔变动，净 ${solAmt(net, true)}`, body: `${detail} · ${this.totalLine()}`, url: '/#/assets', tag: 'flow-sum' };
  }

  private poisonMsg(a: TreasuryActivity): Msg {
    const target = a.poisonOf!;
    const l = this.ctx.labelOf(target);
    return {
      title: '⚠️ 发现地址投毒',
      body: `${short(a.counterparty ?? '')} 冒充 ${l ? `${l}（${short(target)}）` : short(target)}，给公司钱包转了 ${solAmt(a.deltaSol)}。它的开头结尾和真地址一样，转账时千万不要从交易记录里复制地址。`,
      url: '/#/assets',
      tag: `poison-${(a.counterparty ?? '').slice(0, 10)}`,
      urgency: 'high',
    };
  }

  private payoutMsg(p: Payout, mine: boolean): Msg {
    const name = this.ctx.holderName(p.sid) ?? '股东';
    const paid = this.ctx.holderPaid(p.sid);
    return mine
      ? { title: `你的分红已到账 ${solAmt(p.sol)}`, body: `${this.money(p.sol)} · 累计已收到 ${solAmt(paid)}`, url: '/#/shareholders', tag: `payout-${p.id.slice(0, 10)}`, urgency: 'high' }
      : { title: `分红已发放：${name} ${solAmt(p.sol)}`, body: `${this.money(p.sol)} · ${name}累计已收到 ${solAmt(paid)}`, url: '/#/shareholders', tag: `payout-${p.id.slice(0, 10)}` };
  }

  private badgeMsg(u: Unlock): Msg {
    return {
      title: `🏆 解锁成就：${u.icon} ${u.name}${u.levelLabel ? ` · ${u.levelLabel}` : ''}`,
      body: `${u.desc}${u.levelLabel ? ` ${u.levelLabel}` : ''}${u.detail ? `（${u.detail}）` : ''}。打开「探索」看成就墙。`,
      url: '/#/explore',
      tag: `badge-${u.key}`,
    };
  }

  private lowMsg(total: number): Msg {
    return {
      title: `公司总资产低于 ${num(this.config.lowSol, this.config.lowSol % 1 ? 2 : 0)} SOL`,
      body: `现在 ${solAmt(total)}（${this.money(total)}）`,
      url: '/#/assets',
      tag: 'low',
      urgency: 'high',
    };
  }

  /** 按每台设备的身份和提醒类型生成要发的消息 */
  private messagesFor(s: Sub, events: Ev[]): Msg[] {
    const who = this.access.verify(s.token);
    if (!this.access.canView(who)) return [];
    const msgs: Msg[] = [];
    for (const e of events) {
      if (e.kind !== 'payout' || !s.prefs.payout) continue;
      if (who.role === 'admin') msgs.push(this.payoutMsg(e.p, false));
      else if (who.role === 'holder' && who.sid === e.p.sid) msgs.push(this.payoutMsg(e.p, true));
    }
    if (s.prefs.poison) for (const e of events) if (e.kind === 'poison') msgs.push(this.poisonMsg(e.a));
    const flows = events
      .filter((e): e is Extract<Ev, { a: TreasuryActivity }> => (e.kind === 'flow' && s.prefs.flow) || (e.kind === 'trade' && s.prefs.trade))
      .map((e) => e.a);
    if (flows.length >= 3) msgs.push(this.summaryMsg(flows));
    else for (const a of flows) msgs.push(this.flowMsg(a));
    if (s.prefs.flow) for (const e of events) if (e.kind === 'low') msgs.push(this.lowMsg(e.total));
    if (s.prefs.badge) for (const e of events) if (e.kind === 'badge') msgs.push(this.badgeMsg(e.u));
    if (s.prefs.badge) {
      for (const e of events) {
        if (e.kind !== 'goal') continue;
        const days = Math.max(1, Math.round(((e.g.reachedAt ?? Date.now() / 1000) - e.g.setAt) / 86400));
        msgs.push({
          title: `🎉 公司达成目标：${e.g.label ? `${e.g.label} ` : ''}${e.g.target} SOL`,
          body: `现在 ${solAmt(e.total)}（${this.money(e.total)}），从设定目标到达成用了 ${days} 天。打开 App 看烟花！`,
          url: '/#/assets',
          tag: `goal-${e.g.setAt}`,
          urgency: 'high',
        });
      }
    }
    if (s.prefs.payout) {
      for (const e of events) {
        if (e.kind !== 'internal') continue;
        const m = who.role === 'admin' ? e.e.admin : who.role === 'member' && who.sid === e.e.mid ? e.e.member : undefined;
        if (m) msgs.push({ ...m, url: '/#/staking', tag: `internal-${m.title.slice(0, 12)}`, urgency: 'high' });
      }
    }
    return msgs.slice(0, 4);
  }

  private async flush() {
    let events = this.queue;
    this.queue = [];
    // 发给股东的转账已经有"分红已发放"提醒，不再重复提醒"转出"
    const paidSigs = new Set(events.flatMap((e) => (e.kind === 'payout' && e.p.sig ? [e.p.sig] : [])));
    events = events.filter((e) => !(e.kind === 'flow' && paidSigs.has(e.a.sig)));
    if (!events.length || !this.subs.length) return;
    const jobs: Promise<unknown>[] = [];
    for (const s of [...this.subs]) for (const m of this.messagesFor(s, events)) jobs.push(this.deliver(s, m));
    await Promise.allSettled(jobs);
  }

  private async deliver(s: Sub, m: Msg): Promise<boolean> {
    try {
      const r = await sendPush(
        s,
        { title: m.title, body: m.body, url: m.url, tag: m.tag, ts: Date.now() },
        this.vapid,
        process.env.PUSH_SUBJECT || s.subject,
        { urgency: m.urgency ?? 'normal', ttl: 86400 },
      );
      if (r.status >= 200 && r.status < 300) {
        s.lastOkAt = Date.now();
        s.fails = 0;
        this.save();
        return true;
      }
      if (r.status === 404 || r.status === 410) {
        this.unsubscribe(s.endpoint); // 用户关了通知或删了 App
      } else {
        s.fails++;
        this.ctx.warn(`推送失败 ${r.status}`, r.text);
        if (s.fails >= 30) this.unsubscribe(s.endpoint);
        else this.save();
      }
    } catch (e) {
      s.fails++;
      this.ctx.warn('推送失败', e);
    }
    return false;
  }
}
