import { Maximize, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SolCandles, TreasuryActivity } from '../../../shared/types';
import { GoalWalk, useMascot } from '../components/Mascot';
import { useCur } from '../components/Shell';
import { getJSON } from '../lib/api';
import { useAchievements } from '../lib/explore';
import { CUR_SYMBOL, fmtMoney, fmtNum, fmtPct, fmtSol, type Cur } from '../lib/format';
import { speak, unlockAudio, unlockSpeech } from '../lib/fx';
import { go, useNow, useSolTo } from '../lib/hooks';
import { setPrefs, usePrefs } from '../lib/prefs';
import { useStore } from '../lib/store';

const pad = (n: number) => String(n).padStart(2, '0');
const KIND: Record<string, string> = { in: '转入', out: '转出', buy: '买入代币', sell: '卖出代币', fee: '手续费', other: '其他', stake: '质押', unstake: '取回质押' };

/** 数字变化时平滑滚动过去 */
function useTween(value: number, ms = 1400) {
  const [v, setV] = useState(value);
  const from = useRef(value);
  const shown = useRef(value);
  useEffect(() => {
    from.current = shown.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const f = Math.min(1, (now - start) / ms);
      const e = 1 - (1 - f) ** 3;
      shown.current = from.current + (value - from.current) * e;
      setV(shown.current);
      if (f < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return v;
}

function Sparkline({ candles }: { candles: SolCandles | null }) {
  const pts = candles?.candles ?? [];
  if (pts.length < 2) return <div className="scr-spark" />;
  const vals = pts.map((c) => c.c);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const X = (i: number) => (i / (pts.length - 1)) * 300;
  const Y = (v: number) => 56 - ((v - lo) / (hi - lo || 1)) * 50;
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg className={`scr-spark ${up ? 'up' : 'down'}`} viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden>
      <path d={`${line}L300,60L0,60Z`} className="scr-spark__area" />
      <path d={line} className="scr-spark__line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function FlowRow({ a, fresh }: { a: TreasuryActivity; fresh: boolean }) {
  const solTo = useSolTo();
  const { primary } = useCur();
  const d = new Date(a.ts * 1000);
  const up = a.deltaSol > 0;
  const title = a.poisonOf ? '⚠️ 地址投毒' : a.dust ? '零额转账' : (KIND[a.kind] ?? '交易');
  return (
    <div className={`scr-flow ${fresh ? 'scr-flow--new' : ''} ${a.dust || a.poisonOf ? 'scr-flow--dim' : ''}`}>
      <span className="scr-flow__time">
        {pad(d.getMonth() + 1)}-{pad(d.getDate())} {pad(d.getHours())}:{pad(d.getMinutes())}
      </span>
      <span className="scr-flow__kind">{title}</span>
      <span className={`scr-flow__amt ${up ? 'up' : 'down'}`}>
        {up ? '+' : '−'}
        {fmtSol(Math.abs(a.deltaSol))}
        <small>{fmtMoney(Math.abs(a.deltaSol) * solTo[primary], primary)}</small>
      </span>
    </div>
  );
}

export function ScreenPage() {
  const snap = useStore((s) => s.snap);
  const conn = useStore((s) => s.conn);
  const prefs = usePrefs();
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const now = useNow(1000);
  const m = useMascot();
  const ach = useAchievements();
  const [started, setStarted] = useState(false);
  const [candles, setCandles] = useState<SolCandles | null>(null);
  const [cursor, setCursor] = useState(true);
  const seen = useRef<Set<string> | null>(null);
  const freshIds = useRef(new Map<string, number>());
  const total = snap?.treasury.totalSol ?? 0;
  // 稳定币（1 枚 = 1 美元）计入总资产的显示；分红池仍只按 SOL
  const stableUsd = snap?.treasury.stables?.usd ?? 0;
  const usdTo = (c: Cur) => (c === 'usd' ? 1 : c === 'cny' ? (snap?.solPrice.usdCny ?? 0) : 0);
  const shown = useTween(total * solTo[primary] + stableUsd * usdTo(primary));

  useEffect(() => {
    const load = () =>
      getJSON<SolCandles>('/api/sol/candles?range=24h')
        .then(setCandles)
        .catch(() => {});
    void load();
    const id = window.setInterval(load, 5 * 60_000);
    return () => clearInterval(id);
  }, []);

  // 鼠标不动 3 秒后隐藏光标和退出按钮
  useEffect(() => {
    let t = window.setTimeout(() => setCursor(false), 3000);
    const move = () => {
      setCursor(true);
      clearTimeout(t);
      t = window.setTimeout(() => setCursor(false), 3000);
    };
    window.addEventListener('pointermove', move);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointermove', move);
    };
  }, []);

  // 屏幕常亮
  useEffect(() => {
    if (!started) return;
    let lock: any = null;
    const req = () =>
      (navigator as any).wakeLock
        ?.request('screen')
        .then((l: any) => (lock = l))
        .catch(() => {});
    void req();
    const vis = () => document.visibilityState === 'visible' && void req();
    document.addEventListener('visibilitychange', vis);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      lock?.release?.().catch?.(() => {});
    };
  }, [started]);

  // 新出现的流水：高亮几秒
  const activity = snap?.treasury.activity ?? [];
  if (activity.length) {
    if (!seen.current) seen.current = new Set(activity.map((a) => a.id));
    for (const a of activity) {
      if (!seen.current.has(a.id)) {
        seen.current.add(a.id);
        freshIds.current.set(a.id, Date.now());
      }
    }
  }

  const ticker = useMemo(() => {
    if (!snap) return [];
    const t = snap.treasury;
    const items: string[] = [];
    const usd24 = t.solUsd24hAgo;
    if (t.totalSol24hAgo !== null && usd24) {
      const d = total * snap.solPrice.usd - t.totalSol24hAgo * usd24;
      items.push(`📊 24 小时资产 ${d >= 0 ? '+' : '−'}${fmtMoney((Math.abs(d) / snap.solPrice.usd) * solTo[primary], primary)}`);
    }
    if (m?.goal && m.eta && !m.goal.reachedAt) items.push(`🏁 离目标 ${fmtNum(m.goal.target, 0)} SOL 还差 ${fmtSol(m.eta.remaining)} SOL`);
    items.push(`🎁 股东分红池 ${fmtMoney(total * t.dividendRatio * solTo[primary], primary)}（总资产 × ${fmtPct(t.dividendRatio, 0)}）`);
    items.push(`🧮 公司钱包累计 ${fmtNum(t.activityCount, 0)} 笔交易`);
    for (const a of ach?.list.filter((x) => x.level > 0 && x.detail).slice(0, 6) ?? []) items.push(`${a.icon} ${a.name}：${a.detail}`);
    items.push('🛡️ 转账前请核对完整地址，不要从交易记录里复制');
    return items;
  }, [snap, total, m?.goal, m?.eta, ach, solTo, primary]);

  if (!snap || !m) return <div className="screen screen--loading">VectorKeith 正在连接…</div>;
  const t = snap.treasury;
  const usd24 = t.solUsd24hAgo;
  const priceChange = usd24 ? snap.solPrice.usd / usd24 - 1 : null;
  const value24 = t.totalSol24hAgo !== null && usd24 ? t.totalSol24hAgo * usd24 : null;
  const diffUsd = value24 !== null ? total * snap.solPrice.usd - value24 : null;
  const near = (ach?.list ?? []).filter((a) => a.level < a.maxLevel).sort((a, b) => b.progress - a.progress).slice(0, 3);
  const nowD = new Date(now);
  const flows = activity.slice(0, 9);

  const start = async () => {
    unlockAudio();
    unlockSpeech();
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      /* 有的电视浏览器不支持全屏 */
    }
    setStarted(true);
    speak('VectorKeith 大屏已开启');
  };

  return (
    <div className={`screen ${cursor ? '' : 'screen--idle'}`}>
      {!started && (
        <div className="scr-start">
          <div className="scr-start__box">
            <img src="/icons/icon-192.png" alt="" width={72} height={72} />
            <h1>公司资产实时大屏</h1>
            <p>适合放在前台或会议室的电视、电脑上。一进钱就满屏金币雨，开了语音会播报"VectorKeith 到账 xx SOL"。</p>
            <label className="checkbox">
              <input type="checkbox" checked={prefs.voice} onChange={(e) => setPrefs({ voice: e.target.checked })} />
              到账语音播报
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={prefs.sound} onChange={(e) => setPrefs({ sound: e.target.checked })} />
              "叮"的音效
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={prefs.fx} onChange={(e) => setPrefs({ fx: e.target.checked })} />
              金币雨、烟花特效
            </label>
            <button type="button" className="btn btn--solid" onClick={() => void start()}>
              <Maximize size={18} /> 点击开始（全屏）
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setStarted(true)}>
              不全屏，直接看
            </button>
          </div>
        </div>
      )}

      <header className="scr-head">
        <img src="/icons/icon-192.png" alt="" />
        <div>
          <div className="scr-brand">VECTORKEITH</div>
          <div className="scr-sub">公司资产实时大屏 · 数据直连 Solana 主网</div>
        </div>
        <div className="scr-clock">
          <b>
            {pad(nowD.getHours())}:{pad(nowD.getMinutes())}
            <small>:{pad(nowD.getSeconds())}</small>
          </b>
          <span>
            {nowD.getFullYear()}-{pad(nowD.getMonth() + 1)}-{pad(nowD.getDate())} · <i className={`scr-dot scr-dot--${conn}`} />
            {conn === 'live' ? '实时' : '重连中'}
          </span>
        </div>
        <div className="scr-tools">
          <button type="button" className="icon-btn" aria-label={prefs.voice ? '关闭语音播报' : '打开语音播报'} onClick={() => (setPrefs({ voice: !prefs.voice }), !prefs.voice && (unlockSpeech(), speak('语音播报已开启', true)))}>
            {prefs.voice ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
          <button type="button" className="icon-btn" aria-label="退出大屏" onClick={() => (document.fullscreenElement && document.exitFullscreen().catch(() => {}), go('assets'))}>
            <X size={18} />
          </button>
        </div>
      </header>

      <main className="scr-grid">
        <section className="scr-card scr-hero">
          <div className="scr-k">公司总资产</div>
          <div className="scr-big">
            <small>{CUR_SYMBOL[primary]}</small>
            {fmtNum(shown, 2)}
          </div>
          <div className="scr-hero__sub">
            <span>{fmtMoney(total * solTo[secondary] + stableUsd * usdTo(secondary), secondary)}</span>
            <span>{fmtSol(total)} SOL</span>
            {stableUsd > 0 && <span>+ {fmtNum(stableUsd, 2)} USDT/USDC</span>}
            {diffUsd !== null && Math.abs(diffUsd) > 0.01 && (
              <span className={diffUsd > 0 ? 'up' : 'down'}>
                24h {diffUsd > 0 ? '▲' : '▼'} {fmtMoney((Math.abs(diffUsd) / snap.solPrice.usd) * solTo[primary], primary)}
              </span>
            )}
          </div>
          <div className="scr-walk">
            <GoalWalk m={m} showBot={prefs.mascot} big />
          </div>
        </section>

        <section className="scr-card scr-flows">
          <div className="scr-k">资金流水</div>
          {flows.map((a) => (
            <FlowRow key={a.id} a={a} fresh={now - (freshIds.current.get(a.id) ?? 0) < 8000} />
          ))}
          {!flows.length && <div className="scr-muted">还没有流水</div>}
        </section>

        <section className="scr-card scr-sol">
          <div className="scr-k">SOL 价格</div>
          <div className="scr-mid">
            {fmtMoney(solTo[primary], primary)}
            {priceChange !== null && (
              <span className={priceChange >= 0 ? 'up' : 'down'}>
                {priceChange >= 0 ? '▲' : '▼'} {fmtPct(Math.abs(priceChange), 2)}
              </span>
            )}
          </div>
          <div className="scr-muted">
            {fmtMoney(solTo[secondary], secondary)} · 24 小时走势
          </div>
          <Sparkline candles={candles} />
        </section>

        <section className="scr-card scr-div">
          <div className="scr-k">股东分红池（{fmtPct(t.dividendRatio, 0)}）</div>
          <div className="scr-mid">{fmtMoney(total * t.dividendRatio * solTo[primary], primary)}</div>
          <div className="scr-muted">
            {fmtMoney(total * t.dividendRatio * solTo[secondary], secondary)} · {fmtSol(total * t.dividendRatio)} SOL
          </div>
          {t.stakedSol > 0 && <div className="scr-muted">其中质押中 {fmtSol(t.stakedSol)} SOL</div>}
        </section>

        <section className="scr-card scr-ach">
          <div className="scr-k">
            成就 {ach ? `${ach.unlocked}/${ach.total}` : ''}
          </div>
          <div className="scr-icons">{ach?.list.filter((a) => a.level > 0).map((a) => <span key={a.id}>{a.icon}</span>)}</div>
          {near.map((a) => (
            <div key={a.id} className="scr-near">
              <span>
                {a.icon} {a.name} {a.nextLabel ?? ''}
              </span>
              <span className="scr-muted">{a.progressText ?? fmtPct(a.progress, 0)}</span>
              <div className="badge-meter">
                <div style={{ width: `${a.progress * 100}%` }} />
              </div>
            </div>
          ))}
        </section>
      </main>

      <footer className="scr-ticker" aria-hidden>
        <div className="scr-ticker__run" style={{ animationDuration: `${Math.max(30, ticker.join('').length * 0.35)}s` }}>
          {[...ticker, ...ticker].map((x, i) => (
            <span key={i}>{x}</span>
          ))}
        </div>
      </footer>
    </div>
  );
}
