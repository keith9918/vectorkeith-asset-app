import { useEffect, useRef, useState } from 'react';
import type { Achievement, AchievementsView } from '../../../shared/types';
import { getJSON } from '../lib/api';
import { fmtMoney, fmtNum, shortAddr } from '../lib/format';
import { fx, onFx, type FxCard } from '../lib/fx';
import { useSolTo } from '../lib/hooks';
import { useStore } from '../lib/store';
import { useCur } from './Shell';

// ─── 粒子：金币（翻转下落）与彩带 ─────────────────────────────
type Coin = { k: 'coin'; x: number; y: number; vx: number; vy: number; r: number; phase: number; spin: number };
type Conf = { k: 'conf'; x: number; y: number; vx: number; vy: number; w: number; h: number; rot: number; vr: number; color: string; life: number };
type Rocket = { k: 'rocket'; x: number; y: number; vx: number; vy: number; color: string };
type Spark = { k: 'spark'; x: number; y: number; vx: number; vy: number; color: string; life: number; max: number };
type P = Coin | Conf | Rocket | Spark;

const CONF_COLORS = ['#22d3ee', '#f5c542', '#16e0a0', '#9085e9', '#d55181', '#e8f4ff'];
const G = 0.0016; // 重力（像素 / 毫秒²）

function drawCoin(c: CanvasRenderingContext2D, p: Coin) {
  const s = Math.cos(p.phase);
  const w = Math.max(0.1, Math.abs(s)) * p.r;
  c.save();
  c.translate(p.x, p.y);
  // 微光
  c.globalAlpha = 0.18;
  c.fillStyle = '#ffd34d';
  c.beginPath();
  c.ellipse(0, 0, w * 1.5, p.r * 1.5, 0, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha = 1;
  const g = c.createLinearGradient(-w, -p.r, w, p.r);
  if (s >= 0) {
    g.addColorStop(0, '#fff6c2');
    g.addColorStop(0.45, '#f5c542');
    g.addColorStop(1, '#b07d0a');
  } else {
    g.addColorStop(0, '#e9b93a');
    g.addColorStop(1, '#8a6106');
  }
  c.fillStyle = g;
  c.beginPath();
  c.ellipse(0, 0, w, p.r, 0, 0, Math.PI * 2);
  c.fill();
  c.lineWidth = 1.2;
  c.strokeStyle = '#9a6b05';
  c.stroke();
  if (Math.abs(s) > 0.35) {
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.beginPath();
    c.ellipse(0, 0, w * 0.66, p.r * 0.66, 0, 0, Math.PI * 2);
    c.stroke();
  }
  c.restore();
}

function Particles() {
  const ref = useRef<HTMLCanvasElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const c = cv.getContext('2d')!;
    let ps: P[] = [];
    let raf = 0;
    let last = 0;
    let W = 0;
    let H = 0;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth;
      H = window.innerHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const frame = (now: number) => {
      const dt = Math.min(32, now - (last || now));
      last = now;
      c.clearRect(0, 0, W, H);
      const born: P[] = [];
      for (const p of ps) {
        if (p.k === 'rocket') {
          p.vy += G * 0.5 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          c.fillStyle = '#fff6c2';
          c.beginPath();
          c.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
          c.fill();
          if (p.vy >= -0.05) {
            // 到达最高点：炸开
            const n = 60 + Math.floor(Math.random() * 30);
            for (let i = 0; i < n; i++) {
              const a = (i / n) * Math.PI * 2;
              const v = 0.12 + Math.random() * 0.22;
              born.push({ k: 'spark', x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color: p.color, life: 1100 + Math.random() * 700, max: 1800 });
            }
            p.y = H + 999;
          }
          continue;
        }
        if (p.k === 'spark') {
          p.vx *= 0.985;
          p.vy = p.vy * 0.985 + G * 0.25 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.life -= dt;
          c.globalAlpha = Math.max(0, Math.min(1, p.life / 700));
          c.fillStyle = p.color;
          c.beginPath();
          c.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
          c.fill();
          c.globalAlpha = 1;
          continue;
        }
        if (p.k === 'coin') {
          p.vy += G * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.phase += p.spin * dt;
          if (p.y > -p.r) drawCoin(c, p);
        } else {
          p.vx *= 0.992;
          p.vy = p.vy * 0.992 + G * 0.55 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.rot += p.vr * dt;
          p.life -= dt;
          c.save();
          c.translate(p.x, p.y);
          c.rotate(p.rot);
          c.globalAlpha = Math.max(0, Math.min(1, p.life / 600));
          c.fillStyle = p.color;
          c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 1.7)));
          c.restore();
        }
      }
      ps = ps.filter((p) => (p.k === 'coin' ? p.y < H + p.r * 2 : p.k === 'rocket' ? p.y < H : p.life > 0 && p.y < H + 20)).concat(born);
      if (ps.length) raf = requestAnimationFrame(frame);
      else {
        raf = 0;
        last = 0;
        c.clearRect(0, 0, W, H);
      }
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const off = onFx((e) => {
      if (e.type === 'coins') {
        for (let i = 0; i < e.count; i++) {
          const r = (e.big ? 10 : 8) + Math.random() * 6;
          ps.push({ k: 'coin', x: Math.random() * W, y: -r - Math.random() * H * 0.7, vx: (Math.random() - 0.5) * 0.08, vy: 0.05 + Math.random() * 0.25, r, phase: Math.random() * Math.PI * 2, spin: 0.006 + Math.random() * 0.012 });
        }
        if (ps.length > 400) ps = ps.slice(-400);
        kick();
      } else if (e.type === 'confetti') {
        for (let i = 0; i < 140; i++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
          const v = 0.35 + Math.random() * 0.55;
          ps.push({ k: 'conf', x: W / 2, y: H * 0.32, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: 6 + Math.random() * 5, h: 3 + Math.random() * 4, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.02, color: CONF_COLORS[i % CONF_COLORS.length], life: 2600 + Math.random() * 1600 });
        }
        kick();
      } else if (e.type === 'fireworks') {
        const colors = ['#22d3ee', '#f5c542', '#16e0a0', '#ff6fae', '#9085e9', '#ffffff'];
        for (let i = 0; i < e.bursts; i++) {
          setTimeout(() => {
            ps.push({ k: 'rocket', x: W * (0.15 + Math.random() * 0.7), y: H + 10, vx: (Math.random() - 0.5) * 0.06, vy: -(0.9 + Math.random() * 0.35) * Math.sqrt(H / 800), color: colors[i % colors.length] });
            kick();
          }, i * 420);
        }
      } else if (e.type === 'flash') {
        const el = flashRef.current;
        if (el) {
          el.classList.remove('fx-flash--on');
          void el.offsetWidth; // 重新播放动画
          el.classList.add('fx-flash--on');
        }
      }
    });
    return () => {
      off();
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);
  return (
    <>
      <canvas ref={ref} className="fx-canvas" aria-hidden />
      <div ref={flashRef} className="fx-flash" aria-hidden />
    </>
  );
}

