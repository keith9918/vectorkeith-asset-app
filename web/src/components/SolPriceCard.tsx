import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SolCandle, SolCandles, SolRange } from '../../../shared/types';
import { getJSON } from '../lib/api';
import { useSolLevels } from '../lib/explore';
import { fmtMoney, fmtNum, fmtPct, type Cur } from '../lib/format';
import { useTreasuryHistory } from '../lib/history';
import { setPrefs, usePrefs } from '../lib/prefs';
import { useStore } from '../lib/store';
import { useCur } from './Shell';
import { Card, Seg } from './ui';

const TZ = -new Date().getTimezoneOffset() * 60; // 图表内部用"本地时间当 UTC"，刻度即为本地时间
const pad = (n: number) => String(n).padStart(2, '0');
const RANGES: { value: SolRange; label: string; name: string }[] = [
  { value: '24h', label: '24H', name: '24 小时' },
  { value: '7d', label: '7D', name: '7 天' },
  { value: '30d', label: '30D', name: '30 天' },
  { value: '1y', label: '1年', name: '1 年' },
  { value: 'all', label: '全部', name: '上线以来' },
];
const MIN_FLOW = 1; // 公司钱包单笔 ≥ 1 SOL 的转入转出才在图上标出来

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 时间标签：日 K 及以上只显示日期 */
function timeLabel(sec: number, step: number) {
  const d = new Date(sec * 1000);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return step >= 86400 ? day : `${day.slice(5)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const cache = new Map<SolRange, { at: number; data: SolCandles }>();

function useSolCandles(range: SolRange) {
  const [data, setData] = useState<SolCandles | null>(cache.get(range)?.data ?? null);
  const [error, setError] = useState('');
  useEffect(() => {
    const hit = cache.get(range);
    setData(hit?.data ?? null);
    setError('');
    let cancelled = false;
    const load = () =>
      getJSON<SolCandles>(`/api/sol/candles?range=${range}`)
        .then((d) => {
          cache.set(range, { at: Date.now(), data: d });
          if (!cancelled) setData(d);
        })
        .catch((e) => !cancelled && setError((e as Error).message));
    if (!hit || Date.now() - hit.at > 60_000) void load();
    // 短周期定时刷新（新 K 线），长周期靠实时价更新最后一根
    const id = range === '24h' || range === '7d' ? window.setInterval(load, range === '24h' ? 60_000 : 300_000) : undefined;
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [range]);
  return { data, error };
}

interface Flow {
  in: number;
  out: number;
}

export function SolPriceCard() {
  const prefs = usePrefs();
  const { primary, secondary } = useCur();
  const live = useStore((s) => s.snap?.solPrice);
  const range = prefs.solRange;
  const mode = prefs.solChart;
  const { data, error } = useSolCandles(range);
  const history = useTreasuryHistory();
  const levels = useSolLevels();
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaRef = useRef<ISeriesApi<'Area'> | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<{ area: ISeriesMarkersPluginApi<Time>; candle: ISeriesMarkersPluginApi<Time> } | null>(null);
  const lineRef = useRef<{ area?: IPriceLine; candle?: IPriceLine }>({});
  const fitted = useRef('');
  const [tip, setTip] = useState<{ x: number; c: SolCandle; flow?: Flow } | null>(null);

  const usdCny = live?.usdCny ?? 7.1;
  const rate = (c: Cur) => (c === 'cny' ? usdCny : 1);
  const k = rate(primary);

  // 最后一根 K 线用实时价格
  const candles = useMemo<SolCandle[]>(() => {
    const list = data?.candles ?? [];
    if (!list.length || !live?.usd) return list;
    const last = list[list.length - 1];
    if (Date.now() / 1000 > last.t + (data!.sec * 2)) return list; // 数据太旧时不硬接
    const c = live.usd;
    return [...list.slice(0, -1), { ...last, c, h: Math.max(last.h, c), l: Math.min(last.l, c) }];
  }, [data, live?.usd]);

  // 公司钱包的转入 / 转出，按 K 线时间分桶
  const flows = useMemo(() => {
    const m = new Map<number, Flow>();
    if (!data || !candles.length || range === 'all') return m;
    const step = data.sec;
    const from = candles[0].t;
    for (const p of history) {
      if (p.d === undefined || p.t < from || (p.k !== 'in' && p.k !== 'out')) continue;
      if (Math.abs(p.d) < MIN_FLOW) continue;
      // 找到这笔交易所在的 K 线（周 K 的开盘时间不一定整除，所以按位置找）
      let lo = 0;
      let hi = candles.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (candles[mid].t <= p.t) lo = mid;
        else hi = mid - 1;
      }
      if (p.t >= candles[lo].t + step * 1.5) continue;
      const f = m.get(candles[lo].t) ?? { in: 0, out: 0 };
      if (p.d > 0) f.in += p.d;
      else f.out += -p.d;
      m.set(candles[lo].t, f);
    }
    return m;
  }, [history, data, candles, range]);

  // ─── 建图（只建一次） ───
  useEffect(() => {
    const up = cssVar('--up');
    const down = cssVar('--down');
    const chart = createChart(boxRef.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#7c98bf',
        fontSize: 10,
        fontFamily: "'PingFang SC', 'Noto Sans SC', 'Microsoft YaHei', system-ui, -apple-system, 'Segoe UI', sans-serif",
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: '#0f2446' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: '#1d3a66', timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true, rightOffset: 2 },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: 'rgba(34,211,238,0.5)', width: 1, style: LineStyle.Solid, labelVisible: false },
        horzLine: { color: 'rgba(34,211,238,0.35)', width: 1, style: LineStyle.Solid, labelVisible: true },
      },
      localization: { locale: 'zh-CN', priceFormatter: (v: number) => fmtNum(v, v >= 1000 ? 0 : 2) },
      handleScroll: { vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true },
    });
    // 价格不会是负数：自动缩放的下限夹到 0
    const autoscaleInfoProvider = (orig: () => any) => {
      const r = orig();
      if (r?.priceRange) r.priceRange.minValue = Math.max(0, r.priceRange.minValue);
      return r;
    };
    const area = chart.addSeries(AreaSeries, {
      autoscaleInfoProvider,
      lineColor: '#22d3ee',
      lineWidth: 2,
      topColor: 'rgba(34,211,238,0.10)',
      bottomColor: 'rgba(34,211,238,0)',
      priceLineColor: '#22d3ee',
      priceLineWidth: 1,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#071a36',
      crosshairMarkerBorderWidth: 2,
    });
    const candle = chart.addSeries(CandlestickSeries, {
      autoscaleInfoProvider,
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
      priceLineColor: '#22d3ee',
      priceLineWidth: 1,
      visible: false,
    });
    chartRef.current = chart;
    areaRef.current = area;
    candleRef.current = candle;
    markersRef.current = { area: createSeriesMarkers(area, []), candle: createSeriesMarkers(candle, []) };
    return () => {
      chart.remove();
      chartRef.current = null;
      areaRef.current = null;
      candleRef.current = null;
      markersRef.current = null;
      lineRef.current = {};
    };
  }, []);

  // 涨跌颜色偏好变化
  useEffect(() => {
    const up = cssVar('--up');
    const down = cssVar('--down');
    candleRef.current?.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
  }, [prefs.colors]);

  // ─── 数据 ───
  useEffect(() => {
    const chart = chartRef.current;
    const area = areaRef.current;
    const candle = candleRef.current;
    const mk = markersRef.current;
    if (!chart || !area || !candle || !mk) return;
    const T = (t: number) => (t + TZ) as UTCTimestamp;
    area.setData(candles.map((c) => ({ time: T(c.t), value: c.c * k })));
    candle.setData(candles.map((c) => ({ time: T(c.t), open: c.o * k, high: c.h * k, low: c.l * k, close: c.c * k })));
    area.applyOptions({ visible: mode === 'line' });
    candle.applyOptions({ visible: mode === 'candle' });

    // 公司转入 ▲（K 线下方）/ 转出 ▼（K 线上方）
    const up = cssVar('--up');
    const down = cssVar('--down');
    const markers: SeriesMarker<Time>[] = [];
    for (const [t, f] of [...flows].sort((a, b) => a[0] - b[0])) {
      if (f.in > 0) markers.push({ time: T(t), position: 'belowBar', shape: 'arrowUp', color: up, size: 1 });
      if (f.out > 0) markers.push({ time: T(t), position: 'aboveBar', shape: 'arrowDown', color: down, size: 1 });
    }
    mk.area.setMarkers(mode === 'line' ? markers : []);
    mk.candle.setMarkers(mode === 'candle' ? markers : []);

    // 公司入账均价（参考线）
    for (const key of ['area', 'candle'] as const) {
      const s = key === 'area' ? area : candle;
      if (lineRef.current[key]) s.removePriceLine(lineRef.current[key]!);
      lineRef.current[key] = levels?.avgIn
        ? s.createPriceLine({ price: levels.avgIn * k, color: '#f5c542', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '入账均价' })
        : undefined;
    }

    // 只在首次、切换范围 / 货币 / 图型时铺满；实时价跳动不打断缩放
    const fitKey = `${range}|${primary}|${mode}|${data?.source ?? ''}`;
    if (candles.length && fitted.current !== fitKey) {
      fitted.current = fitKey;
      chart.timeScale().fitContent();
    }

    const byTime = new Map(candles.map((c) => [c.t, c]));
    const onMove = (param: any) => {
      if (!param.time || !param.point) return setTip(null);
      const t = (param.time as number) - TZ;
      const c = byTime.get(t);
      if (!c) return setTip(null);
      setTip({ x: param.point.x, c, flow: flows.get(t) });
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, flows, mode, k, levels?.avgIn, prefs.colors]);

  const now = live?.usd ?? candles[candles.length - 1]?.c ?? 0;
  const first = candles[0];
  const change = first && now ? now / first.o - 1 : null;
  const hi = candles.length ? Math.max(...candles.map((c) => c.h)) : 0;
  const lo = candles.length ? Math.min(...candles.map((c) => c.l)) : 0;
  const rangeName = RANGES.find((r) => r.value === range)!.name;
  const money = (usd: number, c: Cur) => fmtMoney(usd * rate(c), c);
  const boxW = boxRef.current?.clientWidth ?? 300;
  const flowCount = flows.size;

  return (
    <Card kicker="SOL Price" title="SOL 价格" id="sol-price" right={<Seg<'line' | 'candle'> label="图表类型" value={mode} onChange={(v) => setPrefs({ solChart: v })} options={[{ value: 'line', label: '走势' }, { value: 'candle', label: 'K线' }]} />}>
      <div className="sol-head">
        <div className="sol-head__price">
          {now ? money(now, primary) : '—'}
          <span className="dim">{now ? money(now, secondary) : ''}</span>
        </div>
        {change !== null && (
          <span className={`chip ${change > 0 ? 'chip--up' : change < 0 ? 'chip--down' : ''} num`}>
            {change > 0 ? '▲ ' : change < 0 ? '▼ ' : ''}
            {fmtPct(Math.abs(change), 2)} · {rangeName}
          </span>
        )}
      </div>
      <div className="sol-stats">
        <span>
          最高 <b>{hi ? money(hi, primary) : '—'}</b>
        </span>
        <span>
          最低 <b>{lo ? money(lo, primary) : '—'}</b>
        </span>
        {levels?.avgIn ? (
          <span>
            <i className="sol-key sol-key--avg" />
            入账均价 <b>{money(levels.avgIn, primary)}</b>
            <em className={now >= levels.avgIn ? 'up' : 'down'}> 现价{now >= levels.avgIn ? '高' : '低'} {fmtPct(Math.abs(now / levels.avgIn - 1), 1)}</em>
          </span>
        ) : null}
      </div>

      <div className="tf-row" role="group" aria-label="时间范围" style={{ marginTop: 10 }}>
        {RANGES.map((r) => (
          <button key={r.value} type="button" aria-pressed={range === r.value} onClick={() => setPrefs({ solRange: r.value })}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="chart-box" style={{ height: 220 }}>
        <div ref={boxRef} style={{ position: 'absolute', inset: 0 }} />
        {tip && (
          <div className="tooltip" style={{ left: Math.min(Math.max(tip.x - 85, 4), boxW - 180), top: 6 }}>
            <div className="tooltip__v">
              {money(tip.c.c, primary)} <span className="tooltip__k" style={{ display: 'inline' }}>{money(tip.c.c, secondary)}</span>
            </div>
            <div className="tooltip__k">{timeLabel(tip.c.t, data?.sec ?? 300)}</div>
            {mode === 'candle' && (
              <div className="tooltip__k mono">
                开 {fmtNum(tip.c.o * k, 2)} 高 {fmtNum(tip.c.h * k, 2)} 低 {fmtNum(tip.c.l * k, 2)}
              </div>
            )}
            {tip.flow?.in ? <div className="tooltip__k up">▲ 公司转入 +{fmtNum(tip.flow.in, 2)} SOL</div> : null}
            {tip.flow?.out ? <div className="tooltip__k down">▼ 公司转出 −{fmtNum(tip.flow.out, 2)} SOL</div> : null}
          </div>
        )}
        {!candles.length && <div className="kline__empty">{error ? `SOL 行情暂时取不到：${error}` : '正在加载 SOL 行情…'}</div>}
      </div>
      <div className="legend" style={{ marginTop: 6 }}>
        <span>
          <i className="sol-key sol-key--line" />
          SOL / {primary === 'cny' ? '人民币' : '美元'}
        </span>
        {range === 'all' && <span className="muted">"全部"用周 K 线，不标公司进出</span>}
        {flowCount > 0 && (
          <span>
            <b className="up">▲</b>
            <b className="down">▼</b> 公司钱包转入 / 转出 ≥ {MIN_FLOW} SOL
          </span>
        )}
        {levels?.avgIn ? (
          <span>
            <i className="sol-key sol-key--avg" />
            公司入账均价
          </span>
        ) : null}
      </div>
      <p className="card__note">
        SOL 价格决定公司资产值多少钱：公司钱包里的 SOL 数量不变时，SOL 涨 1%，公司资产也涨 1%。行情来自{data?.source === 'CoinGecko' ? ' CoinGecko' : '币安'}，最新价实时更新；人民币按现在的汇率换算。"入账均价"是公司钱包每次收到 SOL 时价格的加权平均。
      </p>
    </Card>
  );
}
