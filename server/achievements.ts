// ───────────────────────────────────────────────────────────────
//  成就墙：从公司钱包的完整链上历史里算出来的徽章（16 个系列，多数分等级）
//  · 每次有新流水、余额变化、股东名册变化时重算；每小时再算一次（"稳如泰山""周年"随时间解锁）
//  · 新解锁的等级：广播给 App 播放解锁动画，并推送提醒
//  · 第一次运行、或解锁时间早于 2 天（例如新加了一个有历史的钱包）：直接记为已解锁，不打扰
// ───────────────────────────────────────────────────────────────
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Achievement, AchievementsView, Payout, TreasuryActivity, TreasuryHistoryPoint } from '../shared/types';
import type { SolPriceFeed } from './prices';
import type { Shareholders } from './shareholders';
import { JsonFile } from './store';
import type { Treasury } from './treasury';

interface State {
  seen: string[]; // 已经通知过的 "系列:等级"
  firstSeen: Record<string, number>; // 没有天然时间的成就：第一次达成的时间
}

export interface Unlock {
  key: string;
  icon: string;
  name: string;
  levelLabel?: string;
  desc: string;
  detail?: string;
}

interface Ctx {
  history: TreasuryHistoryPoint[];
  activity: readonly TreasuryActivity[];
  poison: { ts: number }[];
  payouts: Payout[];
  totalPct: number;
  usdCny: number;
  now: number;
  firstSeen: (key: string, reached: boolean) => number | undefined;
}

const DAY = 86400;
const BJ = 8 * 3600; // 北京时间（UTC+8，没有夏令时）
const fmt = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sol = (v: number) => `${fmt(v, v >= 100 ? 1 : v >= 1 ? 2 : 4)} SOL`;
const bjDate = (ts: number) => new Date((ts + BJ) * 1000).toISOString().slice(0, 10);
const bjHour = (ts: number) => new Date((ts + BJ) * 1000).getUTCHours();
const wan = (v: number) => (v >= 10000 ? `¥${v / 10000}万` : `¥${fmt(v, 0)}`);

/** 分等级的成就：tiers 按从易到难排列，at = 达到该等级的时间（没达到为 undefined） */
function tiered(
  base: Pick<Achievement, 'id' | 'icon' | 'name' | 'desc'>,
  tiers: { label: string; target: number; at?: number }[],
  current: number,
  progressText: (cur: number, next: number) => string,
  detail?: string,
): Achievement {
  let level = 0;
  while (level < tiers.length && tiers[level].at !== undefined) level++;
  const next = tiers[level];
  return {
    ...base,
    level,
    maxLevel: tiers.length,
    levelLabel: level ? tiers[level - 1].label : undefined,
    nextLabel: next?.label,
    progress: next ? Math.max(0, Math.min(1, current / next.target)) : 1,
    progressText: next ? progressText(current, next.target) : undefined,
    unlockedAt: level ? tiers[level - 1].at : undefined,
    detail,
  };
}

/** 单级成就 */
function single(base: Pick<Achievement, 'id' | 'icon' | 'name' | 'desc'>, at: number | undefined, extra: Partial<Achievement> = {}): Achievement {
  return { ...base, level: at !== undefined ? 1 : 0, maxLevel: 1, progress: at !== undefined ? 1 : 0, unlockedAt: at, ...extra };
}