// ─── 提示卡片 ─────────────────────────────────────────────────

function Cards() {
  const [queue, setQueue] = useState<{ id: number; card: FxCard }[]>([]);
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  useEffect(() => {
    let id = 0;
    return onFx((e) => {
      if (e.type !== 'card') return;
      setQueue((q) => [...q.slice(-4), { id: ++id, card: e.card }]);
    });
  }, []);
  const cur = queue[0];
  useEffect(() => {
    if (!cur) return;
    const t = setTimeout(() => setQueue((q) => q.slice(1)), cur.card.kind === 'goal' ? 9000 : cur.card.kind === 'badge' ? 6500 : cur.card.kind === 'poison' ? 7000 : 4200);
    return () => clearTimeout(t);
  }, [cur]);
  if (!cur) return null;
  const c = cur.card;
  const close = () => setQueue((q) => q.slice(1));
  const money = (sol: number) => `≈ ${fmtMoney(sol * solTo[primary], primary)} · ${fmtMoney(sol * solTo[secondary], secondary)}`;
  return (
    <div className="fx-cards" role="status" aria-live="polite">
      <div key={cur.id} className={`fx-card fx-card--${c.kind}`} onClick={close}>
        {c.kind === 'in' && (
          <>
            <div className="fx-card__kicker">💰 到账{c.label ? ` · ${c.label}` : ''}</div>
            <div className="fx-card__big up">+{fmtNum(c.sol, 4)} SOL</div>
            <div className="fx-card__sub">{money(c.sol)}</div>
            <div className="fx-card__foot">公司总资产 {fmtNum(c.total, 4)} SOL</div>
          </>
        )}
        {c.kind === 'out' && (
          <>
            <div className="fx-card__kicker">转出{c.label ? ` · ${c.label}` : ''}</div>
            <div className="fx-card__big">−{fmtNum(Math.abs(c.sol), 4)} SOL</div>
            <div className="fx-card__sub">{money(Math.abs(c.sol))}</div>
            <div className="fx-card__foot">公司总资产 {fmtNum(c.total, 4)} SOL</div>
          </>
        )}
        {c.kind === 'poison' && (
          <>
            <div className="fx-card__kicker">⚠️ 发现地址投毒</div>
            <div className="fx-card__sub" style={{ color: 'var(--text-1)' }}>
              {c.text}
            </div>
            <div className="fx-card__foot">转账时千万不要从交易记录里复制地址</div>
          </>
        )}
        {c.kind === 'goal' && (
          <>
            <div className="fx-card__icon">🎉</div>
            <div className="fx-card__kicker">公司达成目标{c.label ? ` · ${c.label}` : ''}</div>
            <div className="fx-card__big up">{fmtNum(c.target, c.target % 1 ? 2 : 0)} SOL</div>
            <div className="fx-card__sub">{money(c.total)}</div>
            <div className="fx-card__foot">现在公司总资产 {fmtNum(c.total, 4)} SOL</div>
          </>
        )}
        {c.kind === 'badge' && (
          <>
            <div className="fx-card__icon">{c.icon}</div>
            <div className="fx-card__kicker">🏆 解锁成就</div>
            <div className="fx-card__big">
              {c.name}
              {c.level ? ` · ${c.level}` : ''}
            </div>
            <div className="fx-card__sub">{c.text}</div>
            <a className="btn btn--solid" href="#/explore" style={{ marginTop: 10 }} onClick={close}>
              去成就墙看看
            </a>
          </>
        )}
      </div>
    </div>
  );
}

