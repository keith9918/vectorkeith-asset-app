import type { Trade } from './types';

/** 计价：SOL 本位 / 美元 / 人民币 */
export type Quote = 'sol' | 'usd' | 'cny';

/** 换算参数：fallbackSolUsd 用于没有历史价的成交；usdCny 为当前美元兑人民币汇率 */
export interface Fx {
  solUsd: number;
  usdCny: number;
}

export interface Candle {
  time: number; // 桶起点（unix 秒）
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // SOL
  volumeUsd: number;
  buyVolume: number; // SOL
  sellVolume: number; // SOL
  count: number;
}

/** K 线周期（秒） */
export const TIMEFRAMES = [
  { key: '1s', sec: 1 },
  { key: '5s', sec: 5 },
  { key: '15s', sec: 15 },
  { key: '30s', sec: 30 },
  { key: '1m', sec: 60 },
  { key: '5m', sec: 300 },
  { key: '15m', sec: 900 },
  { key: '1h', sec: 3600 },
  { key: '4h', sec: 14400 },
  { key: '1D', sec: 86400 },
] as const;

export function solUsdOf(t: Trade, fallback: number): number {
  return t.solUsd > 0 ? t.solUsd : fallback;
}

/** 1 SOL 在该笔成交时折合多少计价货币 */
export function quoteFactor(t: Trade, quote: Quote, fx: Fx): number {
  if (quote === 'sol') return 1;
  const usd = solUsdOf(t, fx.solUsd);
  return quote === 'usd' ? usd : usd * fx.usdCny;
}

export function tradePrice(t: Trade, quote: Quote, fx: Fx, pre = false): number {
  return (pre ? t.prePriceSol : t.priceSol) * quoteFactor(t, quote, fx);
}

export const bucketOf = (ts: number, tf: number) => Math.floor(ts / tf) * tf;

/**
 * 把一笔成交并入 K 线数组（原地修改）。
 * 开盘价取「该桶第一笔成交的成交前价格」——bonding curve 上价格只会被成交推动，
 * 所以这与上一根收盘价一致，且即使漏掉中间成交也不会失真。
 * 返回 null 表示成交时间早于最后一根 K 线（乱序），调用方应整体重建。
 */
export function applyTrade(candles: Candle[], t: Trade, tf: number, quote: Quote, fx: Fx): Candle | null {
  const time = bucketOf(t.ts, tf);
  const close = tradePrice(t, quote, fx);
  const usd = t.sol * solUsdOf(t, fx.solUsd);
  const last = candles[candles.length - 1];
  if (last && time < last.time) return null;
  if (last && last.time === time) {
    if (close > last.high) last.high = close;
    if (close < last.low) last.low = close;
    last.close = close;
    last.volume += t.sol;
    last.volumeUsd += usd;
    if (t.isBuy) last.buyVolume += t.sol;
    else last.sellVolume += t.sol;
    last.count += 1;
    return last;
  }
  const open = tradePrice(t, quote, fx, true);
  const c: Candle = {
    time,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: t.sol,
    volumeUsd: usd,
    buyVolume: t.isBuy ? t.sol : 0,
    sellVolume: t.isBuy ? 0 : t.sol,
    count: 1,
  };
  candles.push(c);
  return c;
}

export function buildCandles(trades: Trade[], tf: number, quote: Quote, fx: Fx): Candle[] {
  const out: Candle[] = [];
  for (const t of trades) applyTrade(out, t, tf, quote, fx);
  return out;
}

/** 成交排序：slot → 区块内序号 → 收到时间 → id */
export function compareTrades(a: Trade, b: Trade): number {
  if (a.slot !== b.slot) return a.slot - b.slot;
  const ai = a.txIndex < 0 ? Number.MAX_SAFE_INTEGER : a.txIndex;
  const bi = b.txIndex < 0 ? Number.MAX_SAFE_INTEGER : b.txIndex;
  if (ai !== bi) return ai - bi;
  const ar = a.recvMs ?? 0;
  const br = b.recvMs ?? 0;
  if (ar !== br) return ar - br;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
