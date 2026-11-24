// ───────────────────────────────────────────────────────────────
//  年度报告：从公司钱包的链上流水里算出一年的"高光时刻"（时间按北京时间）
// ───────────────────────────────────────────────────────────────
import type { AchievementsView, ActivityKind, Payout, ReportData, TreasuryActivity, TreasuryHistoryPoint } from '../shared/types';

const BJ = 8 * 3600;
const DAY = 86400;
const bjDate = (ts: number) => new Date((ts + BJ) * 1000).toISOString().slice(0, 10);
const bjClock = (ts: number) => {
  const d = new Date((ts + BJ) * 1000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
};
const pad = (n: number) => String(n).padStart(2, '0');

export interface ReportCtx {
  activity: readonly TreasuryActivity[];
  history: TreasuryHistoryPoint[];
  poison: { ts: number; from: string; imitates: string }[];
  payouts?: Payout[]; // 只有登录的人（股东 / 员工 / 访客 / 管理员）才有
  achievements: AchievementsView;
  labelOf: (address: string) => string | undefined;
  symbolOf: (mint: string) => string | undefined;
  usdCny: number;
  solUsd: number;
}

function balanceAt(h: TreasuryHistoryPoint[], t: number) {
  let ans = 0;
  for (const p of h) {
    if (p.t > t) break;
    ans = p.sol;
  }
  return ans;
}

export function reportYears(activity: readonly TreasuryActivity[]): number[] {
  return [...new Set(activity.map((a) => Number(bjDate(a.ts).slice(0, 4))))].sort();
}

export function computeReport(year: number, c: ReportCtx): ReportData {
  const now = Math.floor(Date.now() / 1000);
  const from = Date.UTC(year, 0, 1) / 1000 - BJ;
  const to = Math.min(now, Date.UTC(year + 1, 0, 1) / 1000 - BJ);
  const acts = c.activity.filter((a) => a.ts >= from && a.ts < to);
  const real = acts.filter((a) => !a.failed && !a.dust);
  const short = (a?: string) => (a ? (c.labelOf(a) ?? `${a.slice(0, 4)}…${a.slice(-4)}`) : undefined);

  // 第一笔（公司钱包有史以来第一次收到 SOL），在这一年里才显示
  const firstEver = c.activity.find((a) => !a.failed && !a.dust && a.deltaSol > 0 && (a.kind === 'in' || a.kind === 'sell'));
  const first = firstEver && firstEver.ts >= from && firstEver.ts < to ? { ts: firstEver.ts, sol: firstEver.deltaSol, solUsd: firstEver.solUsd, fromLabel: short(firstEver.counterparty) } : undefined;

  const yearPoints = c.history.filter((p) => p.t >= from && p.t <= to);
  const peakP = yearPoints.reduce<TreasuryHistoryPoint | null>((m, p) => (!m || p.sol > m.sol ? p : m), null);
  const end = to >= now - 60 && c.history.length ? c.history[c.history.length - 1].sol : balanceAt(c.history, to);

  // 最大一笔转入
  const ins = real.filter((a) => a.kind === 'in' && a.deltaSol > 0);
  const big = ins.reduce<TreasuryActivity | null>((m, a) => (!m || a.deltaSol > m.deltaSol ? a : m), null);

  // 按天
  const days = new Map<string, { net: number; count: number }>();
  for (const a of acts) {
    const d = days.get(bjDate(a.ts)) ?? { net: 0, count: 0 };
    d.net += a.deltaSol;
    d.count++;
    days.set(bjDate(a.ts), d);
  }
  const dayList = [...days];
  const best = dayList.reduce<[string, { net: number; count: number }] | null>((m, x) => (!m || x[1].net > m[1].net ? x : m), null);
  const busy = dayList.reduce<[string, { net: number; count: number }] | null>((m, x) => (!m || x[1].count > m[1].count ? x : m), null);

  // 凌晨 & 最常交易的时段
  const hours = new Array(24).fill(0);
  let latestNight = -1;
  let nightCount = 0;
  for (const a of real) {
    const { h, m } = bjClock(a.ts);
    hours[h]++;
    if (h < 5) {
      nightCount++;
      latestNight = Math.max(latestNight, h * 60 + m);
    }
  }
  const topH = hours.reduce((bi, v, i, arr) => (v > arr[bi] ? i : bi), 0);

  // 分类
  const kinds: ReportData['kinds'] = {};
  for (const a of acts) {
    const k: ActivityKind = a.failed ? 'fee' : a.kind;
    const e = kinds[k] ?? { count: 0, sol: 0 };
    e.count++;
    e.sol += a.deltaSol;
    kinds[k] = e;
  }
  const totalIn = acts.filter((a) => a.deltaSol > 0).reduce((s, a) => s + a.deltaSol, 0);
  const totalOut = acts.filter((a) => a.deltaSol < 0).reduce((s, a) => s + a.deltaSol, 0);
  const fees = acts.reduce((s, a) => s + a.fee, 0);

  // 地址投毒
  const poison = c.poison.filter((p) => p.ts >= from && p.ts < to);
  const imitated = [...new Set(poison.map((p) => short(p.imitates)!))];

  // 最长连续没有转出
  const outs = real.filter((a) => a.kind === 'out' && a.deltaSol < -0.001).map((a) => a.ts);
  let hodl = 0;
  const startT = acts[0]?.ts;
  if (startT !== undefined) {
    let prev = startT;
    for (const t of [...outs, to]) {
      hodl = Math.max(hodl, t - prev);
      prev = t;
    }
  }

  // 转入最多的来源
  const senders = new Map<string, { count: number; sol: number }>();
  for (const a of ins) {
    if (!a.counterparty) continue;
    const s = senders.get(a.counterparty) ?? { count: 0, sol: 0 };
    s.count++;
    s.sol += a.deltaSol;
    senders.set(a.counterparty, s);
  }
  const topS = [...senders].reduce<[string, { count: number; sol: number }] | null>((m, x) => (!m || x[1].sol > m[1].sol ? x : m), null);

  // 交易最多的代币
  const toks = new Map<string, { buys: number; sells: number }>();
  for (const a of real) {
    if (a.kind !== 'buy' && a.kind !== 'sell') continue;
    for (const t of a.tokens) {
      const sym = c.symbolOf(t.mint) ?? `${t.mint.slice(0, 4)}…`;
      const e = toks.get(sym) ?? { buys: 0, sells: 0 };
      if (a.kind === 'buy') e.buys++;
      else e.sells++;
      toks.set(sym, e);
    }
  }
  const topT = [...toks].reduce<[string, { buys: number; sells: number }] | null>((m, x) => (!m || x[1].buys + x[1].sells > m[1].buys + m[1].sells ? x : m), null);

  const pays = c.payouts?.filter((p) => !p.excluded && p.ts >= from && p.ts < to);

  // 资产曲线：最多 160 个点
  const pts = [{ t: from, sol: balanceAt(c.history, from) }, ...yearPoints.map((p) => ({ t: p.t, sol: p.sol }))];
  const step = Math.max(1, Math.ceil(pts.length / 160));
  const growth = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);

  const ach = c.achievements;
  return {
    year,
    years: reportYears(c.activity),
    from,
    to,
    usdCny: c.usdCny,
    solUsdNow: c.solUsd,
    txCount: acts.length,
    activeDays: days.size,
    first,
    start: balanceAt(c.history, from),
    end,
    peak: peakP ? { ts: peakP.t, sol: peakP.sol } : undefined,
    biggestIn: big ? { ts: big.ts, sol: big.deltaSol, usd: big.deltaSol * (big.solUsd || c.solUsd), fromLabel: short(big.counterparty) } : undefined,
    bestDay: best && best[1].net > 0 ? { date: best[0], net: best[1].net, count: best[1].count } : undefined,
    busiestDay: busy ? { date: busy[0], count: busy[1].count } : undefined,
    night: { count: nightCount, latest: latestNight >= 0 ? `${pad(Math.floor(latestNight / 60))}:${pad(latestNight % 60)}` : undefined },
    topHour: real.length ? { hour: topH, count: hours[topH] } : undefined,
    kinds,
    totalIn,
    totalOut,
    fees,
    poison: { count: poison.length, imitated },
    hodlDays: Math.floor(hodl / DAY),
    topSender: topS ? { label: short(topS[0])!, count: topS[1].count, sol: topS[1].sol } : undefined,
    topToken: topT ? { symbol: topT[0], buys: topT[1].buys, sells: topT[1].sells } : undefined,
    dividends: pays ? { count: pays.length, sol: pays.reduce((s, p) => s + p.sol, 0) } : undefined,
    achievements: {
      unlocked: ach.unlocked,
      total: ach.total,
      icons: ach.list.filter((a) => a.level > 0).map((a) => a.icon),
      thisYear: ach.list.filter((a) => a.unlockedAt !== undefined && a.unlockedAt >= from && a.unlockedAt < to).length,
    },
    growth,
  };
}
