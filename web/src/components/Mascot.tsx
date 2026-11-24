import { Flag, Pencil, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GoalView } from '../../../shared/types';
import { fmtMoney, fmtNum, fmtPct, fmtSol } from '../lib/format';
import { onFx, type Reaction } from '../lib/fx';
import { goalEta, saveGoal, type GoalEta } from '../lib/goal';
import { useTreasuryHistory } from '../lib/history';
import { useNow, useSolTo } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useStore } from '../lib/store';
import { useCur } from './Shell';
import { toast } from './ui';

export type Motion = 'idle' | 'dance' | 'catch' | 'party' | 'yawn' | 'sleep' | 'scared';

// ─── 机器人本体（SVG，动作全靠 CSS） ─────────────────────────

export function Mascot({ motion, shades, hat, size = 84, boop }: { motion: Motion; shades?: boolean; hat?: boolean; size?: number; boop?: boolean }) {
  const happy = motion === 'dance' || motion === 'party' || motion === 'catch';
  return (
    <svg className={`bot bot--${motion} ${boop ? 'bot--boop' : ''}`} viewBox="0 -12 120 146" width={size} height={(size * 146) / 120} aria-hidden>
      <defs>
        <linearGradient id="botFlame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e0faff" />
          <stop offset="0.5" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="botShell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#16407a" />
          <stop offset="1" stopColor="#0b2347" />
        </linearGradient>
      </defs>
      <ellipse className="bot__shadow" cx="60" cy="128" rx="24" ry="4" />
      <g className="bot__body">
        <path className="bot__flame" d="M51 112 Q60 132 69 112 Z" fill="url(#botFlame)" />
        <g className="bot__arm bot__arm--l">
          <rect x="19" y="78" width="11" height="27" rx="5.5" />
        </g>
        <g className="bot__arm bot__arm--r">
          <rect x="90" y="78" width="11" height="27" rx="5.5" />
        </g>
        <rect className="bot__torso" x="31" y="72" width="58" height="42" rx="15" />
        <text className="bot__vk" x="60" y="99">
          VK
        </text>
        <g className="bot__head">
          {!hat && (
            <>
              <line className="bot__ant" x1="60" y1="18" x2="60" y2="7" />
              <circle className="bot__antball" cx="60" cy="6" r="4" />
            </>
          )}
          <rect className="bot__ear" x="13" y="36" width="9" height="18" rx="4.5" />
          <rect className="bot__ear" x="98" y="36" width="9" height="18" rx="4.5" />
          <rect className="bot__shell" x="19" y="17" width="82" height="57" rx="21" />
          <rect className="bot__screen" x="27" y="26" width="66" height="39" rx="14" />
          {/* 眼睛 */}
          {motion === 'sleep' ? (
            <g className="bot__line">
              <path d="M39 46 H52" />
              <path d="M68 46 H81" />
            </g>
          ) : motion === 'yawn' ? (
            <g className="bot__line">
              <path d="M39 44 Q45.5 49 52 44" />
              <path d="M68 44 Q74.5 49 81 44" />
            </g>
          ) : motion === 'scared' ? (
            <g>
              <circle className="bot__eyeball" cx="45.5" cy="44" r="7" />
              <circle className="bot__eyeball" cx="74.5" cy="44" r="7" />
              <circle className="bot__pupil" cx="45.5" cy="44" r="2.6" />
              <circle className="bot__pupil" cx="74.5" cy="44" r="2.6" />
            </g>
          ) : happy ? (
            <g className="bot__line">
              <path d="M39 47 Q45.5 37 52 47" />
              <path d="M68 47 Q74.5 37 81 47" />
            </g>
          ) : (
            <g className="bot__eyes">
              <rect className="bot__eye" x="41" y="37" width="9" height="14" rx="4.5" />
              <rect className="bot__eye" x="70" y="37" width="9" height="14" rx="4.5" />
            </g>
          )}
          {/* 嘴 */}
          {motion === 'yawn' ? (
            <ellipse className="bot__mouth bot__mouth--yawn" cx="60" cy="57" rx="4.5" ry="5.5" />
          ) : motion === 'scared' ? (
            <ellipse className="bot__mouth" cx="60" cy="58" rx="2.6" ry="3.4" />
          ) : motion === 'sleep' ? (
            <path className="bot__line" d="M56 58 H64" />
          ) : happy ? (
            <path className="bot__mouth" d="M51 54 Q60 65 69 54 Z" />
          ) : (
            <path className="bot__line" d="M53 56 Q60 61 67 56" />
          )}
          <circle className="bot__cheek" cx="35" cy="55" r="3.4" />
          <circle className="bot__cheek" cx="85" cy="55" r="3.4" />
          {shades && (
            <g className="bot__shades">
              <rect x="34" y="35" width="23" height="15" rx="6" />
              <rect x="63" y="35" width="23" height="15" rx="6" />
              <path d="M57 41 H63" className="bot__bridge" />
              <path d="M38 38 L44 38 L40 44 Z" className="bot__glint" />
            </g>
          )}
          {shades && <path className="bot__sweat" d="M95 22 q5 8 0 10.5 q-5 -2.5 0 -10.5 Z" />}
          {hat && (
            <g className="bot__hat" transform="rotate(16 66 18)">
              <path d="M66 -10 L80 19 L52 19 Z" fill="#f5c542" />
              <path d="M59 5 L73 5 M55.5 12.5 L76.5 12.5" stroke="#ff6fae" strokeWidth="3" />
              <circle cx="66" cy="-10" r="4.5" fill="#ff6fae" />
            </g>
          )}
        </g>
        {motion === 'catch' && (
          <g className="bot__coins">
            <circle className="bot__coin" cx="40" cy="20" r="6" />
            <circle className="bot__coin" cx="80" cy="10" r="6" />
            <circle className="bot__coin" cx="60" cy="0" r="6" />
          </g>
        )}
      </g>
      {(motion === 'sleep' || motion === 'yawn') && (
        <g className="bot__zzz">
          <text x="96" y="20">
            z
          </text>
          <text x="104" y="8">
            z
          </text>
          <text x="110" y="-4">
            Z
          </text>
        </g>
      )}
      {(motion === 'dance' || motion === 'party') && (
        <g className="bot__notes">
          <text x="4" y="30">
            ♪
          </text>
          <text x="104" y="40">
            ♫
          </text>
        </g>
      )}
    </svg>
  );
}

