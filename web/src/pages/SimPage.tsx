// USVK 模拟盘：pump.fun 规则的虚拟盘口。公司 + 员工 + 内部客户都能买卖（虚拟 SOL，不上链）
import { FlaskConical, Info, KeyRound, Lock, LockOpen, LogIn } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { ammFeeRate, curveFeeRate, projectBuys, quoteBuy, quoteSell, simCircMcap, simCirculating, simCostToGraduate, simLiquidity, simMcap, simPoolTokens, simPrice, simProgress, type SimQuote } from '../../../shared/sim';
import type { SimKind, SimView } from '../../../shared/types';
import { SimAdmin } from '../components/SimAdmin';
import { SimKline } from '../components/SimKline';
import { floorPct, openPrice } from '../components/SimToken';
import { Dual, useCur } from '../components/Shell';
import { Card, Meter, Seg, toast } from '../components/ui';
import { saveToken } from '../lib/api';
import { CUR_SYMBOL, fmtCompact, fmtDate, fmtInt, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtShortDate, fmtSol, fmtTiny } from '../lib/format';
import { useFlash, useNow, useSolTo } from '../lib/hooks';
import { KIND_LABEL, changeMyPassword, lockTrading, simTrade, unlockTrading, useSim, useUnlock } from '../lib/sim';
import { loginWithPassword, reconnectNow, useStore } from '../lib/store';

/** 公司额度用实时的公司总资产（服务器成交时也用同一个数） */
function useBudget(v: SimView): { budget: number; available: number } {
  const live = useStore((s) => s.snap?.treasury.totalSol);
  const me = v.me;
  if (!me) return { budget: 0, available: 0 };
  if (me.budgetSource === 'company' && live !== undefined) return { budget: live, available: Math.max(0, live - me.spent + me.received) };
  return { budget: me.budget, available: me.available };
}

function KindChip({ kind }: { kind: SimKind }) {
  return <span className={`chip sim-kind sim-kind--${kind}`}>{KIND_LABEL[kind]}</span>;
}

// ─── 行情头 ───────────────────────────────────────────────────

