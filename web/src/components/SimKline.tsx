// USVK 模拟盘 K 线：TradingView 出品的 lightweight-charts（和 TradingView 同一套图表引擎）
// 周期切换 / 成交量副图 / MA5·10·30 / 十字光标 OHLC 读数 / 我的买卖标记 / 我的持仓成本线 / 全屏
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SimTick, SimView } from '../../../shared/types';
import { CUR_SYMBOL, fmtClock, fmtCompact, fmtTiny, type Cur } from '../lib/format';
import { useSolTo } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useSimTicks } from '../lib/sim';
import { useCur } from './Shell';

const TZ = -new Date().getTimezoneOffset() * 60; // 图表内部用"本地时间当 UTC"，刻度即为本地时间
const pad = (n: number) => String(n).padStart(2, '0');
const FONT = "'PingFang SC', 'HarmonyOS Sans SC', 'Noto Sans SC', 'Microsoft YaHei', system-ui, -apple-system, 'Segoe UI', sans-serif";

type Tf = 'tick' | '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
const TFS: { key: Tf; label: string; sec: number }[] = [
  { key: 'tick', label: '逐笔', sec: 0 },
  { key: '1m', label: '1分', sec: 60 },
  { key: '5m', label: '5分', sec: 300 },
  { key: '15m', label: '15分', sec: 900 },
  { key: '1h', label: '1时', sec: 3600 },
  { key: '4h', label: '4时', sec: 14400 },
  { key: '1d', label: '日线', sec: 86400 },
];
const MA = [
  { n: 5, color: '#c98500' },
  { n: 10, color: '#d55181' },
  { n: 30, color: '#9085e9' },
];

interface Bar {
  t: number; // 本地时间当 UTC 的秒（逐笔模式 = 序号）
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number; // SOL
  buy: number;
  sell: number;
  ts: number; // 第一笔的真实时间（毫秒）
}

interface Legend {
  time: string;
  o?: number;
  h?: number;
  l?: number;
  c: number;
  chg: number;
  vol: number;
  ma: (number | undefined)[];
}

interface ChartPrefs {
  tf: Tf;
  mode: 'mcap' | 'price';
  quote: Cur | '';
  ma: boolean;
}
const PREF_KEY = 'vk.sim.chart';
function loadPrefs(): ChartPrefs {
  const d: ChartPrefs = { tf: '1m', mode: 'mcap', quote: '', ma: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') };
  } catch {
    return d;
  }
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function alpha(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** 成交 → K 线（数值单位：价格 = SOL/枚，市值 = SOL；之后再乘汇率） */
function buildBars(ticks: SimTick[], tf: Tf, mode: 'mcap' | 'price'): Bar[] {
  const val = (price: number, circ: number) => (mode === 'mcap' ? price * circ : price);
  const out: Bar[] = [];
  if (tf === 'tick') {
    ticks.forEach((t, i) => {
      const vb = val(t.pb, t.cb);
      const va = val(t.pa, t.ca);
      out.push({ t: i, o: vb, h: Math.max(vb, va), l: Math.min(vb, va), c: va, vol: t.sol, buy: t.side === 'buy' ? t.sol : 0, sell: t.side === 'sell' ? t.sol : 0, ts: t.ts });
    });
    return out;
  }
  const sec = TFS.find((x) => x.key === tf)!.sec;
  let cur: Bar | null = null;
  for (const t of ticks) {
    const b = Math.floor((Math.floor(t.ts / 1000) + TZ) / sec) * sec;
    const vb = val(t.pb, t.cb);
    const va = val(t.pa, t.ca);
    if (!cur || cur.t !== b) {
      // 新 K 线的开盘 = 上一根的收盘（成交前的价格），K 线连续
      cur = { t: b, o: vb, h: Math.max(vb, va), l: Math.min(vb, va), c: va, vol: 0, buy: 0, sell: 0, ts: t.ts };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, vb, va);
      cur.l = Math.min(cur.l, vb, va);
      cur.c = va;
    }
    cur.vol += t.sol;
    if (t.side === 'buy') cur.buy += t.sol;
    else cur.sell += t.sol;
  }
  return out;
}

function maOf(bars: Bar[], n: number): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= n) sum -= bars[i - n].c;
    out.push(i >= n - 1 ? sum / n : undefined);
  }
  return out;
}