// ─── 心情：由实时数据决定 ─────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const KIND: Record<string, string> = { in: '转入', out: '转出', buy: '买入代币', sell: '卖出代币', fee: '手续费', other: '其他', stake: '质押', unstake: '取回质押' };
const sayNum = (v: number) => (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4)).replace(/\.?0+$/, '');
const md = (ms: number) => `${new Date(ms).getMonth() + 1} 月 ${new Date(ms).getDate()} 日`;

export interface MascotState {
  motion: Motion;
  shades: boolean;
  hat: boolean;
  line: string;
  eta: GoalEta | null;
  goal: GoalView | null;
  tap: () => void;
  boop: boolean;
}

export function useMascot(): MascotState | null {
  const snap = useStore((s) => s.snap);
  const points = useTreasuryHistory();
  const solTo = useSolTo();
  const { primary } = useCur();
  const now = useNow(1000);
  const [react, setReact] = useState<{ mood: Reaction; sol?: number; until: number } | null>(null);
  const [taps, setTaps] = useState(0);
  const [boop, setBoop] = useState(false);
  const boopTimer = useRef<number>(undefined);

  useEffect(
    () =>
      onFx((e) => {
        if (e.type !== 'react') return;
        setReact({ mood: e.mood, sol: e.sol, until: Date.now() + (e.mood === 'party' ? 9000 : 5500) });
      }),
    [],
  );

  const goal = snap?.goal ?? null;
  const total = snap?.treasury.totalSol ?? 0;
  const eta = useMemo(() => (goal ? goalEta(points, total, goal.target, goal.startSol) : null), [goal, points, total]);

  if (!snap) return null;
  const t = snap.treasury;
  const nowSec = now / 1000;
  const r = react && now < react.until ? react : null;

  // 24 小时：SOL 价格变化、公司资产价值变化
  const usd24 = t.solUsd24hAgo;
  const priceChange = usd24 ? snap.solPrice.usd / usd24 - 1 : null;
  const value24 = t.totalSol24hAgo !== null && usd24 ? t.totalSol24hAgo * usd24 : null;
  const valueNow = total * snap.solPrice.usd;
  const valueDiff = value24 !== null ? valueNow - value24 : null;
  const valuePct = value24 && value24 > 0 ? valueNow / value24 - 1 : null;

  const hour = new Date(now).getHours();
  const night = hour < 5;
  const last = t.activity[0];
  const lastNight = !!last && nowSec - last.ts < 30 * 60 && new Date(last.ts * 1000).getHours() < 5;
  const solDrop = priceChange !== null && priceChange <= -0.05;
  const assetsUp = valueDiff !== null && valueDiff > 0 && (valuePct === null || valuePct > 0.005);
  const goalJust = !!goal?.reachedAt && nowSec - goal.reachedAt < 3 * 86400;

  let motion: Motion = 'idle';
  if (r?.mood === 'catch') motion = 'catch';
  else if (r?.mood === 'party') motion = 'party';
  else if (r?.mood === 'scared') motion = 'scared';
  else if (lastNight) motion = 'yawn';
  else if (night) motion = 'sleep';
  else if (assetsUp) motion = 'dance';

  const money = (sol: number) => fmtMoney(sol * solTo[primary], primary);
  const dropText = priceChange !== null ? fmtPct(Math.abs(priceChange), 1) : '';
  let line: string;
  if (motion === 'catch') line = `接住啦！+${sayNum(r?.sol ?? 0)} SOL 💰`;
  else if (motion === 'party') line = goalJust && goal ? `目标达成！${fmtNum(goal.target, goal.target % 1 ? 2 : 0)} SOL 🎉🎉🎉` : '解锁新成就啦！🏆';
  else if (motion === 'scared') line = '有人冒充我们常用的地址！转账千万别从记录里复制 🛡️';
  else if (motion === 'yawn' && last) {
    const d = new Date(last.ts * 1000);
    line = `哈——欠……都 ${pad(d.getHours())}:${pad(d.getMinutes())} 了还有交易：${KIND[last.kind] ?? '交易'} ${last.deltaSol > 0 ? '+' : ''}${sayNum(last.deltaSol)} SOL 🥱`;
  } else if (motion === 'sleep') line = 'Zzz……凌晨了，链上很安静，有动静我会醒的';
  else if (motion === 'dance') {
    line = solDrop
      ? `SOL 跌了 ${dropText}，但公司资产还在涨，跳就完事了 😎`
      : `24 小时资产 +${money(Math.abs(valueDiff ?? 0) / snap.solPrice.usd)}${valuePct !== null && valuePct < 10 ? `（+${fmtPct(valuePct, 1)}）` : ''}，开心到跳舞！💃`;
  } else if (solDrop) line = `SOL 24 小时跌了 ${dropText}……我很淡定 😎`;
  else {
    const facts: string[] = [];
    if (eta && goal && !goal.reachedAt) facts.push(`离${goal.label ? `「${goal.label}」` : '目标'} ${fmtNum(goal.target, 0)} SOL 还差 ${fmtSol(eta.remaining)} SOL${eta.eta ? `，照现在的速度 ${md(eta.eta)} 就能到` : ''}，冲！`);
    facts.push(`公司钱包里现在有 ${fmtSol(total)} SOL，约 ${money(total)}`);
    facts.push(`我已经帮你数了 ${fmtNum(t.activityCount, 0)} 笔交易 🧮`);
    if (points.length) facts.push(`今天是公司钱包的第 ${Math.floor((nowSec - points[0].t) / 86400) + 1} 天`);
    facts.push(`SOL 现在 ${money(1)}${priceChange !== null ? `，24 小时 ${priceChange >= 0 ? '+' : ''}${fmtPct(priceChange, 1)}` : ''}`);
    facts.push('转账前核对完整地址，别从交易记录里复制哦 🛡️');
    line = taps === 0 && Math.floor(now / 9000) % facts.length === facts.length - 1 ? '点我一下试试？👆' : facts[(Math.floor(now / 9000) + taps) % facts.length];
  }

  return {
    motion,
    shades: solDrop,
    hat: goalJust || motion === 'party',
    line,
    eta,
    goal,
    boop,
    tap: () => {
      setTaps((n) => n + 1);
      setBoop(true);
      clearTimeout(boopTimer.current);
      boopTimer.current = window.setTimeout(() => setBoop(false), 650);
    },
  };
}