function SimHero({ v }: { v: SimView }) {
  const { primary, secondary } = useCur();
  const solTo = useSolTo();
  const price = simPrice(v.pool);
  const mcap = simCircMcap(v.params, v.pool);
  const fdv = simMcap(v.params, v.pool);
  const mult = price / openPrice(v);
  const progress = simProgress(v.params, v.pool);
  const flash = useFlash(mcap);
  const graduated = v.pool.phase === 'amm';
  return (
    <Card
      className="hero-card"
      kicker={`USVK · Simulator · 第 ${v.round} 轮`}
      title={
        <>
          USVK 市值 <span className="chip chip--warn" style={{ marginLeft: 4, verticalAlign: 2 }}>模拟</span>
        </>
      }
      right={<span className={`chip ${graduated ? 'chip--up' : 'chip--accent'}`}>{graduated ? '已毕业 · PumpSwap' : 'pump.fun 内盘'}</span>}
    >
      <div className="glow-orb" />
      <div className={`hero-value ${flash}`} aria-live="polite">
        <small>{CUR_SYMBOL[primary]}</small>
        {fmtNum(mcap * solTo[primary], 2)}
      </div>
      <div className="hero-sub">
        <span>{fmtMoney(mcap * solTo[secondary], secondary)}</span>
        <span>
          <b>{fmtSol(mcap)}</b> SOL
        </span>
        <span className={mult > 1.0001 ? 'up' : ''}>价格比开盘 ×{fmtNum(mult, mult >= 100 ? 0 : 2)}</span>
      </div>
      <div className="sim-unit">
        <span className="muted">单价</span>
        <b className="mono">{fmtPrice(price * solTo[primary], primary)}</b>
        <span className="dim mono">
          {fmtPrice(price * solTo[secondary], secondary)} · {fmtTiny(price)} SOL
        </span>
      </div>
      <div className="sim-unit">
        <span className="muted">全流通市值 FDV</span>
        <span className="dim mono">
          <Dual sol={fdv} compact withSol />
        </span>
      </div>
      <div className="sim-grad">
        <div className="sim-grad__row">
          <span>毕业进度（内盘买满 → 迁移到 PumpSwap）</span>
          <b className="mono">{floorPct(progress, graduated)}</b>
        </div>
        <Meter value={progress} label="毕业进度" />
        <div className="sim-grad__sub">
          {graduated ? (
            <>已毕业{v.graduatedAt ? `（${fmtDate(v.graduatedAt)}）` : ''}：内盘的 SOL 和预留代币已全部进入 PumpSwap 池子，之后按恒定乘积成交。</>
          ) : (
            <>
              再买 <b>{fmtSol(simCostToGraduate(v.params, v.pool))} SOL</b>（含手续费）买满内盘。
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function SimTiles({ v }: { v: SimView }) {
  const supply = v.params.supply;
  const circ = simCirculating(v.params, v.pool);
  return (
    <div className="grid-2">
      <div className="tile">
        <div className="tile__label">池子里的 SOL</div>
        <div className="tile__value">{fmtSol(simLiquidity(v.pool))} SOL</div>
        <div className="tile__sub">
          <Dual sol={simLiquidity(v.pool)} compact />
        </div>
      </div>
      <div className="tile">
        <div className="tile__label">持有人</div>
        <div className="tile__value">{v.holderCount} 人</div>
        <div className="tile__sub">
          流通 {fmtCompact(circ)} 枚（{fmtPct(circ / supply, 1)}）
        </div>
      </div>
      <div className="tile">
        <div className="tile__label">成交</div>
        <div className="tile__value">{v.stats.trades} 笔</div>
        <div className="tile__sub">
          成交额 {fmtSol(v.stats.volumeSol)} SOL · 买 {v.stats.buys} / 卖 {v.stats.sells}
        </div>
      </div>
      <div className="tile">
        <div className="tile__label">历史最高市值</div>
        <div className="tile__value">{v.stats.athMcap ? `${fmtSol(v.stats.athMcap)} SOL` : '—'}</div>
        <div className="tile__sub">{v.stats.athMcap ? <Dual sol={v.stats.athMcap} compact /> : '还没有成交'}</div>
      </div>
    </div>
  );
}

// ─── 拉盘预演 ─────────────────────────────────────────────────

function useWidth(ref: RefObject<HTMLDivElement | null>) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function niceStep(raw: number) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const H = 196;
const PAD = { l: 6, r: 10, t: 16, b: 24 };

function ProjectionCard({ v, preview }: { v: SimView; preview: number }) {
  const { primary } = useCur();
  const solTo = useSolTo();
  const k = solTo[primary];
  const live = useStore((s) => s.snap?.treasury.totalSol);
  const { available } = useBudget(v);
  const box = useRef<HTMLDivElement>(null);
  const W = useWidth(box);
  const [hover, setHover] = useState<number | null>(null);
  const companySol = live ?? v.companySol;
  const useMine = !!v.me && available > 0.0001;
  const range = useMine ? available : companySol;
  const nowMcap = simCircMcap(v.params, v.pool);

  const proj = useMemo(() => projectBuys(v.params, v.pool, range, 80), [v.params, v.pool, range]);
  const pts = proj.map((p) => ({ x: range > 0 ? p.spend / range : 0, y: p.mcap }));
  const gradSpend = v.pool.phase === 'curve' ? simCostToGraduate(v.params, v.pool) : 0;
  const pv = preview > 0 && preview <= range + 1e-9 ? quoteBuy(v.params, v.pool, preview) : null;

  const maxY = Math.max(...pts.map((p) => p.y), 1e-9) * 1.1;
  const iw = Math.max(10, W - PAD.l - PAD.r);
  const ih = H - PAD.t - PAD.b;
  const X = (x: number) => PAD.l + x * iw;
  const Y = (y: number) => PAD.t + (1 - y / maxY) * ih;
  let d = '';
  pts.forEach((p, i) => (d += `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`));
  const area = pts.length ? `${d}V${PAD.t + ih}H${X(pts[0].x).toFixed(1)}Z` : '';
  const step = niceStep(maxY / 4);
  const ticks: number[] = [];
  for (let t = step; t < maxY * 0.98; t += step) ticks.push(t);
  const idx = hover ?? pts.length - 1;
  const cur = pts[idx];
  const sp = proj[idx];
  const gx = gradSpend > 0 && gradSpend < range ? gradSpend / range : null;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left - PAD.l) / iw;
    setHover(Math.max(0, Math.min(pts.length - 1, Math.round(x * (pts.length - 1)))));
  };

  return (
    <Card kicker="What If" title="拉盘预演" right={<span className="chip">{useMine ? '用你的可用额度' : '用公司总资产'}</span>}>
      <div className="sim-readout">
        {sp && (
          <>
            <span className="muted">再买 {fmtSol(sp.spend)} SOL</span>
            <span>
              市值 <b>{fmtMoney(sp.mcap * k, primary, { compact: true })}</b> · {fmtSol(sp.mcap)} SOL
            </span>
            {nowMcap > 0 && <span className="up">×{fmtNum(sp.mcap / nowMcap, 2)}</span>}
          </>
        )}
      </div>
      <div ref={box} className="sim-chart">
        {W > 0 && (
          <svg width={W} height={H} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="再买入多少 SOL 市值会到多少">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={W - PAD.r} y1={Y(t)} y2={Y(t)} className="sim-chart__grid" />
                <text x={PAD.l + 2} y={Y(t) - 4} className="sim-chart__tick">
                  {fmtMoney(t * k, primary, { compact: true })}
                </text>
              </g>
            ))}
            <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} className="sim-chart__axis" />
            {gx !== null && (
              <g>
                <line x1={X(gx)} x2={X(gx)} y1={PAD.t} y2={PAD.t + ih} className="sim-chart__grad" />
                <text x={X(gx) + 4} y={PAD.t + 10} className="sim-chart__gradlabel">
                  毕业
                </text>
              </g>
            )}
            <path d={area} className="sim-chart__area" />
            <path d={d} className="sim-chart__line" />
            {pv && <circle cx={X(pv.sol / range)} cy={Y(simCircMcap(v.params, pv.after))} r={5} className="sim-chart__preview" />}
            {cur && (
              <g>
                <line x1={X(cur.x)} x2={X(cur.x)} y1={PAD.t} y2={PAD.t + ih} className="sim-chart__cross" />
                <circle cx={X(cur.x)} cy={Y(cur.y)} r={4} className="sim-chart__dot" />
              </g>
            )}
            <text x={PAD.l} y={H - 7} className="sim-chart__tick">
              现在
            </text>
            <text x={W - PAD.r} y={H - 7} textAnchor="end" className="sim-chart__tick">
              +{fmtSol(range)} SOL
            </text>
          </svg>
        )}
      </div>
      <p className="card__note">
        从现在的盘口开始，{useMine ? `用你现在可用的 ${fmtSol(range)} SOL` : `用公司总资产 ${fmtSol(range)} SOL`}一路买入，市值（现价 × 流通量）会涨到多少（已扣手续费）。
        {gx !== null ? '虚线是毕业点：之后进入 PumpSwap 池子。' : ''}
        {pv ? '圆点是你在买卖框里输入的金额。' : ''}
      </p>
    </Card>
  );
}

