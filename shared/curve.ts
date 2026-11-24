import { INITIAL_REAL_TOKEN_RESERVES } from './constants';
import type { CurveState, MarketInfo } from './types';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 现价（SOL / 枚）= 虚拟 SOL 储备 / 虚拟代币储备 */
export function curveSpotPrice(c: Pick<CurveState, 'virtualSolReserves' | 'virtualTokenReserves'>): number {
  return c.virtualTokenReserves > 0 ? c.virtualSolReserves / c.virtualTokenReserves : 0;
}

/** 毕业进度：已卖出的可售代币 / 初始可售代币（与 pump.fun 前端口径一致） */
export function curveProgress(c: CurveState): number {
  if (c.complete) return 1;
  return clamp01((INITIAL_REAL_TOKEN_RESERVES - c.realTokenReserves) / INITIAL_REAL_TOKEN_RESERVES);
}

/** 买空剩余可售代币（触发毕业）还需要投入的 SOL（不含手续费） */
export function curveSolToGraduate(c: CurveState): number {
  if (c.complete) return 0;
  const remaining = c.virtualTokenReserves - c.realTokenReserves;
  if (remaining <= 0) return 0;
  return (c.virtualSolReserves * c.virtualTokenReserves) / remaining - c.virtualSolReserves;
}

/** bonding curve 代币账户里实际躺着的代币 = 可售余量 + 预留给迁移的部分 */
export function curvePoolTokens(c: CurveState): number {
  return c.realTokenReserves + Math.max(0, c.tokenTotalSupply - INITIAL_REAL_TOKEN_RESERVES);
}

/** PumpSwap 池子：价格 = 池内 SOL / 池内代币（恒定乘积，没有虚拟储备） */
export function marketFromPool(p: { address: string; baseReserve: number; quoteReserve: number; lpSupply: number }): MarketInfo {
  return {
    mode: 'amm',
    dex: 'PumpSwap',
    poolAddress: p.address,
    priceSol: p.baseReserve > 0 ? p.quoteReserve / p.baseReserve : 0,
    poolSol: p.quoteReserve,
    poolTokens: p.baseReserve,
    reserveSol: p.quoteReserve,
    reserveTokens: p.baseReserve,
    progress: 1,
    solToGraduate: 0,
    lpSupply: p.lpSupply,
  };
}

export function marketFromCurve(c: CurveState): MarketInfo {
  return {
    mode: 'curve',
    dex: 'pump.fun 内盘',
    poolAddress: c.address,
    priceSol: curveSpotPrice(c),
    poolSol: c.realSolReserves,
    poolTokens: curvePoolTokens(c),
    reserveSol: c.virtualSolReserves,
    reserveTokens: c.virtualTokenReserves,
    progress: curveProgress(c),
    solToGraduate: curveSolToGraduate(c),
  };
}

export interface SellQuote {
  grossSol: number; // 池子付出的 SOL
  netSol: number; // 扣除手续费后到手
  feeSol: number;
  priceAfter: number;
  impact: number; // 价格冲击（负数）
  capped: boolean; // 是否触及池内真实 SOL 上限
}

/**
 * 恒定乘积卖出报价：把 tokens 一次性卖进池子能换回多少 SOL。
 * bonding curve 用虚拟储备计算，再以池内真实 SOL 封顶。
 */
export function quoteSell(
  m: Pick<MarketInfo, 'reserveSol' | 'reserveTokens' | 'poolSol'>,
  tokens: number,
  totalFeeBps: number,
): SellQuote {
  if (!(tokens > 0) || !(m.reserveTokens > 0) || !(m.reserveSol > 0)) {
    return { grossSol: 0, netSol: 0, feeSol: 0, priceAfter: 0, impact: 0, capped: false };
  }
  let gross = (m.reserveSol * tokens) / (m.reserveTokens + tokens);
  let capped = false;
  if (gross > m.poolSol) {
    gross = m.poolSol;
    capped = true;
  }
  const fee = (gross * totalFeeBps) / 10_000;
  const spot = m.reserveSol / m.reserveTokens;
  const after = (m.reserveSol - gross) / (m.reserveTokens + tokens);
  return {
    grossSol: gross,
    netSol: gross - fee,
    feeSol: fee,
    priceAfter: after,
    impact: spot > 0 ? after / spot - 1 : 0,
    capped,
  };
}

/** 由成交后储备反推成交前储备 → 成交前现价 */
export function prePriceFromPost(isBuy: boolean, vSol: number, vTok: number, sol: number, tokens: number): number {
  const preSol = isBuy ? vSol - sol : vSol + sol;
  const preTok = isBuy ? vTok + tokens : vTok - tokens;
  return preTok > 0 && preSol > 0 ? preSol / preTok : vSol / vTok;
}