// ─── 目标进度条（机器人站在上面走） ───────────────────────────

export function GoalWalk({ m, showBot, big }: { m: MascotState; showBot: boolean; big?: boolean }) {
  const { goal, eta } = m;
  const solTo = useSolTo();
  const { primary } = useCur();
  const total = useStore((s) => s.snap?.treasury.totalSol ?? 0);
  const p = goal && eta ? (goal.reachedAt ? 1 : eta.pct) : 0.04;
  const size = big ? 118 : 84;
  return (
    <div className="walk" style={{ ['--p' as string]: String(Math.min(1, p) * 0.86), ['--bot' as string]: `${size}px` }}>
      {showBot && (
        <>
          <div className="walk__bubble" role="status" aria-live="polite">
            {m.line}
          </div>
          <div className="walk__stage" style={{ height: (size * 146) / 120 - 6 }}>
            <button type="button" className="walk__bot" onClick={m.tap} aria-label="VK 小助手（点一下换一句）">
              <Mascot motion={m.motion} shades={m.shades} hat={m.hat} size={size} boop={m.boop} />
            </button>
          </div>
        </>
      )}
      {goal && eta && (
        <>
          <div className={`goal-track ${goal.reachedAt ? 'goal-track--done' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(eta.pct * 100)} aria-label="公司目标进度">
            <div className="goal-track__fill" style={{ width: `${(goal.reachedAt ? 1 : eta.pct) * 100}%` }} />
            <span className="goal-track__flag">🏁</span>
          </div>
          <div className="goal-meta">
            <span>
              <b>{fmtSol(total)}</b> / {fmtNum(goal.target, goal.target % 1 ? 2 : 0)} SOL（{fmtPct(goal.reachedAt ? 1 : eta.pct, 0)}）{goal.label ? ` · ${goal.label}` : ''}
            </span>
            {goal.reachedAt ? (
              <span className="up">🎉 {md(goal.reachedAt * 1000)}达成！</span>
            ) : (
              <span>
                还差 <b>{fmtSol(eta.remaining)} SOL</b>（{fmtMoney(eta.remaining * solTo[primary], primary)}）
              </span>
            )}
          </div>
          {!goal.reachedAt && (
            <div className="goal-eta">
              {eta.eta
                ? `按最近 ${Math.round(eta.windowDays)} 天平均每天 +${fmtSol(eta.ratePerDay)} SOL，预计 ${new Date(eta.eta).getFullYear()} 年 ${md(eta.eta)}达成`
                : `最近 ${Math.round(eta.windowDays)} 天资产没有增长，暂时估算不出达成日期`}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GoalForm({ goal, onDone }: { goal: GoalView | null; onDone: () => void }) {
  const total = useStore((s) => s.snap?.treasury.totalSol ?? 0);
  const suggest = [50, 100, 200, 500, 1000, 5000].find((v) => v > total * 1.1) ?? Math.ceil(total * 2);
  const [target, setTarget] = useState(goal && !goal.reachedAt ? String(goal.target) : String(suggest));
  const [label, setLabel] = useState(goal && !goal.reachedAt ? (goal.label ?? '') : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (t: number | null) => {
    setErr('');
    setBusy(true);
    try {
      await saveGoal(t, label);
      toast(t ? `目标已设为 ${t} SOL` : '已清除目标');
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="sub-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(Number(target));
      }}
    >
      <div className="grid-form">
        <div className="field">
          <label htmlFor="goal-target">目标（公司总资产，SOL）</label>
          <input id="goal-target" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="goal-label">名字（可不填）</label>
          <input id="goal-label" value={label} maxLength={16} onChange={(e) => setLabel(e.target.value)} placeholder="例如 年底冲刺" />
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        现在 {fmtSol(total)} SOL。达成时所有人的 App 都会放烟花，开了提醒的手机会收到推送。
      </div>
      {err && <div className="error">{err}</div>}
      <div className="wm__actions">
        {goal && (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => confirm('清除当前目标？') && void run(null)}>
            清除目标
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          取消
        </button>
        <button type="submit" className="btn btn--solid" disabled={busy || !(Number(target) > 0)}>
          保存
        </button>
      </div>
    </form>
  );
}

/** 首页：吉祥物 + 公司目标 */
export function MascotCard() {
  const m = useMascot();
  const prefs = usePrefs();
  const role = useStore((s) => s.access?.role ?? 'public');
  const [editing, setEditing] = useState(false);
  if (!m) return null;
  if (!prefs.mascot && !m.goal && role !== 'admin') return null;
  const admin = role === 'admin';
  return (
    <section className="card mascot-card" aria-label="VK 小助手和公司目标">
      {(m.goal || admin) && (
        <header className="card__head" style={{ marginBottom: 6 }}>
          <div>
            <div className="kicker">{m.goal ? 'Company Goal' : 'VK Buddy'}</div>
            <h2 className="card__title" style={{ margin: 0 }}>
              {m.goal ? (m.goal.reachedAt ? '目标达成 🎉' : `公司目标${m.goal.label ? ` · ${m.goal.label}` : ''}`) : 'VK 小助手'}
            </h2>
          </div>
          {admin && !editing && (
            <button type="button" className="chip chip--accent" onClick={() => setEditing(true)}>
              {m.goal ? (
                m.goal.reachedAt ? (
                  <>
                    <Flag size={11} /> 设下一个目标
                  </>
                ) : (
                  <>
                    <Pencil size={11} /> 改目标
                  </>
                )
              ) : (
                <>
                  <Flag size={11} /> 设一个目标
                </>
              )}
            </button>
          )}
          {admin && editing && (
            <button type="button" className="chip" onClick={() => setEditing(false)} aria-label="关闭">
              <X size={11} />
            </button>
          )}
        </header>
      )}
      <GoalWalk m={m} showBot={prefs.mascot} />
      {admin && editing && <GoalForm goal={m.goal} onDone={() => setEditing(false)} />}
    </section>
  );
}