// ─── 登录（账号 + 密码） ───────────────────────────────────────

function SimLogin() {
  const [f, setF] = useState({ user: '', pw: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const info = await loginWithPassword(f.user, f.pw);
      toast(`欢迎，${info.name ?? f.user}`);
      setF({ user: '', pw: '' });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card kicker="Login" title="登录后买卖 USVK">
      <form
        className="sim-login"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.user && f.pw) void submit();
        }}
      >
        <input className="input" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} placeholder="账号" autoComplete="username" autoCapitalize="none" spellCheck={false} aria-label="账号" />
        <input className="input" type="password" value={f.pw} onChange={(e) => setF({ ...f, pw: e.target.value })} placeholder="密码" autoComplete="current-password" aria-label="密码" />
        <button type="submit" className="btn btn--solid" disabled={!f.user || !f.pw || busy}>
          <LogIn size={14} /> {busy ? '登录中…' : '登录'}
        </button>
      </form>
      {err && <div className="error">{err}</div>}
      <p className="card__note">公司用 admin 账号；员工用 VK1–VK12。账号由管理员在模拟盘里开，登录后可以自己改密码。也可以在「设置 → 我的身份」里用 8 位登录码登录。</p>
    </Card>
  );
}

// ─── 买卖 ─────────────────────────────────────────────────────

