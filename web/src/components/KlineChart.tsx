import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LastPriceAnimationMode,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TIMEFRAMES, applyTrade, quoteFactor, type Candle, type Fx, type Quote } from '../../../shared/candles';
import type { Trade } from '../../../shared/types';
import { getJSON } from '../lib/api';
import { CUR_SYMBOL, fmtClock, fmtCompact, fmtNum, fmtTiny } from '../lib/format';
import { setPrefs, usePrefs } from '../lib/prefs';
import { getState, onReset, onTrade, useStore } from '../lib/store';
import { Seg } from './ui';

const TF_OPTIONS = [{ key: 'tick', label: '逐笔' }, ...TIMEFRAMES.map((t) => ({ key: t.key as string, label: t.key as string }))];
const CHART_FONT = "'PingFang SC', 'HarmonyOS Sans SC', 'Noto Sans SC', 'Microsoft YaHei', system-ui, -apple-system, 'Segoe UI', sans-serif";
const TZ = -new Date().getTimezoneOffset() * 60; // 图表内部用"本地时间当 UTC"，刻度即为本地时间
const MA = [
  { n: 5, color: '#c98500' },
  { n: 10, color: '#d55181' },
  { n: 30, color: '#9085e9' },
];
const pad = (n: number) => String(n).padStart(2, '0');

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function alpha(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

interface LegendData {
  time: string;
  o?: number;
  h?: number;
  l?: number;
  c: number;
  chg?: number;
  vol?: number;
}

export function KlineChart() {
  const prefs = usePrefs();
  const tf = prefs.chartTf;
  const quote = prefs.chartQuote;
  const mode = prefs.chartMode;
  const supply = useStore((s) => s.snap?.supply ?? 1e9);
  const tradeCount = useStore((s) => s.snap?.stats.totalTrades ?? 0);
  const slot = useStore((s) => s.slot);
  const lastTrade = useStore((s) => s.trades[s.trades.length - 1]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    candle: ISeriesApi<'Candlestick'>;
    tick: ISeriesApi<'Area'>;
    vol: ISeriesApi<'Histogram'>;
    ma: ISeriesApi<'Line'>[];
  } | null>(null);
  const cfg = useRef({ tf, quote, mode, supply, showMA: prefs.chartMA });
  cfg.current = { tf, quote, mode, supply, showMA: prefs.chartMA };
  const candlesRef = useRef<Candle[]>([]);
  const ticksRef = useRef<Trade[]>([]);
  const reqId = useRef(0);
  const hovering = useRef(false);

  const [legend, setLegend] = useState<LegendData | null>(null);
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [full, setFull] = useState(false);

  const fx = (): Fx => {
    const p = getState().snap?.solPrice;
    return { solUsd: p?.usd ?? 0, usdCny: p?.usdCny ?? 7.1 };
  };
  const scale = () => (cfg.current.mode === 'mcap' ? cfg.current.supply : 1);
  const unit = () => (cfg.current.quote === 'sol' ? ' SOL' : '');
  const sym = () => CUR_SYMBOL[cfg.current.quote as 'usd' | 'cny' | 'sol'];

  const fmtAxis = (p: number) => (cfg.current.mode === 'mcap' ? `${sym()}${fmtCompact(p)}` : fmtTiny(p));
  // 图例：数值不带货币符号，单位在图例开头统一标注
  const fmtVal = (p: number) => (cfg.current.mode === 'mcap' ? fmtCompact(p) : fmtTiny(p));
  const unitTag = () => `${cfg.current.quote === 'cny' ? '¥ 人民币' : cfg.current.quote === 'usd' ? '$ 美元' : 'SOL'}${cfg.current.mode === 'mcap' ? ' · 市值' : ''}`;
  const volOf = (c: Candle) => (cfg.current.quote === 'sol' ? c.volume : cfg.current.quote === 'usd' ? c.volumeUsd : c.volumeUsd * fx().usdCny);
  const fmtVol = (v: number) => `${sym()}${fmtCompact(v)}${unit()}`;

  const tickTime = (t: Trade) => t.chainMs ?? t.recvMs ?? t.ts * 1000;
  /** 实时推送的成交带毫秒；历史回填的成交只有链上秒级时间戳，不伪造毫秒 */
  const tickLabel = (t: Trade) => (t.chainMs || t.recvMs ? fmtClock(tickTime(t), true) : fmtClock(t.ts * 1000));

  // ─── 初始化图表（只执行一次） ────────────────────────────────
  useEffect(() => {
    const el = boxRef.current!;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#7c98bf',
        fontFamily: CHART_FONT,
        fontSize: 10,
        attributionLogo: false,
        panes: { separatorColor: '#1d3a66', separatorHoverColor: 'rgba(34,211,238,0.15)', enableResize: false },
      },
      grid: { vertLines: { color: '#0f2446' }, horzLines: { color: '#0f2446' } },
      rightPriceScale: { borderColor: '#1d3a66', scaleMargins: { top: 0.24, bottom: 0.06 }, minimumWidth: 64 },
      timeScale: {
        borderColor: '#1d3a66',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 6,
        barSpacing: 8,
        minBarSpacing: 1,
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          const v = t as number;
          if (cfg.current.tf === 'tick') {
            const tr = ticksRef.current[v];
            return tr ? fmtClock(tickTime(tr)) : '';
          }
          const d = new Date(v * 1000);
          switch (type) {
            case TickMarkType.Year:
              return String(d.getUTCFullYear());
            case TickMarkType.Month:
              return `${d.getUTCMonth() + 1}月`;
            case TickMarkType.DayOfMonth:
              return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
            case TickMarkType.TimeWithSeconds:
              return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
            default:
              return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
          }
        },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(34,211,238,0.5)', width: 1, style: LineStyle.Solid, labelBackgroundColor: '#0b93ab' },
        horzLine: { color: 'rgba(34,211,238,0.5)', width: 1, style: LineStyle.Solid, labelBackgroundColor: '#0b93ab' },
      },
      localization: {
        locale: 'zh-CN',
        // 注意：不设置全局 priceFormatter —— 它会覆盖每个 series 自己的格式（成交量副图需要独立格式）
        timeFormatter: (t: Time) => {
          const v = t as number;
          if (cfg.current.tf === 'tick') {
            const tr = ticksRef.current[v];
            return tr ? tickLabel(tr) : '';
          }
          const d = new Date(v * 1000);
          const day = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
          const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
          const sec = TIMEFRAMES.find((x) => x.key === cfg.current.tf)?.sec ?? 60;
          if (sec >= 86400) return `${d.getUTCFullYear()}-${day}`;
          return sec < 60 ? `${day} ${hm}:${pad(d.getUTCSeconds())}` : `${day} ${hm}`;
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true },
      kineticScroll: { touch: true, mouse: false },
    });
    const priceFormat = { type: 'custom' as const, formatter: (p: number) => fmtAxis(p), minMove: 1e-12 };
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
    const tick = chart.addSeries(AreaSeries, {
      lineColor: '#22d3ee',
      lineWidth: 2,
      topColor: 'rgba(34,211,238,0.10)',
      bottomColor: 'rgba(34,211,238,0)',
      lastPriceAnimation: LastPriceAnimationMode.Continuous,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#071a36',
      crosshairMarkerBorderWidth: 2,
      priceFormat,
      priceLineColor: '#22d3ee',
      visible: false,
    });
    const ma = MA.map((m) =>
      chart.addSeries(LineSeries, {
        color: m.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat,
      }),
    );
    const vol = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'custom', formatter: (v: number) => fmtCompact(v), minMove: 1e-9 },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1,
    );
    chart.panes()[1]?.setHeight(62);
    chartRef.current = chart;
    seriesRef.current = { candle, tick, vol, ma };

    const onMove = (param: MouseEventParams) => {
      if (!param.time || !param.point || param.point.x < 0) {
        hovering.current = false;
        setLegend(lastLegend());
        return;
      }
      hovering.current = true;
      const v = param.time as number;
      if (cfg.current.tf === 'tick') {
        const tr = ticksRef.current[v];
        if (!tr) return;
        const k = quoteFactor(tr, cfg.current.quote, fx()) * scale();
        setLegend({
          time: tickLabel(tr),
          c: tr.priceSol * k,
          chg: tr.prePriceSol > 0 ? tr.priceSol / tr.prePriceSol - 1 : 0,
          vol: tr.sol * quoteFactor(tr, cfg.current.quote, fx()),
        });
        return;
      }
      const c = candlesRef.current.find((x) => x.time + TZ === v);
      if (c) setLegend(candleLegend(c));
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 涨跌颜色偏好变化
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    const up = cssVar('--up');
    const down = cssVar('--down');
    s.candle.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.colors]);

  const candleLegend = (c: Candle): LegendData => {
    const k = scale();
    const sec = TIMEFRAMES.find((x) => x.key === cfg.current.tf)?.sec ?? 60;
    const d = new Date((c.time + TZ) * 1000);
    const time =
      sec >= 86400
        ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
        : `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${sec < 60 ? ':' + pad(d.getUTCSeconds()) : ''}`;
    return { time, o: c.open * k, h: c.high * k, l: c.low * k, c: c.close * k, chg: c.open > 0 ? c.close / c.open - 1 : 0, vol: volOf(c) };
  };

  const lastLegend = (): LegendData | null => {
    if (cfg.current.tf === 'tick') {
      const tr = ticksRef.current[ticksRef.current.length - 1];
      if (!tr) return null;
      const f = quoteFactor(tr, cfg.current.quote, fx());
      return { time: tickLabel(tr), c: tr.priceSol * f * scale(), chg: tr.prePriceSol > 0 ? tr.priceSol / tr.prePriceSol - 1 : 0, vol: tr.sol * f };
    }
    const c = candlesRef.current[candlesRef.current.length - 1];
    return c ? candleLegend(c) : null;
  };

  // ─── 数据装载 ────────────────────────────────────────────────
  const toBar = (c: Candle) => {
    const k = scale();
    return { time: (c.time + TZ) as UTCTimestamp, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k };
  };
  const toVol = (c: Candle) => ({
    time: (c.time + TZ) as UTCTimestamp,
    value: volOf(c),
    color: c.buyVolume >= c.sellVolume ? alpha(cssVar('--up'), 0.55) : alpha(cssVar('--down'), 0.55),
  });

  const maData = (n: number) => {
    const arr = candlesRef.current;
    const out: { time: UTCTimestamp; value: number }[] = [];
    let sum = 0;
    const k = scale();
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i].close;
      if (i >= n) sum -= arr[i - n].close;
      if (i >= n - 1) out.push({ time: (arr[i].time + TZ) as UTCTimestamp, value: (sum / n) * k });
    }
    return out;
  };

  const renderCandles = (fit: boolean) => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    if (!s || !chart) return;
    const data = candlesRef.current;
    s.candle.setData(data.map(toBar));
    s.vol.setData(data.map(toVol));
    s.ma.forEach((ser, i) => ser.setData(cfg.current.showMA ? maData(MA[i].n) : []));
    s.tick.setData([]);
    setEmpty(!data.length);
    if (fit && data.length) chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, data.length - 90), to: data.length + 4 });
  };

  const tickPoint = (t: Trade, i: number) => ({
    time: i as UTCTimestamp,
    value: t.priceSol * quoteFactor(t, cfg.current.quote, fx()) * scale(),
  });
  const tickVol = (t: Trade, i: number) => ({
    time: i as UTCTimestamp,
    value: t.sol * quoteFactor(t, cfg.current.quote, fx()),
    color: t.isBuy ? alpha(cssVar('--up'), 0.6) : alpha(cssVar('--down'), 0.6),
  });

  const renderTicks = (fit: boolean) => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    if (!s || !chart) return;
    const ticks = ticksRef.current;
    s.candle.setData([]);
    s.ma.forEach((m) => m.setData([]));
    s.tick.setData(ticks.map(tickPoint));
    s.vol.setData(ticks.map(tickVol));
    setEmpty(!ticks.length);
    if (fit && ticks.length) chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, ticks.length - 120), to: ticks.length + 3 });
  };

  const load = useCallback(async () => {
    const s = seriesRef.current;
    if (!s) return;
    const id = ++reqId.current;
    const { tf, quote } = cfg.current;
    setLoading(true);
    try {
      const isTick = tf === 'tick';
      s.candle.applyOptions({ visible: !isTick });
      s.tick.applyOptions({ visible: isTick });
      s.ma.forEach((m) => m.applyOptions({ visible: !isTick && cfg.current.showMA }));
      chartRef.current?.applyOptions({ timeScale: { secondsVisible: isTick || (TIMEFRAMES.find((x) => x.key === tf)?.sec ?? 60) < 60 } });
      if (isTick) {
        const trades = await getJSON<Trade[]>('/api/trades?limit=2000');
        if (id !== reqId.current) return;
        // 与本地实时流合并（防止请求期间到达的成交丢失）
        const seen = new Set(trades.map((t) => t.id));
        for (const t of getState().trades) if (!seen.has(t.id) && t.ts >= (trades[trades.length - 1]?.ts ?? 0)) trades.push(t);
        ticksRef.current = trades;
        renderTicks(true);
      } else {
        const sec = TIMEFRAMES.find((x) => x.key === tf)?.sec ?? 60;
        const data = await getJSON<Candle[]>(`/api/candles?tf=${sec}&quote=${quote}&limit=3000`);
        if (id !== reqId.current) return;
        candlesRef.current = data;
        renderCandles(true);
      }
      if (!hovering.current) setLegend(lastLegend());
    } catch {
      /* 网络异常时保留上一帧 */
    } finally {
      if (id === reqId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 周期 / 计价 / 价格-市值 / 均线 变化时重新装载
  useEffect(() => {
    void load();
  }, [tf, quote, mode, prefs.chartMA, supply, load]);

  // 全量刷新信号
  useEffect(() => onReset(() => void load()), [load]);

  // ─── 实时：每笔成交增量更新最后一根 K 线 ─────────────────────
  useEffect(
    () =>
      onTrade((t) => {
        const s = seriesRef.current;
        if (!s) return;
        if (cfg.current.tf === 'tick') {
          if (ticksRef.current.some((x) => x.id === t.id)) return;
          ticksRef.current.push(t);
          const i = ticksRef.current.length - 1;
          s.tick.update(tickPoint(t, i));
          s.vol.update(tickVol(t, i));
          setEmpty(false);
        } else {
          const sec = TIMEFRAMES.find((x) => x.key === cfg.current.tf)?.sec ?? 60;
          const c = applyTrade(candlesRef.current, t, sec, cfg.current.quote, fx());
          if (!c) return void load(); // 乱序成交：整体重建
          s.candle.update(toBar(c));
          s.vol.update(toVol(c));
          if (cfg.current.showMA) {
            s.ma.forEach((ser, i) => {
              const d = maData(MA[i].n);
              const last = d[d.length - 1];
              if (last) ser.update(last);
            });
          }
          setEmpty(false);
        }
        if (!hovering.current) setLegend(lastLegend());
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  // ─── 全屏（横屏看盘） ─────────────────────────────────────────
  const toggleFull = async () => {
    const next = !full;
    setFull(next);
    try {
      if (next) {
        await document.documentElement.requestFullscreen?.();
        await (screen.orientation as any)?.lock?.('landscape');
      } else {
        (screen.orientation as any)?.unlock?.();
        if (document.fullscreenElement) await document.exitFullscreen();
      }
    } catch {
      /* iOS 等不支持时仅使用页面内全屏 */
    }
  };
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const chgCls = legend?.chg ? (legend.chg > 0 ? 'up' : 'down') : '';
  const latency = lastTrade?.recvMs && lastTrade.chainMs ? lastTrade.recvMs - lastTrade.chainMs : null;

  return (
    <div ref={wrapRef} className={`kline ${full ? 'kline--full card' : ''}`}>
      <div className="tf-row" role="group" aria-label="K 线周期">
        {TF_OPTIONS.map((o) => (
          <button key={o.key} type="button" aria-pressed={tf === o.key} onClick={() => setPrefs({ chartTf: o.key })}>
            {o.label}
          </button>
        ))}
      </div>
      <div className="kline__tools">
        <Seg<Quote>
          label="计价货币"
          value={quote}
          onChange={(v) => setPrefs({ chartQuote: v })}
          options={[
            { value: 'cny', label: '¥ 人民币' },
            { value: 'usd', label: '$ 美元' },
            { value: 'sol', label: 'SOL' },
          ]}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <Seg<'price' | 'mcap'>
            label="价格或市值"
            value={mode}
            onChange={(v) => setPrefs({ chartMode: v })}
            options={[
              { value: 'price', label: '价格' },
              { value: 'mcap', label: '市值' },
            ]}
          />
          <button type="button" className={`icon-btn ${prefs.chartMA ? 'icon-btn--on' : ''}`} style={{ width: 'auto', padding: '0 8px', height: 32, fontSize: 11, fontFamily: 'var(--font-mono)' }} aria-pressed={prefs.chartMA} onClick={() => setPrefs({ chartMA: !prefs.chartMA })}>
            MA
          </button>
          <button type="button" className="icon-btn" style={{ width: 32, height: 32 }} aria-label={full ? '退出全屏' : '全屏横屏看盘'} onClick={toggleFull}>
            {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>

      <div className="kline__chart" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .2s' }}>
        {legend && (
          <div className="kline__legend">
            <span className="chip chip--accent" style={{ height: 17, fontSize: 10, padding: '0 5px' }}>{unitTag()}</span>
            <span>{legend.time}</span>
            {legend.o !== undefined && (
              <>
                <span>
                  开 <b>{fmtVal(legend.o)}</b>
                </span>
                <span>
                  高 <b>{fmtVal(legend.h!)}</b>
                </span>
                <span>
                  低 <b>{fmtVal(legend.l!)}</b>
                </span>
              </>
            )}
            <span>
              {legend.o !== undefined ? '收' : '成交价'} <b className={chgCls}>{fmtVal(legend.c)}</b>
            </span>
            {legend.chg !== undefined && (
              <span className={chgCls}>
                {legend.chg > 0 ? '+' : ''}
                {(legend.chg * 100).toFixed(2)}%
              </span>
            )}
            {legend.vol !== undefined && <span>量 {fmtVol(legend.vol)}</span>}
          </div>
        )}
        {empty && !loading && <div className="kline__empty">该周期暂无成交</div>}
        <div ref={boxRef} style={{ position: 'absolute', inset: 0 }} />
      </div>

      {tf !== 'tick' && prefs.chartMA && (
        <div className="kline__ma" aria-label="均线图例">
          {MA.map((m) => (
            <span key={m.n}>
              <i style={{ background: m.color }} />
              MA{m.n}
            </span>
          ))}
        </div>
      )}
      <div className="kline__foot">
        <span>链上 TradeEvent · 累计 {fmtNum(tradeCount, 0)} 笔</span>
        <span>
          SLOT #{slot ? slot.toLocaleString('en-US') : '—'}
          {latency !== null && latency >= 0 && latency < 60_000 ? ` · 出块→接收 ${latency}ms` : ''}
        </span>
      </div>
    </div>
  );
}
