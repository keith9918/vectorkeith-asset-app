import { Pause, Play, SkipBack, SkipForward, Sparkles } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Achievement, ActivityKind, TreasuryHistoryPoint } from '../../../shared/types';
import { useCur } from '../components/Shell';
import { Card, copyText, Seg, toast } from '../components/ui';
import { fmtDate, fmtMoney, fmtNum, fmtPct, fmtSol, type Cur } from '../lib/format';
import { fx, speak, unlockAudio, unlockSpeech } from '../lib/fx';
import { useAchievements, useSolLevels } from '../lib/explore';
import { useTreasuryHistory } from '../lib/history';
import { useSolTo } from '../lib/hooks';
import { setPrefs, usePrefs } from '../lib/prefs';
import { useShareholders } from '../lib/shareholders';
import { useStore } from '../lib/store';
import { Loading } from './common';

const KIND: Record<ActivityKind, string> = { in: '转入', out: '转出', buy: '买入代币', sell: '卖出代币', fee: '手续费', other: '其他', stake: '质押', unstake: '取回质押', stableIn: '稳定币转入', stableOut: '稳定币转出' };
const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (sec: number) => {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hm = (sec: number) => {
  const d = new Date(sec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtSol(Math.abs(v))}`;

// ─── 成就墙 ───────────────────────────────────────────────────

function BadgeMeter({ value }: { value: number }) {
  return (
    <div className="badge-meter" aria-hidden>
      <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

function BadgeDetail({ a }: { a: Achievement }) {
  const maxed = a.level >= a.maxLevel;
  return (
    <div className="badge-detail" role="region" aria-label={`${a.name} 详情`}>
      <div className={`badge-detail__icon ${a.level ? 'on' : ''}`}>{a.icon}</div>
      <div style={{ minWidth: 0 }}>
        <div className="badge-detail__name">
          {a.name}
          {a.maxLevel > 1 && <span className="chip chip--accent">{a.level ? `Lv${a.level} · ${a.levelLabel}` : '未解锁'}</span>}
        </div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {a.desc}
          {a.maxLevel > 1 && a.nextLabel ? ` ${a.nextLabel}` : ''}
        </div>
        {a.unlockedAt && <div style={{ fontSize: 12.5, marginTop: 4 }}>解锁于 {fmtDate(a.unlockedAt * 1000, false)}</div>}
        {a.detail && <div style={{ fontSize: 12.5, marginTop: 2 }}>{a.detail}</div>}
        {!maxed && (
          <div style={{ marginTop: 8 }}>
            <div className="badge-detail__next">
              <span>{a.level ? `下一级：${a.nextLabel ?? ''}` : '解锁进度'}</span>
              <span className="mono">{a.progressText ?? fmtPct(a.progress, 0)}</span>
            </div>
            <BadgeMeter value={a.progress} />
          </div>
        )}
        {maxed && a.maxLevel > 1 && <div className="up" style={{ fontSize: 12.5, marginTop: 4 }}>已满级 ✓</div>}
      </div>
    </div>
  );
}

function AchievementWall() {
  const v = useAchievements();
  const [sel, setSel] = useState<string | null>(null);
  if (!v) {
    return (
      <Card kicker="Achievements" title="成就墙">
        <div className="muted" style={{ fontSize: 12.5 }}>正在计算…</div>
      </Card>
    );
  }
  const now = Date.now() / 1000;
  const selected = v.list.find((a) => a.id === sel);
  return (
    <Card kicker="Achievements" title="成就墙" right={<span className="chip chip--accent">已解锁 {v.unlocked}/{v.total}</span>}>
      <BadgeMeter value={v.unlocked / v.total} />
      <div className="badges">
        {v.list.map((a) => {
          const isNew = !!a.unlockedAt && now - a.unlockedAt < 3 * 86400;
          return (
            <button
              key={a.id}
              type="button"
              className={`badge ${a.level ? 'badge--on' : ''} ${sel === a.id ? 'badge--sel' : ''}`}
              aria-pressed={sel === a.id}
              onClick={() => setSel(sel === a.id ? null : a.id)}
            >
              {isNew && <span className="badge__new">NEW</span>}
              <span className="badge__icon">{a.icon}</span>
              <span className="badge__name">{a.name}</span>
              <span className="badge__lv">{a.maxLevel > 1 ? (a.level ? `Lv${a.level} · ${a.levelLabel}` : `0/${a.maxLevel}`) : a.level ? '已解锁' : '未解锁'}</span>
              {a.level < a.maxLevel && <BadgeMeter value={a.progress} />}
            </button>
          );
        })}
      </div>
      {selected && <BadgeDetail a={selected} />}
      <p className="card__note">全部从公司钱包的链上历史算出来，每有新交易就重算一次。解锁新等级时会播放动画；开了手机提醒的话还会收到通知。点徽章看详情。</p>
    </Card>
  );
}

// ─── 资产时光机 ───────────────────────────────────────────────

const kindLabel = (q: TreasuryHistoryPoint) => (q.k === 'in' && Math.abs(q.d ?? 0) < 0.001 ? '零额转账' : KIND[q.k ?? 'other']);

type Axis = 'tx' | 'time';

function TimeMachine() {
  const pts = useTreasuryHistory();
  const solTo = useSolTo();
  const usdCny = useStore((s) => s.snap?.solPrice.usdCny ?? 7.1);
  const { primary } = useCur();
  const [axis, setAxis] = useState<Axis>('tx');
  const [ci, setCi] = useState<number | null>(null); // 当前位置（数据点下标，回放时带小数）；null = 现在
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const clip = useId().replace(/:/g, '');

  const geo = useMemo(() => {
    const n = pts.length;
    if (n < 2) return null;
    const t0 = pts[0].t;
    const tN = pts[n - 1].t;
    const max = Math.max(...pts.map((p) => p.sol), 0.000001);
    // 横轴：按交易顺序（每笔交易占同样宽度）或按真实时间
    const xs = pts.map((p, i) => (axis === 'tx' ? (i / (n - 1)) * 1000 : ((p.t - t0) / Math.max(1, tN - t0)) * 1000));
    const Y = (v: number) => 194 - (v / max) * 180;
    let line = `M${xs[0].toFixed(2)},${Y(pts[0].sol).toFixed(2)}`;
    for (let i = 1; i < n; i++) line += `H${xs[i].toFixed(2)}V${Y(pts[i].sol).toFixed(2)}`;
    const area = `${line}V200H0Z`;
    const minD = Math.max(2, max * 0.08);
    const marks = pts.map((p, i) => ({ p, i })).filter(({ p }) => p.d !== undefined && Math.abs(p.d) >= minD).slice(-40);
    return { n, t0, tN, max, xs, Y, line, area, marks };
  }, [pts, axis]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  if (!geo) {
    return (
      <Card kicker="Time Machine" title="资产时光机">
        <div className="muted" style={{ fontSize: 12.5 }}>正在加载历史…</div>
      </Card>
    );
  }
  const { n, t0, tN, max, xs, Y, line, area, marks } = geo;
  const pos = Math.max(0, Math.min(n - 1, ci ?? n - 1)); // 数据变短（例如移除了钱包）时不越界
  const i = Math.min(n - 1, Math.floor(pos));
  const p = pts[i];
  const j = Math.min(n - 1, i + 1);
  const x = xs[i] + (xs[j] - xs[i]) * (pos - i); // 回放时十字线平滑移动
  const valueThen = p.sol * p.solUsd * (primary === 'usd' ? 1 : usdCny);
  const valueToday = p.sol * solTo[primary];
  const dayNo = Math.floor((p.t - t0) / 86400) + 1;
  const sameDay = pts.map((q, k) => ({ q, k })).filter(({ q }) => q.d !== undefined && dayKey(q.t) === dayKey(p.t));

  const stop = () => {
    cancelAnimationFrame(raf.current);
    setPlaying(false);
  };
  const go = (k: number | null) => {
    stop();
    setCi(k);
  };

  const play = () => {
    if (playing) return stop();
    unlockAudio();
    let start = ci === null || ci >= n - 1 ? 0 : Math.floor(ci);
    if (start >= n - 1) start = 0;
    const dur = Math.min(20_000, Math.max(9_000, (n - start) * 28));
    const begin = performance.now();
    let last = start;
    setPlaying(true);
    const step = (now: number) => {
      // 第一帧的时间戳可能比 begin 还早一点：夹到 0–1，否则下标会变成 -1
      const f = Math.max(0, Math.min(1, (now - begin) / dur));
      const fi = start + f * (n - 1 - start);
      const a = Math.floor(fi);
      // 经过大额入账：撒一把金币
      for (let k = last + 1; k <= a; k++) {
        const d = pts[k].d ?? 0;
        if (d >= Math.max(2, max * 0.08)) fx.sprinkle(d);
      }
      last = a;
      setCi(fi);
      if (f < 1) raf.current = requestAnimationFrame(step);
      else {
        setPlaying(false);
        setCi(null);
      }
    };
    raf.current = requestAnimationFrame(step);
  };

  /** 手指 / 鼠标在图上的位置 → 吸附到最近的数据点 */
  const scrub = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const target = ((clientX - r.left) / r.width) * 1000;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const k = lo > 0 && Math.abs(xs[lo - 1] - target) <= Math.abs(xs[lo] - target) ? lo - 1 : lo;
    go(k >= n - 1 ? null : k);
  };

  return (
    <Card
      kicker="Time Machine"
      title="资产时光机"
      right={
        <Seg<Axis>
          label="横轴"
          value={axis}
          onChange={setAxis}
          options={[
            { value: 'tx', label: '按交易' },
            { value: 'time', label: '按时间' },
          ]}
        />
      }
    >
      <div className="tm-read">
        <div className="tm-read__date">
          {ci === null ? '现在' : fmtDate(p.t * 1000)} · 第 {dayNo} 天 · 第 {i} 笔
        </div>
        <div className="tm-read__big">
          {fmtSol(p.sol)} <small>SOL</small>
        </div>
        <div className="tm-read__sub">
          {ci === null ? (
            <>
              现在价值 <b>{fmtMoney(valueToday, primary)}</b>（SOL ${fmtNum(p.solUsd, 2)}）
            </>
          ) : (
            <>
              当时价值 <b>{fmtMoney(valueThen, primary)}</b>（SOL ${fmtNum(p.solUsd, 2)}）· 按今天价格 {fmtMoney(valueToday, primary)}
            </>
          )}
        </div>
        <div className="tm-read__event">
          {p.d !== undefined ? (
            <>
              这一刻：{kindLabel(p)}
              {p.n && p.n > 1 ? ` 等 ${p.n} 笔` : ''} <b className={p.d > 0 ? 'up' : p.d < 0 ? 'down' : ''}>{signed(p.d)} SOL</b>
            </>
          ) : (
            <span className="muted">{ci === null ? '拖动或点"播放"回到过去' : '起点'}</span>
          )}
        </div>
      </div>

      <div
        ref={box}
        className="tm-chart"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          scrub(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons) scrub(e.clientX);
        }}
      >
        <span className="tm-chart__max">最高 {fmtNum(max, 2)} SOL</span>
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden>
          <defs>
            <clipPath id={clip}>
              <rect x="0" y="0" width={x} height="200" />
            </clipPath>
          </defs>
          <line x1="0" x2="1000" y1="14" y2="14" className="tm-grid" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2="1000" y1="194" y2="194" className="tm-grid" vectorEffect="non-scaling-stroke" />
          <path d={area} className="tm-area tm-area--dim" />
          <path d={line} className="tm-line tm-line--dim" vectorEffect="non-scaling-stroke" />
          <g clipPath={`url(#${clip})`}>
            <path d={area} className="tm-area" />
            <path d={line} className="tm-line" vectorEffect="non-scaling-stroke" />
          </g>
        </svg>
        {marks.map(({ p: m, i: k }) => (
          <i key={m.t} className={`tm-mark ${(m.d ?? 0) > 0 ? 'tm-mark--up' : 'tm-mark--down'}`} style={{ left: `${xs[k] / 10}%`, top: `${(Y(m.sol) / 200) * 100}%` }} />
        ))}
        <i className="tm-cross" style={{ left: `${x / 10}%` }} />
        <i className="tm-dot" style={{ left: `${x / 10}%`, top: `${(Y(p.sol) / 200) * 100}%` }} />
      </div>
      <div className="tm-axis">
        <span>{fmtDate(t0 * 1000, false)}</span>
        <span>{axis === 'tx' ? `按交易顺序 · 共 ${n - 2} 个时刻` : '按真实时间'}</span>
        <span>{fmtDate(tN * 1000, false)}</span>
      </div>

      <input
        className="tm-slider"
        type="range"
        min={0}
        max={n - 1}
        step={1}
        value={Math.round(pos)}
        aria-label="选择时刻"
        aria-valuetext={`${fmtDate(p.t * 1000)}，${fmtSol(p.sol)} SOL`}
        onChange={(e) => {
          const k = Number(e.target.value);
          go(k >= n - 1 ? null : k);
        }}
      />
      <div className="tm-ctrl">
        <button type="button" className="icon-btn" aria-label="回到起点" onClick={() => go(0)}>
          <SkipBack size={16} />
        </button>
        <button type="button" className="btn btn--solid tm-play" onClick={play}>
          {playing ? <Pause size={16} /> : <Play size={16} />} {playing ? '暂停' : '播放成长史'}
        </button>
        <button type="button" className="icon-btn" aria-label="回到现在" onClick={() => go(null)}>
          <SkipForward size={16} />
        </button>
      </div>

      <div className="wm__title" style={{ marginTop: 14 }}>
        {dayKey(p.t)} 这一天（{sameDay.length} 个时刻）
      </div>
      {sameDay.length ? (
        <div className="tm-day">
          {sameDay.slice(0, 12).map(({ q, k }) => (
            <button key={q.t} type="button" className={`tm-day__row ${k === i ? 'tm-day__row--on' : ''}`} onClick={() => go(k)}>
              <span className="mono">{hm(q.t)}</span>
              <span>
                {kindLabel(q)}
                {q.n && q.n > 1 ? ` ×${q.n}` : ''}
              </span>
              <b className={(q.d ?? 0) > 0 ? 'up' : (q.d ?? 0) < 0 ? 'down' : ''}>{signed(q.d ?? 0)}</b>
              <span className="muted mono">{fmtNum(q.sol, 2)}</span>
            </button>
          ))}
          {sameDay.length > 12 && <div className="muted" style={{ fontSize: 12, padding: '6px 0' }}>还有 {sameDay.length - 12} 个时刻，拖动滑杆查看</div>}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12.5 }}>这一天公司钱包没有交易。</div>
      )}
      <p className="card__note">
        拖动滑杆或在图上滑动，回到任意时刻看公司钱包里有多少 SOL；点"播放"从第一笔交易开始回放（经过大额入账会掉金币）。"按交易"让每笔交易占一样宽，"按时间"是真实的时间比例。"当时价值"用当时的 SOL 价格，人民币按现在的汇率换算。
      </p>
    </Card>
  );
}