function UnlockBar() {
  const u = useUnlock();
  const now = useNow(15_000);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (u) {
    return (
      <div className="sim-unlock sim-unlock--on">
        <LockOpen size={14} />
        <span>交易密码已验证，{Math.max(1, Math.ceil((u.exp - now) / 60_000))} 分钟内买卖不用再输</span>
        <button type="button" className="chip" onClick={() => void lockTrading()}>
          <Lock size={11} /> 锁定
        </button>
      </div>
    );
  }
  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await unlockTrading(pw);
      setPw('');
      toast('已解锁 30 分钟');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="sim-unlock"
      onSubmit={(e) => {
        e.preventDefault();
        if (pw) void submit();
      }}
    >
      <Lock size={14} />
      <input className="input" type="password" inputMode="numeric" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="公司交易密码" aria-label="交易密码" />
      <button type="submit" className="btn" disabled={!pw || busy}>
        解锁
      </button>
      {err && <div className="error" style={{ width: '100%', marginTop: 0 }}>{err}</div>}
    </form>
  );
}

function QuoteRows({ q, v }: { q: SimQuote; v: SimView }) {
  const supply = v.params.supply;
  return (
    <div className="rows sim-quote">
      {q.side === 'buy' ? (
        <div className="row">
          <span className="row__k">得到</span>
          <span className="row__v mono">
            {fmtInt(q.tokens)} USVK <span className="muted">（总量的 {fmtPct(q.tokens / supply, 2)}）</span>
          </span>
        </div>
      ) : (
        <div className="row">
          <span className="row__k">到手</span>
          <span className="row__v mono">
            {fmtSol(q.sol)} SOL <span className="muted">· <Dual sol={q.sol} compact /></span>
          </span>
        </div>
      )}
      <div className="row">
        <span className="row__k">平均成交价</span>
        <span className="row__v mono">{fmtTiny(q.avgPrice)} SOL</span>
      </div>
      <div className="row">
        <span className="row__k">价格变化</span>
        <span className={`row__v mono ${q.impact > 0 ? 'up' : q.impact < 0 ? 'down' : ''}`}>{fmtPct(q.impact, 2, true)}</span>
      </div>
      <div className="row">
        <span className="row__k">手续费</span>
        <span className="row__v mono">
          {fmtSol(q.fee)} SOL <span className="muted">（{q.venue === 'amm' ? fmtPct(ammFeeRate(v.params), 2) : q.venue === 'curve' ? fmtPct(curveFeeRate(v.params), 2) : '内盘 + 外盘'}）</span>
        </span>
      </div>
      <div className="row">
        <span className="row__k">成交后市值</span>
        <span className="row__v mono">
          <Dual sol={simCircMcap(v.params, q.after)} compact withSol />
        </span>
      </div>
      {q.graduated && (
        <div className="row">
          <span className="row__k">🎓 这一笔会买满内盘</span>
          <span className="row__v">
            <span className="chip chip--up">毕业 → PumpSwap</span>
          </span>
        </div>
      )}
    </div>
  );
}

const BUY_CHIPS = [0.1, 0.5, 1, 5, 10];
const SLIPS = [1, 3, 10];