export function SimKline({ v }: { v: SimView }) {
  const ticks = useSimTicks();
  const solTo = useSolTo();
  const { primary } = useCur();
  const colors = usePrefs().colors;
  const [cp, setCp] = useState<ChartPrefs>(loadPrefs);
  const [full, setFull] = useState(false);
  const [legend, setLegend] = useState<Legend | null>(null);
  const quote: Cur = cp.quote || primary;
  const k = solTo[quote] || 0;

  const setPref = (patch: Partial<ChartPrefs>) => {
    const next = { ...cp, ...patch };
    setCp(next);
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式等：只在本次打开期间有效 */
    }
  };

  const bars = useMemo(() => buildBars(ticks ?? [], cp.tf, cp.mode), [ticks, cp.tf, cp.mode]);
  const mas = useMemo(() => MA.map((m) => maOf(bars, m.n)), [bars]);

  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const sRef = useRef<{
    candle: ISeriesApi<'Candlestick'>;
    line: ISeriesApi<'Area'>;
    vol: ISeriesApi<'Histogram'>;
    ma: ISeriesApi<'Line'>[];
    markers: { candle: ISeriesMarkersPluginApi<Time>; line: ISeriesMarkersPluginApi<Time> };
  } | null>(null);
  const costLine = useRef<{ s: ISeriesApi<'Candlestick'> | ISeriesApi<'Area'>; l: IPriceLine } | null>(null);
  const live = useRef({ bars, mas, k, cp, quote });
  live.current = { bars, mas, k, cp, quote };
  const fitted = useRef('');
  const hovering = useRef(false);

  const sym = () => (live.current.quote === 'sol' ? '' : CUR_SYMBOL[live.current.quote]);
  const unit = () => (live.current.quote === 'sol' ? ' SOL' : '');
  const fmtV = (x: number) => (live.current.cp.mode === 'mcap' ? `${sym()}${fmtCompact(x)}${unit()}` : `${sym()}${fmtTiny(x)}${unit()}`);

  const timeLabel = (b: Bar) => {
    if (live.current.cp.tf === 'tick') {
      const d = new Date(b.ts);
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtClock(b.ts)}`;
    }
    const d = new Date(b.t * 1000);
    const day = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return live.current.cp.tf === '1d' ? `${d.getUTCFullYear()}-${day}` : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };

  const legendAt = (i: number): Legend | null => {
    const { bars: bs, mas: ms, k: kk } = live.current;
    const b = bs[i];
    if (!b) return null;
    return {
      time: timeLabel(b),
      o: b.o * kk,
      h: b.h * kk,
      l: b.l * kk,
      c: b.c * kk,
      chg: b.o > 0 ? b.c / b.o - 1 : b.c > 0 ? Infinity : 0,
      vol: b.vol * kk,
      ma: ms.map((m) => (m[i] !== undefined ? m[i]! * kk : undefined)),
    };
  };

  // ─── 建图（只建一次） ───
  useEffect(() => {
    const up = cssVar('--up');
    const down = cssVar('--down');
    const priceFormat = { type: 'custom' as const, formatter: (p: number) => fmtV(p), minMove: 1e-15 };
    const chart = createChart(box.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#7c98bf',
        fontFamily: FONT,
        fontSize: 10,
        attributionLogo: false,
        panes: { separatorColor: '#1d3a66', separatorHoverColor: 'rgba(34,211,238,0.15)', enableResize: false },
      },
      grid: { vertLines: { color: '#0f2446' }, horzLines: { color: '#0f2446' } },
      rightPriceScale: { borderColor: '#1d3a66', scaleMargins: { top: 0.2, bottom: 0.06 }, minimumWidth: 64 },
      timeScale: {
        borderColor: '#1d3a66',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        barSpacing: 9,
        minBarSpacing: 2,
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          const n = t as number;
          if (live.current.cp.tf === 'tick') {
            const b = live.current.bars[n];
            return b ? fmtClock(b.ts).slice(0, 5) : '';
          }
          const d = new Date(n * 1000);
          if (type === TickMarkType.Year) return String(d.getUTCFullYear());
          if (type === TickMarkType.Month) return `${d.getUTCMonth() + 1}月`;
          if (type === TickMarkType.DayOfMonth) return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
          return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(34,211,238,0.5)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#0b93ab' },
        horzLine: { color: 'rgba(34,211,238,0.5)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#0b93ab' },
      },
      localization: {
        locale: 'zh-CN',
        timeFormatter: (t: Time) => {
          const b = live.current.cp.tf === 'tick' ? live.current.bars[t as number] : live.current.bars.find((x) => x.t === (t as number));
          return b ? timeLabel(b) : '';
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true },
      kineticScroll: { touch: true, mouse: false },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
      priceFormat,
      priceLineColor: '#22d3ee',
      priceLineWidth: 1,
    });
    const line = chart.addSeries(AreaSeries, {
      lineColor: '#22d3ee',
      lineWidth: 2,
      topColor: 'rgba(34,211,238,0.12)',
      bottomColor: 'rgba(34,211,238,0)',
      priceFormat,
      priceLineColor: '#22d3ee',
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#071a36',
      crosshairMarkerBorderWidth: 2,
      visible: false,
    });
    const ma = MA.map((m) =>
      chart.addSeries(LineSeries, { color: m.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat }),
    );
    const vol = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'custom', formatter: (x: number) => fmtCompact(x), minMove: 1e-9 }, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    chart.panes()[1]?.setHeight(64);
    chartRef.current = chart;
    sRef.current = { candle, line, vol, ma, markers: { candle: createSeriesMarkers(candle, []), line: createSeriesMarkers(line, []) } };

    const onMove = (param: MouseEventParams) => {
      if (param.time === undefined || !param.point || param.point.x < 0) {
        hovering.current = false;
        setLegend(legendAt(live.current.bars.length - 1));
        return;
      }
      hovering.current = true;
      const n = param.time as number;
      const i = live.current.cp.tf === 'tick' ? n : live.current.bars.findIndex((b) => b.t === n);
      if (i >= 0) setLegend(legendAt(i));
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      sRef.current = null;
      costLine.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 涨跌颜色偏好
  useEffect(() => {
    const up = cssVar('--up');
    const down = cssVar('--down');
    sRef.current?.candle.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
  }, [colors]);

  // ─── 装数据 ───
  useEffect(() => {
    const s = sRef.current;
    const chart = chartRef.current;
    if (!s || !chart) return;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const tick = cp.tf === 'tick';
    const T = (b: Bar) => b.t as UTCTimestamp;
    const ts = chart.timeScale();
    const atRight = ts.scrollPosition() > -2;
    s.candle.applyOptions({ visible: !tick });
    s.line.applyOptions({ visible: tick });
    s.candle.setData(tick ? [] : bars.map((b) => ({ time: T(b), open: b.o * k, high: b.h * k, low: b.l * k, close: b.c * k })));
    s.line.setData(tick ? bars.map((b) => ({ time: T(b), value: b.c * k })) : []);
    s.vol.setData(bars.map((b) => ({ time: T(b), value: b.vol * k || 0, color: alpha(b.buy >= b.sell ? up : down, 0.55) })));
    s.ma.forEach((ser, i) =>
      ser.setData(
        cp.ma && !tick
          ? bars.flatMap((b, j) => (mas[i][j] !== undefined ? [{ time: T(b), value: mas[i][j]! * k }] : []))
          : [],
      ),
    );

    // 我的买卖标记（B / S），以及毕业点
    const marks: SeriesMarker<Time>[] = [];
    if (ticks?.length) {
      const idxOf = (t: SimTick, i: number) => (tick ? i : Math.floor((Math.floor(t.ts / 1000) + TZ) / TFS.find((x) => x.key === cp.tf)!.sec) * TFS.find((x) => x.key === cp.tf)!.sec);
      const seen = new Set<string>();
      ticks.forEach((t, i) => {
        const time = idxOf(t, i) as UTCTimestamp;
        if (t.grad && !seen.has(`g${time}`)) {
          seen.add(`g${time}`);
          marks.push({ time, position: 'aboveBar', shape: 'circle', color: cssVar('--warn'), text: '毕业' });
        }
        if (!t.me) return;
        const key = `${t.side}${time}`;
        if (seen.has(key)) return;
        seen.add(key);
        marks.push(
          t.side === 'buy'
            ? { time, position: 'belowBar', shape: 'arrowUp', color: up, text: 'B' }
            : { time, position: 'aboveBar', shape: 'arrowDown', color: down, text: 'S' },
        );
      });
      marks.sort((a, b) => (a.time as number) - (b.time as number));
    }
    s.markers.candle.setMarkers(tick ? [] : marks);
    s.markers.line.setMarkers(tick ? marks : []);

    // 我的持仓成本线（价格模式）
    const target = tick ? s.line : s.candle;
    if (costLine.current) {
      costLine.current.s.removePriceLine(costLine.current.l);
      costLine.current = null;
    }
    const me = v.me;
    if (me && me.tokens > 0 && cp.mode === 'price') {
      costLine.current = {
        s: target,
        l: target.createPriceLine({ price: (me.cost / me.tokens) * k, color: cssVar('--warn'), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '我的成本' }),
      };
    }

    const sig = `${cp.tf}|${cp.mode}|${quote}`;
    if (fitted.current !== sig) {
      fitted.current = sig;
      if (bars.length) ts.setVisibleLogicalRange({ from: Math.max(-2, bars.length - 70), to: bars.length + 3 });
    } else if (atRight) ts.scrollToRealTime();
    if (!hovering.current) setLegend(legendAt(bars.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, mas, k, cp.tf, cp.mode, cp.ma, quote, v.me?.tokens, v.me?.cost, ticks, colors]);

  const chgCls = legend ? (legend.chg > 0 ? 'up' : legend.chg < 0 ? 'down' : '') : '';
  const chgText = legend ? (legend.chg === Infinity ? '新' : `${legend.chg >= 0 ? '+' : ''}${(legend.chg * 100).toFixed(2)}%`) : '';
  const tfLabel = TFS.find((x) => x.key === cp.tf)!.label;

  return (
    <section className={`card sim-kline ${full ? 'sim-kline--full' : ''}`}>
      <div className="sim-kline__bar">
        <div className="sim-kline__tfs" role="group" aria-label="周期">
          {TFS.map((t) => (
            <button key={t.key} type="button" aria-pressed={cp.tf === t.key} onClick={() => setPref({ tf: t.key })}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="sim-kline__tools">
          <button type="button" aria-pressed={cp.mode === 'mcap'} onClick={() => setPref({ mode: cp.mode === 'mcap' ? 'price' : 'mcap' })} title="切换 市值 / 价格">
            {cp.mode === 'mcap' ? '市值' : '价格'}
          </button>
          <button
            type="button"
            onClick={() => setPref({ quote: quote === 'cny' ? 'usd' : quote === 'usd' ? 'sol' : 'cny' })}
            title="切换 人民币 / 美元 / SOL"
          >
            {quote === 'cny' ? '¥' : quote === 'usd' ? '$' : 'SOL'}
          </button>
          <button type="button" aria-pressed={cp.ma} onClick={() => setPref({ ma: !cp.ma })} title="均线 MA5 / MA10 / MA30">
            MA
          </button>
          <button type="button" onClick={() => setFull(!full)} aria-label={full ? '退出全屏' : '全屏'}>
            {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
      <div className="sim-kline__wrap">
        <div className="sim-kline__legend">
          <div className="sim-kline__title">
            <b>USVK</b>
            <span>
              · {tfLabel} · {cp.mode === 'mcap' ? '流通市值' : '价格'} · {quote === 'cny' ? '人民币' : quote === 'usd' ? '美元' : 'SOL'}
            </span>
            <span className="chip chip--warn">模拟</span>
          </div>
          {legend && (
            <>
              <div className="sim-kline__ohlc">
                <span className="muted">{legend.time}</span>
                {cp.tf !== 'tick' && legend.o !== undefined && (
                  <>
                    <span>
                      开<b className={chgCls}>{fmtV(legend.o)}</b>
                    </span>
                    <span>
                      高<b className={chgCls}>{fmtV(legend.h!)}</b>
                    </span>
                    <span>
                      低<b className={chgCls}>{fmtV(legend.l!)}</b>
                    </span>
                  </>
                )}
                <span>
                  收<b className={chgCls}>{fmtV(legend.c)}</b>
                </span>
                <b className={chgCls}>{chgText}</b>
              </div>
              <div className="sim-kline__ohlc">
                <span>
                  量<b>
                    {quote === 'sol' ? '' : CUR_SYMBOL[quote]}
                    {fmtCompact(legend.vol)}
                    {quote === 'sol' ? ' SOL' : ''}
                  </b>
                </span>
                {cp.ma &&
                  cp.tf !== 'tick' &&
                  MA.map((m, i) =>
                    legend.ma[i] !== undefined ? (
                      <span key={m.n} style={{ color: m.color }}>
                        MA{m.n} {fmtV(legend.ma[i]!)}
                      </span>
                    ) : null,
                  )}
              </div>
            </>
          )}
        </div>
        <div ref={box} className="sim-kline__chart" />
        {ticks && !ticks.length && <div className="sim-kline__empty">还没有成交 · 第一笔买入后这里开始画 K 线（市值从 0 开始）</div>}
      </div>
      <p className="card__note">
        和 TradingView 同一套图表引擎：双指 / 滚轮缩放，拖动平移，长按或悬停看每根 K 线的开高低收。B / S 是你自己的买卖，"毕业"是内盘买满的那一笔。
        {cp.mode === 'mcap' ? '市值 = 现价 × 大家手里的代币（流通市值），开盘没人买时是 0。' : '价格模式下虚线是你的持仓成本。'}
      </p>
    </section>
  );
}