// ─── 如果 SOL 涨到… ───────────────────────────────────────────

const PMIN = 10;

function PriceSimulator() {
  const snap = useStore((s) => s.snap);
  const role = useStore((s) => s.access?.role ?? 'public');
  const { view } = useShareholders();
  const levels = useSolLevels();
  const prefs = usePrefs();
  const { primary, secondary } = useCur();
  const now = snap?.solPrice.usd ?? 0;
  const [price, setPrice] = useState<number | null>(null);
  if (!snap || !(now > 0)) return null;
  const pmax = Math.max(1000, (levels?.ath?.usd ?? 0) * 2);
  const p = price ?? now;
  const toS = (v: number) => (Math.log(v / PMIN) / Math.log(pmax / PMIN)) * 1000;
  const fromS = (s: number) => PMIN * (pmax / PMIN) ** (s / 1000);
  const t = snap.treasury;
  const usdCny = snap.solPrice.usdCny;
  const to = (usd: number, c: Cur) => (c === 'usd' ? usd : c === 'sol' ? usd / p : usd * usdCny);
  const totalUsd = t.totalSol * p;
  const nowUsd = t.totalSol * now;
  const pool = totalUsd * t.dividendRatio;
  const me = role === 'holder' ? view?.holders[0] : undefined;
  const myPct = me ? me.pct : Math.max(0, Math.min(100, Number(prefs.holdPct) || 0));
  const ratio = p / now;

  const chips: { label: string; usd: number; sub?: string }[] = [{ label: '现价', usd: now }];
  if (levels?.avgIn) chips.push({ label: '公司入账均价', usd: levels.avgIn });
  if (levels?.yearLow) chips.push({ label: '今年最低', usd: levels.yearLow.usd, sub: fmtDate(levels.yearLow.t * 1000, false).slice(5) });
  if (levels?.yearHigh) chips.push({ label: '今年最高', usd: levels.yearHigh.usd, sub: fmtDate(levels.yearHigh.t * 1000, false).slice(5) });
  if (levels?.ath) chips.push({ label: '历史最高', usd: levels.ath.usd, sub: fmtDate(levels.ath.t * 1000, false).slice(0, 7) });
  chips.push({ label: '翻 2 倍', usd: now * 2 }, { label: '翻 10 倍', usd: now * 10 });

  let mood = '';
  if (Math.abs(ratio - 1) < 0.005) mood = '📍 这是现在的价格';
  else if (levels?.ath && p >= levels.ath.usd) mood = '🚀 比 SOL 历史最高价还高！';
  else if (levels?.yearHigh && p >= levels.yearHigh.usd) mood = '📈 回到今年的高点以上';
  else if (levels?.yearLow && p <= levels.yearLow.usd) mood = '🥶 比今年最低价还低';
  else if (levels?.avgIn) mood = p >= levels.avgIn ? '🙂 高于公司收到 SOL 时的平均价格' : '😬 低于公司收到 SOL 时的平均价格';

  return (
    <Card kicker="What If" title="如果 SOL 价格变成…" right={<span className="chip">{fmtNum(t.totalSol, 2)} SOL</span>}>
      <div className="sim-price">
        <span className="muted">SOL 价格</span>
        <b>${fmtNum(p, p >= 100 ? 0 : 2)}</b>
        <span className="muted">≈ ¥{fmtNum(p * usdCny, 0)}</span>
        <span className={`chip ${ratio > 1.005 ? 'chip--up' : ratio < 0.995 ? 'chip--down' : ''}`}>{ratio >= 1 ? `现价 × ${fmtNum(ratio, 2)}` : `现价的 ${fmtPct(ratio, 0)}`}</span>
      </div>
      <input
        className="tm-slider"
        type="range"
        min={0}
        max={1000}
        step={1}
        value={toS(p)}
        aria-label="SOL 价格"
        aria-valuetext={`$${fmtNum(p, 2)}`}
        onChange={(e) => setPrice(fromS(Number(e.target.value)))}
      />
      <div className="sim-chips">
        {chips.map((c) => (
          <button key={c.label} type="button" className={`chip ${Math.abs(c.usd - p) / p < 0.003 ? 'chip--accent' : ''}`} onClick={() => setPrice(c.label === '现价' ? null : c.usd)}>
            {c.label} ${fmtNum(c.usd, c.usd >= 100 ? 0 : 2)}
            {c.sub ? <span className="muted"> {c.sub}</span> : null}
          </button>
        ))}
      </div>

      <div className="sim-out">
        <div className="sim-out__k">公司总资产会是</div>
        <div className="sim-out__big">{fmtMoney(to(totalUsd, primary), primary)}</div>
        <div className="sim-out__sub">
          {fmtMoney(to(totalUsd, secondary), secondary)}
          {Math.abs(ratio - 1) >= 0.005 && (
            <>
              {' · '}
              <span className={totalUsd > nowUsd ? 'up' : 'down'}>
                比现在 {totalUsd >= nowUsd ? '+' : '−'}
                {fmtMoney(Math.abs(to(totalUsd - nowUsd, primary)), primary)}
              </span>
            </>
          )}
        </div>
        {mood && <div className="sim-mood">{mood}</div>}
      </div>
      <div className="grid-2" style={{ marginTop: 10 }}>
        <div className="tile">
          <div className="tile__label">分红池（{fmtPct(t.dividendRatio, 0)}）</div>
          <div className="tile__value">{fmtMoney(to(pool, primary), primary)}</div>
          <div className="tile__sub">{fmtMoney(to(pool, secondary), secondary)}</div>
        </div>
        <div className="tile">
          <div className="tile__label">{me ? `我的分红（${me.pct}%）` : `持股 ${myPct}% 应得`}</div>
          <div className="tile__value">{fmtMoney(to((pool * myPct) / 100, primary), primary)}</div>
          <div className="tile__sub">{me ? '按你的持股比例' : '比例可在「股东」页修改'}</div>
        </div>
      </div>
      <p className="card__note">假设公司钱包里的 SOL 数量不变（现在 {fmtNum(t.totalSol, 4)} SOL），只改变 SOL 价格；人民币按现在的汇率换算。参考价来自币安 K 线，"公司入账均价"是公司钱包每次收到 SOL 时价格的加权平均。</p>
    </Card>
  );
}