/** 余额曲线上某时刻的余额（阶梯函数） */
function balanceAt(h: TreasuryHistoryPoint[], t: number): number {
  let lo = 0;
  let hi = h.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (h[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans < 0 ? 0 : h[ans].sol;
}

export function computeAchievements(c: Ctx): Achievement[] {
  const { history: h, activity: acts, now } = c;
  const live = h.length ? h[h.length - 1].sol : 0;
  const real = acts.filter((a) => !a.failed && !a.dust);
  const out: Achievement[] = [];

  // 1. 第一桶金
  const first = real.find((a) => a.deltaSol > 0 && (a.kind === 'in' || a.kind === 'sell'));
  out.push(single({ id: 'first', icon: '🌱', name: '第一桶金', desc: '公司钱包收到第一笔 SOL' }, first?.ts, first ? { detail: `+${sol(first.deltaSol)} · ${bjDate(first.ts)}` } : {}));

  // 2. 资产里程碑（SOL）
  const firstReach = (pred: (p: TreasuryHistoryPoint) => boolean) => h.find(pred)?.t;
  const maxPoint = h.reduce<TreasuryHistoryPoint | null>((m, p) => (!m || p.sol >= m.sol ? p : m), null);
  out.push(
    tiered(
      { id: 'assets', icon: '⛰️', name: '资产里程碑', desc: '公司钱包里的 SOL 合计第一次达到' },
      [1, 10, 50, 100, 500, 1000].map((v) => ({ label: `${v} SOL`, target: v, at: firstReach((p) => p.sol >= v) })),
      live,
      (cur, next) => `${fmt(cur)} / ${next} SOL`,
    ),
  );

  // 3. 身价里程碑（人民币）
  const cnyOf = (p: TreasuryHistoryPoint) => p.sol * p.solUsd * c.usdCny;
  const liveCny = h.length ? cnyOf(h[h.length - 1]) : 0;
  out.push(
    tiered(
      { id: 'value', icon: '💴', name: '身价里程碑', desc: '公司资产按当时的 SOL 价格折合人民币，第一次达到' },
      [10_000, 50_000, 100_000, 500_000, 1_000_000].map((v) => ({ label: wan(v), target: v, at: firstReach((p) => cnyOf(p) >= v) })),
      liveCny,
      (cur, next) => `¥${fmt(cur, 0)} / ${wan(next)}`,
    ),
  );

  // 4. 巨鲸入账：单笔转入
  const ins = real.filter((a) => a.kind === 'in' && a.deltaSol > 0);
  const biggest = ins.reduce<TreasuryActivity | null>((m, a) => (!m || a.deltaSol > m.deltaSol ? a : m), null);
  out.push(
    tiered(
      { id: 'whale', icon: '🐋', name: '巨鲸入账', desc: '单笔转入达到' },
      [1, 10, 50, 100].map((v) => ({ label: `${v} SOL`, target: v, at: ins.find((a) => a.deltaSol >= v)?.ts })),
      biggest?.deltaSol ?? 0,
      (cur, next) => `最大一笔 ${fmt(cur)} / ${next} SOL`,
      biggest ? `最大一笔 +${sol(biggest.deltaSol)} · ${bjDate(biggest.ts)}` : undefined,
    ),
  );

  // 5. 历史新高
  const atNow = !!maxPoint && live >= maxPoint.sol * 0.999 && live > 0;
  out.push(
    single({ id: 'ath', icon: '📈', name: '历史新高', desc: '公司资产（SOL）创下的最高纪录' }, maxPoint && maxPoint.sol > 0 ? maxPoint.t : undefined, {
      detail: maxPoint && maxPoint.sol > 0 ? `${atNow ? '就是现在！' : '最高'} ${sol(maxPoint.sol)}${atNow ? '' : ` · ${bjDate(maxPoint.t)}`}` : undefined,
    }),
  );

  // 6. 交易达人
  out.push(
    tiered(
      { id: 'txcount', icon: '🔁', name: '交易达人', desc: '公司钱包累计交易笔数达到' },
      [10, 100, 500, 1000].map((v) => ({ label: `${v} 笔`, target: v, at: acts[v - 1]?.ts })),
      acts.length,
      (cur, next) => `${cur} / ${next} 笔`,
    ),
  );

  // 7. 火眼金睛：识破地址投毒
  const poison = [...c.poison].sort((a, b) => a.ts - b.ts);
  out.push(
    tiered(
      { id: 'guard', icon: '🛡️', name: '火眼金睛', desc: '识破冒充公司常用地址的投毒转账' },
      [1, 3, 10].map((v) => ({ label: `${v} 次`, target: v, at: poison[v - 1]?.ts })),
      poison.length,
      (cur, next) => `${cur} / ${next} 次`,
    ),
  );

  // 8. 分红达人
  const pays = c.payouts.filter((p) => !p.excluded).sort((a, b) => a.ts - b.ts);
  const paid = pays.reduce((s, p) => s + p.sol, 0);
  out.push(
    tiered(
      { id: 'dividend', icon: '🎁', name: '分红达人', desc: '给股东发放分红（链上自动识别 + 线下补记）的笔数' },
      [1, 5, 20].map((v) => ({ label: `${v} 笔`, target: v, at: pays[v - 1]?.ts })),
      pays.length,
      (cur, next) => `${cur} / ${next} 笔`,
      pays.length ? `累计发放 ${sol(paid)}` : undefined,
    ),
  );

  // 9. 股东到齐
  const full = c.totalPct >= 99.9999;
  out.push(
    single({ id: 'full', icon: '🤝', name: '股东到齐', desc: '股东名册里登记的持股比例合计达到 100%' }, c.firstSeen('full:1', full), {
      progress: Math.min(1, c.totalPct / 100),
      progressText: full ? undefined : `${fmt(c.totalPct, c.totalPct % 1 ? 2 : 0)}% / 100%`,
    }),
  );

  // 10. 稳如泰山：连续多少天没有转出
  const outs = real.filter((a) => a.kind === 'out' && a.deltaSol < -0.001).map((a) => a.ts);
  const start = acts[0]?.ts;
  const segs: [number, number][] = [];
  if (start !== undefined) {
    let from = start;
    for (const t of outs) {
      segs.push([from, t]);
      from = t;
    }
    segs.push([from, now]);
  }
  const streak = start !== undefined ? (now - (outs.length ? outs[outs.length - 1] : start)) / DAY : 0;
  out.push(
    tiered(
      { id: 'hodl', icon: '🧘', name: '稳如泰山', desc: '公司钱包连续多少天没有转出 SOL' },
      [7, 30, 90].map((d) => {
        const seg = segs.find(([a, b]) => b - a >= d * DAY);
        return { label: `${d} 天`, target: d, at: seg ? seg[0] + d * DAY : undefined };
      }),
      streak,
      (cur, next) => `已连续 ${Math.floor(cur)} / ${next} 天`,
      start !== undefined ? `当前已连续 ${Math.floor(streak)} 天没有转出` : undefined,
    ),
  );

  // 11. 一月翻倍：30 天内资产翻倍（30 天前至少 1 SOL）
  const dbl = h.find((p) => {
    const base = balanceAt(h, p.t - 30 * DAY);
    return base >= 1 && p.sol >= base * 2;
  });
  const base30 = balanceAt(h, now - 30 * DAY);
  out.push(
    single({ id: 'double', icon: '🚀', name: '一月翻倍', desc: '公司资产（SOL）比 30 天前翻了一倍（30 天前至少有 1 SOL）' }, dbl?.t, {
      progress: dbl ? 1 : base30 >= 1 ? Math.min(1, live / base30 / 2) : 0,
      progressText: dbl ? undefined : base30 >= 1 ? `现在是 30 天前的 ${fmt(live / base30)} 倍` : '30 天前不足 1 SOL',
      detail: dbl ? `${sol(balanceAt(h, dbl.t - 30 * DAY))} → ${sol(dbl.sol)}` : undefined,
    }),
  );

  // 12. 夜猫子：北京时间凌晨 0–5 点的交易
  const night = real.filter((a) => bjHour(a.ts) < 5);
  out.push(
    single({ id: 'night', icon: '🌙', name: '夜猫子', desc: '北京时间凌晨 0–5 点还在交易' }, night[0]?.ts, night.length ? { detail: `凌晨交易 ${night.length} 笔` } : {}),
  );

  // 13. 闪电手：60 秒内 5 笔
  let flashAt: number | undefined;
  let flashMax = 0;
  for (let i = 0, j = 0; i < acts.length; i++) {
    while (acts[i].ts - acts[j].ts > 60) j++;
    const n = i - j + 1;
    if (n > flashMax) flashMax = n;
    if (n >= 5 && flashAt === undefined) flashAt = acts[i].ts;
  }
  out.push(
    single({ id: 'flash', icon: '⚡', name: '闪电手', desc: '60 秒内连续完成 5 笔交易' }, flashAt, {
      progress: flashAt ? 1 : Math.min(1, flashMax / 5),
      progressText: flashAt ? undefined : `最快 60 秒 ${flashMax} 笔 / 5 笔`,
      detail: flashAt ? `最快 60 秒内 ${flashMax} 笔` : undefined,
    }),
  );

  // 14. 高光时刻：单日净流入最多的一天
  const days = new Map<string, { net: number; last: number }>();
  for (const a of acts) {
    const k = bjDate(a.ts);
    const d = days.get(k) ?? { net: 0, last: a.ts };
    d.net += a.deltaSol;
    d.last = a.ts;
    days.set(k, d);
  }
  const best = [...days].reduce<[string, { net: number; last: number }] | null>((m, x) => (!m || x[1].net > m[1].net ? x : m), null);
  out.push(
    single({ id: 'bigday', icon: '🔥', name: '高光时刻', desc: '单日净流入最多的一天（北京时间）' }, best && best[1].net > 0 ? best[1].last : undefined, {
      detail: best && best[1].net > 0 ? `${best[0]} · 净流入 +${sol(best[1].net)}` : undefined,
    }),
  );

  // 15. 首次质押
  const firstStake = real.find((a) => a.kind === 'stake');
  out.push(single({ id: 'stake', icon: '🔐', name: '首次质押', desc: '公司第一次把 SOL 质押出去赚收益' }, firstStake?.ts, firstStake ? { detail: `质押 ${sol(Math.abs(firstStake.deltaSol))} · ${bjDate(firstStake.ts)}` } : {}));

  // 16. 周年纪念：满月 / 百日 / 一周年
  const age = start !== undefined ? (now - start) / DAY : 0;
  out.push(
    tiered(
      { id: 'anniv', icon: '🎂', name: '周年纪念', desc: '从公司钱包第一笔交易算起' },
      [
        { label: '满月', target: 30 },
        { label: '百日', target: 100 },
        { label: '一周年', target: 365 },
      ].map((x) => ({ ...x, at: start !== undefined && age >= x.target ? start + x.target * DAY : undefined })),
      age,
      (cur, next) => `第 ${Math.floor(cur) + 1} 天 / ${next} 天`,
      start !== undefined ? `始于 ${bjDate(start)}` : undefined,
    ),
  );

  return out;
}

export class Achievements extends EventEmitter {
  private file: JsonFile<State>;
  private state: State;
  private fresh: boolean; // 第一次运行（还没有状态文件）
  private cache: AchievementsView | null = null;
  private timer: NodeJS.Timeout | null = null;
  private digest = '';
  rev = 1;

  constructor(
    dataDir: string,
    private treasury: Treasury,
    private shareholders: Shareholders,
    private prices: SolPriceFeed,
  ) {
    super();
    this.file = new JsonFile(path.join(dataDir, 'achievements', 'state.json'), 0);
    const st = this.file.read();
    this.fresh = !st;
    this.state = { seen: st?.seen ?? [], firstSeen: st?.firstSeen ?? {} };
    const soon = () => this.schedule();
    treasury.on('ingested', soon);
    treasury.on('balance', soon);
    shareholders.on('changed', soon);
    setInterval(soon, 3600_000).unref();
  }

  private schedule(ms = 5_000) {
    this.cache = null;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.recheck();
    }, ms);
  }

  private compute(): AchievementsView {
    let dirty = false;
    const list = computeAchievements({
      history: this.treasury.history(),
      activity: this.treasury.allActivity(),
      poison: this.treasury.poisonEvents(),
      payouts: this.shareholders.payouts(),
      totalPct: this.shareholders.totalPct(),
      usdCny: this.prices.price.usdCny,
      now: Math.floor(Date.now() / 1000),
      firstSeen: (key, reached) => {
        if (!reached) return undefined;
        if (!this.state.firstSeen[key]) {
          this.state.firstSeen[key] = Math.floor(Date.now() / 1000);
          dirty = true;
        }
        return this.state.firstSeen[key];
      },
    });
    if (dirty) this.file.writeNow(this.state);
    return { list, unlocked: list.reduce((s, a) => s + a.level, 0), total: list.reduce((s, a) => s + a.maxLevel, 0) };
  }

  view(): AchievementsView {
    this.cache ??= this.compute();
    return this.cache;
  }

  /** 找出新解锁的等级 */
  recheck() {
    if (!this.treasury.status.backfillDone) return; // 历史还没同步完，算出来的不准
    this.cache = this.compute();
    const seen = new Set(this.state.seen);
    const nowSec = Date.now() / 1000;
    const fresh: Unlock[] = [];
    let changed = false;
    for (const a of this.cache.list) {
      for (let lv = 1; lv <= a.level; lv++) {
        const key = `${a.id}:${lv}`;
        if (seen.has(key)) continue;
        seen.add(key);
        changed = true;
        // 只有"刚刚解锁"的当前等级才通知（解锁时间在 2 天内）
        if (!this.fresh && lv === a.level && a.unlockedAt !== undefined && nowSec - a.unlockedAt < 2 * DAY) {
          fresh.push({ key, icon: a.icon, name: a.name, levelLabel: a.maxLevel > 1 ? a.levelLabel : undefined, desc: a.desc, detail: a.detail });
        }
      }
    }
    this.fresh = false;
    if (changed) {
      this.state.seen = [...seen];
      this.file.writeNow(this.state);
    }
    // 只有等级、纪录或进度（按 1% 取整）变了才通知 App 刷新
    const digest = this.cache.list.map((a) => `${a.id}:${a.level}:${a.detail ?? ''}:${Math.round(a.progress * 100)}`).join('|');
    if (digest === this.digest && !fresh.length) return;
    this.digest = digest;
    this.rev++;
    this.emit('changed', this.rev, fresh);
  }
}