// ─── 链上变化 → 特效 ─────────────────────────────────────────

function useChainTriggers() {
  const t = useStore((s) => s.snap?.treasury);
  const unlocks = useStore((s) => s.unlocks);
  const goalReached = useStore((s) => s.goalReached);
  const goal = useStore((s) => s.snap?.goal);
  const solTo = useSolTo();

  // 达成目标：放烟花
  useEffect(() => {
    if (!goalReached || Date.now() - goalReached > 30_000 || !goal) return;
    fx.goal(goal.target, t?.totalSol ?? goal.target, goal.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalReached]);
  const seenWallet = useRef(new Map<string, number>());
  const seenAct = useRef(new Set<string>());
  const ready = useRef(false);

  useEffect(() => {
    if (!t) return;
    const labels = new Map(t.wallets.map((w) => [w.address, w.label]));
    if (!ready.current) {
      // 第一次拿到数据：只记录，不放特效
      for (const w of t.wallets) seenWallet.current.set(w.address, w.lastChangeMs);
      for (const a of t.activity) seenAct.current.add(a.id);
      ready.current = true;
      return;
    }
    const now = Date.now();
    for (const w of t.wallets) {
      if (!w.lastChangeMs || seenWallet.current.get(w.address) === w.lastChangeMs) continue;
      seenWallet.current.set(w.address, w.lastChangeMs);
      if (now - w.lastChangeMs > 15_000 || Math.abs(w.lastDelta) < 0.0005) continue;
      const label = t.wallets.length > 1 ? w.label : undefined;
      if (w.lastDelta > 0) fx.inflow(w.lastDelta, t.totalSol, label, w.lastDelta * solTo.cny);
      else fx.outflow(w.lastDelta, t.totalSol, label);
    }
    for (const a of t.activity) {
      if (seenAct.current.has(a.id)) continue;
      seenAct.current.add(a.id);
      if (a.poisonOf && now / 1000 - a.ts < 600) {
        fx.poison(`${shortAddr(a.counterparty, 5)} 冒充 ${labels.get(a.poisonOf) ?? shortAddr(a.poisonOf)}，给公司钱包转了一笔小额 SOL。它的开头结尾和真地址一样。`);
      }
    }
  }, [t]);

  // 解锁新成就：拉取成就墙，逐个播放
  useEffect(() => {
    if (!unlocks || Date.now() - unlocks.at > 30_000) return;
    let cancelled = false;
    getJSON<AchievementsView>('/api/achievements')
      .then((v) => {
        if (cancelled) return;
        for (const key of unlocks.keys) {
          const a: Achievement | undefined = v.list.find((x) => x.id === key.split(':')[0]);
          if (a) fx.badge(a.icon, a.name, a.detail ?? a.desc, a.maxLevel > 1 ? a.levelLabel : undefined);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [unlocks]);
}

/** 全局特效层：放在 App 最外层 */
export function FxLayer() {
  useChainTriggers();
  return (
    <>
      <Particles />
      <Cards />
    </>
  );
}