// ─── 特效实验室 ───────────────────────────────────────────────

function FxLab() {
  const prefs = usePrefs();
  const total = useStore((s) => s.snap?.treasury.totalSol ?? 0);
  const demo = (f: () => void) => {
    if (!prefs.fx) return toast('先打开"到账特效"');
    f();
  };
  return (
    <Card kicker="FX Lab" title="特效实验室" right={<Sparkles size={16} style={{ color: 'var(--accent)' }} />}>
      <div className="rows">
        <div className="row">
          <span className="row__k">到账特效（金币雨、解锁动画）</span>
          <Seg<'on' | 'off'> label="到账特效" value={prefs.fx ? 'on' : 'off'} onChange={(v) => setPrefs({ fx: v === 'on' })} options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]} />
        </div>
        <div className="row">
          <span className="row__k">到账语音播报</span>
          <Seg<'on' | 'off'>
            label="语音播报"
            value={prefs.voice ? 'on' : 'off'}
            onChange={(v) => {
              setPrefs({ voice: v === 'on' });
              if (v === 'on') {
                unlockSpeech();
                speak('语音播报已开启', true);
              }
            }}
            options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]}
          />
        </div>
        <div className="row">
          <span className="row__k">音效（"叮"）</span>
          <Seg<'on' | 'off'>
            label="音效"
            value={prefs.sound ? 'on' : 'off'}
            onChange={(v) => {
              setPrefs({ sound: v === 'on' });
              if (v === 'on') unlockAudio();
            }}
            options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]}
          />
        </div>
      </div>
      <div className="wm__actions" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={() => demo(() => fx.inflow(12.3456, total + 12.3456, '演示'))}>
          💰 金币雨
        </button>
        <button type="button" className="btn" onClick={() => demo(() => fx.badge('🐋', '巨鲸入账', '单笔转入达到 50 SOL（演示）', '50 SOL'))}>
          🏆 解锁成就
        </button>
        <button type="button" className="btn" onClick={() => demo(() => fx.poison('Ab3dWk…9xyz 冒充 VK-04（演示）'))}>
          ⚠️ 投毒警报
        </button>
        <button type="button" className="btn" onClick={() => demo(() => fx.goal(100, total, '演示'))}>
          🎆 目标达成
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            unlockSpeech();
            speak('VectorKeith 到账 12.35 SOL，约 6000 元', true);
          }}
        >
          🔊 试听语音
        </button>
      </div>
      <p className="card__note">公司钱包真的到账时会自动放金币雨，金额越大金币越多；识破地址投毒时屏幕闪红；达成公司目标时放烟花。语音播报像支付宝收款："VectorKeith 到账 xx SOL，约 xx 元"。音效和语音默认关，打开后 iPhone 需要先点一下屏幕才能出声。</p>
    </Card>
  );
}

function Entries() {
  const year = new Date(Date.now() + 8 * 3600_000).getUTCFullYear();
  const screenUrl = `${location.origin}/#/screen`;
  return (
    <div className="entry-grid">
      <a className="entry entry--report" href={`#/report?year=${year}`}>
        <span className="entry__icon">🎞️</span>
        <b>{year} 年度报告</b>
        <span>公司钱包这一年的高光时刻，还能生成海报</span>
      </a>
      <a className="entry entry--screen" href="#/screen">
        <span className="entry__icon">📺</span>
        <b>办公室大屏</b>
        <span>电视上全屏实时显示，进钱就放金币雨、语音播报</span>
        <button
          type="button"
          className="chip"
          onClick={(e) => {
            e.preventDefault();
            void copyText(screenUrl, '大屏网址已复制，在电视浏览器里打开');
          }}
        >
          复制大屏网址
        </button>
      </a>
    </div>
  );
}

export function ExplorePage() {
  const snap = useStore((s) => s.snap);
  if (!snap) return <Loading />;
  return (
    <>
      <Entries />
      <AchievementWall />
      <TimeMachine />
      <PriceSimulator />
      <FxLab />
    </>
  );
}