function TradeCard({ v, onPreview }: { v: SimView; onPreview: (sol: number) => void }) {
  const me = v.me;
  const { budget, available } = useBudget(v);
  const u = useUnlock();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amt, setAmt] = useState('');
  const [all, setAll] = useState(false); // 买入"全部" / 卖出 100%
  const [slip, setSlip] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const spend = side === 'buy' ? (all ? available : Number(amt) || 0) : 0;
  const sellTokens = side === 'sell' ? (all ? (me?.tokens ?? 0) : Number(amt) || 0) : 0;
  const q = useMemo(() => {
    if (!me) return null;
    if (side === 'buy') return spend > 0 ? quoteBuy(v.params, v.pool, spend) : null;
    return sellTokens > 0 ? quoteSell(v.params, v.pool, Math.min(sellTokens, me.tokens)) : null;
  }, [me, side, spend, sellTokens, v.params, v.pool]);

  useEffect(() => {
    onPreview(side === 'buy' ? spend : 0);
  }, [side, spend, onPreview]);

  if (!me) return <SimLogin />;

  const over = side === 'buy' ? spend > available + 1e-9 : sellTokens > me.tokens * (1 + 1e-9) + 1e-6;
  const locked = me.needPassword && !u;
  const canSubmit = !!q && q.tokens > 0 && !over && !busy && !locked;

  const submit = async () => {
    if (!q) return;
    setErr('');
    setBusy(true);
    try {
      const minOut = (side === 'buy' ? q.tokens : q.sol) * (1 - slip / 100);
      const t = await simTrade(
        side === 'buy' ? { side, ...(all ? { all: true } : { sol: spend }), minOut } : { side, ...(all ? { pct: 100 } : { tokens: sellTokens }), minOut },
      );
      toast(t.side === 'buy' ? `买入成功：+${fmtCompact(t.tokens)} USVK` : `卖出成功：到手 ${fmtSol(t.sol)} SOL`);
      setAmt('');
      setAll(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (s: 'buy' | 'sell') => {
    setSide(s);
    setAmt('');
    setAll(false);
    setErr('');
  };

  const sourceText =
    me.budgetSource === 'company'
      ? `额度 = 公司总资产 ${fmtSol(budget)} SOL`
      : me.budgetSource === 'staking'
        ? `额度 = 内部质押本金 ${fmtSol(budget)} SOL${me.linkedName && me.linkedName !== me.name ? `（${me.linkedName}）` : ''}`
        : '还没有关联内部质押：额度 0';

  return (
    <Card
      kicker="Trade"
      title={
        <>
          买卖 USVK <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>· {me.name}{me.username ? `（${me.username}）` : ''}</span>
        </>
      }
      right={<KindChip kind={me.kind} />}
    >
      <div className="sim-side" role="group" aria-label="买还是卖">
        <button type="button" className={side === 'buy' ? 'on buy' : ''} aria-pressed={side === 'buy'} onClick={() => pick('buy')}>
          买入
        </button>
        <button type="button" className={side === 'sell' ? 'on sell' : ''} aria-pressed={side === 'sell'} onClick={() => pick('sell')}>
          卖出
        </button>
      </div>

      <div className="sim-avail">
        {side === 'buy' ? (
          <>
            <span>
              可用 <b className="mono">{fmtSol(available)} SOL</b>
            </span>
            <span className="muted">
              <Dual sol={available} compact />
            </span>
          </>
        ) : (
          <>
            <span>
              持有 <b className="mono">{fmtInt(me.tokens)} USVK</b>
            </span>
            <span className="muted">占总量 {fmtPct(me.tokens / v.params.supply, 2)}</span>
          </>
        )}
      </div>
      {side === 'buy' && (
        <div className="sim-source muted">
          {sourceText}
          {me.spent > 0 || me.received > 0 ? ` · 已投入 ${fmtSol(me.spent)} · 已收回 ${fmtSol(me.received)}` : ''}
        </div>
      )}
      {side === 'buy' && me.budgetSource === 'none' && (
        <div className="banner" style={{ marginTop: 8 }}>
          你的额度 = 你在「质押 → 内部质押」里的本金。请管理员把你的模拟盘账号关联到内部质押，存入 SOL 后就有额度了。
        </div>
      )}

      <div className="field" style={{ marginTop: 10, marginBottom: 8 }}>
        <label htmlFor="sim-amt">{side === 'buy' ? '花多少 SOL（含手续费）' : '卖多少枚'}</label>
        <input
          id="sim-amt"
          inputMode="decimal"
          value={all ? (side === 'buy' ? fmtNum(available, 6) : String(Math.floor(me.tokens))) : amt}
          onChange={(e) => {
            setAll(false);
            setAmt(e.target.value.replace(/[^\d.]/g, ''));
          }}
          placeholder={side === 'buy' ? '0.0' : '0'}
        />
      </div>
      <div className="sim-chips">
        {side === 'buy' ? (
          <>
            {BUY_CHIPS.map((c) => (
              <button key={c} type="button" className={`chip ${!all && Number(amt) === c ? 'chip--accent' : ''}`} disabled={c > available} onClick={() => (setAll(false), setAmt(String(c)))}>
                {c} SOL
              </button>
            ))}
            {[0.25, 0.5].map((f) => (
              <button key={f} type="button" className="chip" disabled={available <= 0} onClick={() => (setAll(false), setAmt(String(Math.floor(available * f * 1e4) / 1e4)))}>
                {f * 100}%
              </button>
            ))}
            <button type="button" className={`chip ${all ? 'chip--accent' : ''}`} disabled={available <= 0} onClick={() => setAll(true)}>
              全部
            </button>
          </>
        ) : (
          <>
            {[10, 25, 50].map((p) => (
              <button key={p} type="button" className="chip" disabled={me.tokens <= 0} onClick={() => (setAll(false), setAmt(String(Math.floor((me.tokens * p) / 100))))}>
                {p}%
              </button>
            ))}
            <button type="button" className={`chip ${all ? 'chip--accent' : ''}`} disabled={me.tokens <= 0} onClick={() => setAll(true)}>
              全部卖出
            </button>
          </>
        )}
      </div>

      {q && q.tokens > 0 && <QuoteRows q={q} v={v} />}
      {over && <div className="error">{side === 'buy' ? `超出可用额度（${fmtSol(available)} SOL）` : `你只有 ${fmtInt(me.tokens)} 枚`}</div>}

      <div className="sim-slip">
        <span className="muted">滑点容忍</span>
        <Seg<string> label="滑点" value={String(slip)} onChange={(s) => setSlip(Number(s))} options={SLIPS.map((s) => ({ value: String(s), label: `${s}%` }))} />
      </div>

      {me.needPassword && <UnlockBar />}

      <button type="button" className={`btn btn--solid sim-go sim-go--${side}`} disabled={!canSubmit} onClick={() => void submit()}>
        {busy ? '提交中…' : side === 'buy' ? '买入 USVK' : '卖出 USVK'}
      </button>
      {err && <div className="error">{err}</div>}
      <p className="card__note">
        {me.needPassword ? '公司买卖要先输交易密码（验证一次 30 分钟有效）。' : ''}
        别人在你之前成交、价格变化超过滑点容忍时，这一笔会被拒绝，重新确认即可。卖出到手的 SOL 会回到可用额度里。
      </p>
    </Card>
  );
}

// ─── 我的持仓 ─────────────────────────────────────────────────

function PositionCard({ v }: { v: SimView }) {
  const me = v.me!;
  const price = simPrice(v.pool);
  const mark = me.tokens * price;
  const exit = me.tokens > 0 ? quoteSell(v.params, v.pool, me.tokens) : null;
  const pnl = (exit?.sol ?? 0) - me.cost;
  const total = pnl + me.realized;
  return (
    <Card kicker="Position" title="我的持仓" right={<span className="chip">买 {me.buys} · 卖 {me.sells}</span>}>
      <div className="big-money mono">
        {fmtInt(me.tokens)} <span className="dim">USVK · 总量的 {fmtPct(me.tokens / v.params.supply, 2)}</span>
      </div>
      <div className="grid-2" style={{ marginTop: 10 }}>
        <div className="tile">
          <div className="tile__label">持仓成本</div>
          <div className="tile__value">{fmtSol(me.cost)} SOL</div>
          <div className="tile__sub">
            <Dual sol={me.cost} compact />
          </div>
        </div>
        <div className="tile">
          <div className="tile__label">按现价算</div>
          <div className="tile__value">{fmtSol(mark)} SOL</div>
          <div className="tile__sub">
            <Dual sol={mark} compact />
          </div>
        </div>
        <div className="tile">
          <div className="tile__label">现在全部卖出能拿回</div>
          <div className="tile__value">{fmtSol(exit?.sol ?? 0)} SOL</div>
          <div className="tile__sub">{exit ? `卖完价格 ${fmtPct(exit.impact, 1, true)}` : '没有持仓'}</div>
        </div>
        <div className="tile">
          <div className="tile__label">盈亏（按全部卖出）</div>
          <div className={`tile__value ${total > 0 ? 'up' : total < 0 ? 'down' : ''}`}>
            {total > 0 ? '+' : ''}
            {fmtSol(total)} SOL
          </div>
          <div className="tile__sub">
            浮动 {fmtSol(pnl)} · 已实现 {fmtSol(me.realized)}
          </div>
        </div>
      </div>
      <p className="card__note">"按现价算"是数量 × 现价；真要全部卖掉，价格会被自己砸下去，实际能拿回的是"全部卖出能拿回"。成本按平均价计算，卖出一部分时成本按比例减少。</p>
    </Card>
  );
}

function MyPasswordCard({ v }: { v: SimView }) {
  const me = v.me!;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ old: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!me.username) return null;
  const save = async () => {
    setErr('');
    if (f.next !== f.again) return setErr('两次输入的新密码不一样');
    setBusy(true);
    try {
      const r = await changeMyPassword(f.old, f.next);
      if (r.token) {
        saveToken(r.token);
        reconnectNow();
      }
      setF({ old: '', next: '', again: '' });
      setOpen(false);
      toast('登录密码已修改，其他设备需要重新登录');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      kicker="Account"
      title={`我的账号 · ${me.username}`}
      right={
        !open && (
          <button type="button" className="chip" onClick={() => setOpen(true)}>
            <KeyRound size={11} /> 改登录密码
          </button>
        )
      }
    >
      {open ? (
        <>
          <div className="field">
            <label htmlFor="my-pw-old">现在的密码</label>
            <input id="my-pw-old" type="password" autoComplete="current-password" value={f.old} onChange={(e) => setF({ ...f, old: e.target.value })} />
          </div>
          <div className="grid-form">
            <div className="field">
              <label htmlFor="my-pw-new">新密码（至少 6 位）</label>
              <input id="my-pw-new" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="my-pw-again">再输一次</label>
              <input id="my-pw-again" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} />
            </div>
          </div>
          <div className="wm__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn--solid" disabled={busy || !f.old || f.next.length < 6} onClick={() => void save()}>
              保存
            </button>
          </div>
          {err && <div className="error">{err}</div>}
        </>
      ) : (
        <p className="card__note" style={{ marginTop: 0 }}>
          {me.kind === 'admin' ? 'admin 账号只能管理模拟盘（开账号、重置密码、买卖、重新开盘），公司钱包等设置仍然要用管理员密钥。' : '初始密码是统一的，建议改成只有你自己知道的密码。'}
        </p>
      )}
    </Card>
  );
}

// ─── 持仓排行 / 成交记录 ───────────────────────────────────────

function HoldersCard({ v }: { v: SimView }) {
  const supply = v.params.supply;
  const pool = simPoolTokens(v.params, v.pool);
  const rows = [{ name: v.pool.phase === 'curve' ? '池子（内盘）' : '池子（PumpSwap）', kind: null as SimKind | null, tokens: pool, me: false }, ...v.holders.map((h) => ({ ...h, me: !!h.me }))];
  return (
    <Card kicker="Holders" title="持仓排行" right={<span className="chip">{v.holderCount} 人持有</span>}>
      <div className="sim-holders">
        {rows.map((h, i) => (
          <div key={`${h.name}-${i}`} className={`sim-holder ${h.me ? 'sim-holder--me' : ''}`}>
            <span className="sim-holder__rank mono">{i === 0 ? '🏦' : i}</span>
            <span className="sim-holder__name">
              {h.name}
              {h.kind && h.kind !== 'admin' && <KindChip kind={h.kind} />}
              {h.me && <span className="chip chip--accent">你</span>}
            </span>
            <span className="sim-holder__val mono">
              {fmtCompact(h.tokens)} <span className="muted">{fmtPct(h.tokens / supply, 2)}</span>
            </span>
            <span className="sim-holder__bar" style={{ width: `${Math.min(100, (h.tokens / supply) * 100)}%` }} aria-hidden />
          </div>
        ))}
      </div>
      {v.holderCount === 0 && <p className="card__note">还没有人买。</p>}
      <p className="card__note">{v.admin ? '你是管理员，能看到所有人的全名。' : '别人的名字已打码，只有管理员能看到全名。'}</p>
    </Card>
  );
}

function TradesCard({ v }: { v: SimView }) {
  const [n, setN] = useState(20);
  const supply = v.params.supply;
  if (!v.trades.length) return null;
  return (
    <Card kicker="Trades" title="成交记录" right={<span className="chip">{v.stats.trades} 笔</span>}>
      <div className="sim-trades">
        {v.trades.slice(0, n).map((t) => (
          <div key={t.id} className={`sim-trade ${t.me ? 'sim-trade--me' : ''}`}>
            <span className={`sim-trade__side ${t.side}`}>{t.side === 'buy' ? '买' : '卖'}</span>
            <span className="sim-trade__main">
              <span className="sim-trade__who">
                {t.name}
                {t.kind !== 'admin' && <KindChip kind={t.kind} />}
                {t.graduated && <span className="chip chip--up">🎓 毕业</span>}
              </span>
              <span className="sim-trade__sub muted">
                {fmtShortDate(t.ts)} · {fmtCompact(t.tokens)} 枚
              </span>
            </span>
            <span className="sim-trade__right">
              <span className={`sim-trade__amt mono ${t.side === 'buy' ? 'up' : 'down'}`}>
                {t.side === 'buy' ? '+' : '−'}
                {fmtSol(t.sol)} SOL
              </span>
              <span className="sim-trade__mc muted mono">市值 {fmtCompact(t.priceAfter * (t.circAfter ?? supply))} SOL</span>
            </span>
          </div>
        ))}
      </div>
      {v.trades.length > n && (
        <button type="button" className="btn btn--ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setN(n + 50)}>
          显示更多
        </button>
      )}
    </Card>
  );
}

function PastCard({ v }: { v: SimView }) {
  return (
    <Card kicker="History" title="以前的轮次">
      <div className="rows">
        {v.past.map((r) => (
          <div key={`${r.round}-${r.startedAt}`} className="row">
            <span className="row__k">
              第 {r.round} 轮 · {fmtShortDate(r.startedAt)}
              {r.graduated && ' · 🎓'}
            </span>
            <span className="row__v mono">
              {r.peakMcap !== undefined ? `最高市值 ${fmtSol(r.peakMcap)} SOL` : `最高价 ${fmtTiny(r.peakPrice)} SOL`} · {r.trades} 笔 / {r.traders} 人
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function InfoLink() {
  return (
    <a className="banner banner--info sim-infolink" href="#/info">
      <Info size={15} style={{ flex: 'none', marginTop: 2 }} />
      <span>代币的全部参数（总量、开盘价、毕业门槛、手续费…）在「信息」页 ›</span>
    </a>
  );
}

export function SimPage() {
  const { view, error } = useSim();
  const [preview, setPreview] = useState(0);
  if (!view) {
    return (
      <Card kicker="Simulator" title="USVK 模拟盘">
        {error ? <div className="error">{error}</div> : <div className="skeleton" style={{ height: 120 }} />}
      </Card>
    );
  }
  return (
    <>
      <div className="banner banner--info" role="note">
        <FlaskConical size={15} style={{ flex: 'none', marginTop: 2 }} />
        <span>
          <b>模拟盘</b>：虚拟 SOL，不上链、不花真钱。按 pump.fun 规则：内盘买满约 86 SOL 毕业，迁移到 PumpSwap 池子。市值从 0 开始。
        </span>
      </div>
      <SimHero v={view} />
      <SimKline v={view} />
      <TradeCard v={view} onPreview={setPreview} />
      {view.me && <PositionCard v={view} />}
      <SimTiles v={view} />
      <ProjectionCard v={view} preview={preview} />
      <HoldersCard v={view} />
      <TradesCard v={view} />
      {view.me && <MyPasswordCard v={view} />}
      {view.admin && <SimAdmin v={view} />}
      {view.past.length > 0 && <PastCard v={view} />}
      <InfoLink />
    </>
  );
}
