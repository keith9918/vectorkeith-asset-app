import { AreaSeries, ColorType, CrosshairMode, LineStyle, LineType, createChart, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TreasuryHistoryPoint } from '../../../shared/types';
import { fmtCompact, fmtDate, fmtMoney, fmtNum, type Cur } from '../lib/format';

// ─── 分段条：一个整体拆成几部分（池子 / 公司 / 外部） ────────────────

export interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
  detail?: string;
}

export function SegmentedBar({ parts, thin, total }: { parts: Part[]; thin?: boolean; total?: number }) {
  const sum = total ?? parts.reduce((s, p) => s + p.value, 0);
  const [active, setActive] = useState<string | null>(null);
  return (
    <div>
      <div className={`segbar ${thin ? 'segbar--thin' : ''}`} role="img" aria-label={parts.map((p) => `${p.label} ${((p.value / sum) * 100).toFixed(2)}%`).join('，')}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => {
            const pct = (p.value / sum) * 100;
            const label = `${pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)}%`;
            // 只有放得下时才在色块内写数字（约 7px/字符 + 内边距）
            const fits = !thin && pct * 3.4 > label.length * 7 + 16;
            return (
              <div
                key={p.key}
                className="segbar__part"
                tabIndex={0}
                title={`${p.label}：${label}${p.detail ? ' · ' + p.detail : ''}`}
                onPointerEnter={() => setActive(p.key)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(p.key)}
                onBlur={() => setActive(null)}
                style={{
                  flex: `${Math.max(pct, 0.6)} 1 0`,
                  background: p.color,
                  filter: active && active !== p.key ? 'brightness(0.7)' : undefined,
                }}
              >
                {fits ? label : ''}
              </div>
            );
          })}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.key}>
            <i className="swatch" style={{ background: p.color }} />
            {p.label}
            <b className="num" style={{ color: 'var(--text-1)', fontWeight: 600 }}>
              {sum > 0 ? `${((p.value / sum) * 100).toFixed(p.value / sum >= 0.1 ? 2 : 3)}%` : '—'}
            </b>
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── 横向条形（同一单位的几个量对比） ───────────────────────────────

export function BarList({ rows, color }: { rows: { key: string; name: ReactNode; value: number; text: ReactNode }[]; color: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1e-12);
  return (
    <div className="barlist">
      {rows.map((r) => (
        <div key={r.key} className="barlist__row">
          <div className="barlist__name">{r.name}</div>
          <div className="barlist__val">{r.text}</div>
          <div className="barlist__track">
            <div className="barlist__bar" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── 公司资产走势：公司钱包 SOL 合计（阶梯面积图 + 十字线提示） ─────────

const TZ = -new Date().getTimezoneOffset() * 60;

export function AssetHistoryChart(props: { points: TreasuryHistoryPoint[]; cur: Cur; usdCny: number; range: '24h' | '7d' | 'all' }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; p: TreasuryHistoryPoint; v: number } | null>(null);
  const curRef = useRef(props.cur);
  curRef.current = props.cur;
  const fitted = useRef('');

  // 当时的 SOL 数量 × 当时的 SOL 价格（人民币按当前汇率换算）
  const valueOf = (p: TreasuryHistoryPoint) =>
    props.cur === 'sol' ? p.sol : props.cur === 'usd' ? p.sol * p.solUsd : p.sol * p.solUsd * props.usdCny;

  const data = useMemo(() => {
    const now = Date.now() / 1000;
    const from = props.range === '24h' ? now - 86400 : props.range === '7d' ? now - 7 * 86400 : 0;
    const inRange = props.points.filter((p) => p.t >= from);
    // 区间起点补一个点，保证阶梯线从区间左侧开始
    const before = [...props.points].reverse().find((p) => p.t < from);
    const list = before && from > 0 ? [{ ...before, t: Math.floor(from) }, ...inRange] : inRange;
    // 图表要求时间严格递增：同一秒只保留最后的状态
    const out: TreasuryHistoryPoint[] = [];
    for (const p of list) {
      if (out.length && p.t <= out[out.length - 1].t) out[out.length - 1] = { ...p, t: out[out.length - 1].t };
      else out.push(p);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.points, props.range]);

  useEffect(() => {
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
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.05 } },
      timeScale: { borderColor: '#1d3a66', timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: 'rgba(34,211,238,0.5)', width: 1, style: LineStyle.Solid, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: (v: number) => (curRef.current === 'sol' ? fmtNum(v, 2) : fmtCompact(v)),
        timeFormatter: (t: Time) => fmtDate(((t as number) - TZ) * 1000),
      },
      handleScroll: { vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#22d3ee',
      lineWidth: 2,
      lineType: LineType.WithSteps,
      topColor: 'rgba(34,211,238,0.10)',
      bottomColor: 'rgba(34,211,238,0.00)',
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#071a36',
      crosshairMarkerBorderWidth: 2,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    series.setData(data.map((p) => ({ time: (p.t + TZ) as UTCTimestamp, value: valueOf(p) })));
    // 只在首次加载、切换范围或货币、出现新交易时重新铺满；SOL 价格跳动不打断用户缩放
    const fitKey = `${props.range}|${props.cur}|${data.length}`;
    if (fitted.current !== fitKey) {
      fitted.current = fitKey;
      chart.timeScale().fitContent();
    }
    const onMove = (param: any) => {
      if (!param.time || !param.point) return setTip(null);
      const t = (param.time as number) - TZ;
      const p = data.find((x) => x.t === t);
      if (!p) return setTip(null);
      setTip({ x: param.point.x, y: param.point.y, p, v: valueOf(p) });
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, props.cur, props.usdCny]);

  const boxW = boxRef.current?.clientWidth ?? 300;
  return (
    <div className="chart-box">
      <div ref={boxRef} style={{ position: 'absolute', inset: 0 }} />
      {tip && (
        <div className="tooltip" style={{ left: Math.min(Math.max(tip.x - 80, 4), boxW - 170), top: 6 }}>
          <div className="tooltip__v">{fmtMoney(tip.v, props.cur)}</div>
          <div className="tooltip__k">{fmtDate(tip.p.t * 1000)}</div>
          {props.cur !== 'sol' && <div className="tooltip__k">钱包 {fmtNum(tip.p.sol, 4)} SOL</div>}
        </div>
      )}
      {!data.length && <div className="kline__empty">暂无数据</div>}
    </div>
  );
}
