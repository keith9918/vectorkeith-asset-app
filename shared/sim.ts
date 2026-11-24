// ───────────────────────────────────────────────────────────────
//  USVK 模拟盘 —— 盘口数学（服务器成交、App 即时报价共用同一套）
//  规则照 pump.fun：内盘 bonding curve（虚拟储备的恒定乘积）→ 可卖代币买满即"毕业"
//  → 内盘里的 SOL 和预留代币全部迁移到 PumpSwap 池子（恒定乘积，没有虚拟储备）
//  pump.fun 原版总量 10 亿；这里总量 20 亿，虚拟代币储备和可卖数量按比例放大，
//  虚拟 SOL 储备不变 → 开盘市值、毕业所需 SOL 和 pump.fun 完全一样
// ───────────────────────────────────────────────────────────────
import { INITIAL_REAL_TOKEN_RESERVES, INITIAL_VIRTUAL_SOL_RESERVES, INITIAL_VIRTUAL_TOKEN_RESERVES } from './constants';
import type { SimParams, SimPool } from './types';

export const SIM_SUPPLY = 2_000_000_000;
const EPS = 1e-12;

export function defaultSimParams(): SimParams {
  const k = SIM_SUPPLY / 1_000_000_000;
  return {
    name: 'USVK',
    symbol: 'USVK',
    supply: SIM_SUPPLY,
    decimals: 6,
    initVirtualSol: INITIAL_VIRTUAL_SOL_RESERVES,
    initVirtualTokens: INITIAL_VIRTUAL_TOKEN_RESERVES * k,
    initRealTokens: INITIAL_REAL_TOKEN_RESERVES * k,
    // 内盘 1.25%（协议 0.95% + 创作者 0.30%）；外盘 0.30%（LP 0.20% + 协议 0.05% + 创作者 0.05%）
    curveProtocolBps: 95,
    curveCreatorBps: 30,
    ammLpBps: 20,
    ammProtocolBps: 5,
    ammCreatorBps: 5,
  };
}

export function initialPool(p: SimParams): SimPool {
  return { phase: 'curve', vSol: p.initVirtualSol, vTok: p.initVirtualTokens, rSol: 0, rTok: p.initRealTokens, poolSol: 0, poolTok: 0 };
}

export const curveFeeRate = (p: SimParams) => (p.curveProtocolBps + p.curveCreatorBps) / 10_000;
export const ammFeeRate = (p: SimParams) => (p.ammLpBps + p.ammProtocolBps + p.ammCreatorBps) / 10_000;

/** 现价（SOL / 枚） */
export function simPrice(s: SimPool): number {
  if (s.phase === 'curve') return s.vTok > 0 ? s.vSol / s.vTok : 0;
  return s.poolTok > 0 ? s.poolSol / s.poolTok : 0;
}

/** 全流通市值 FDV（SOL）= 现价 × 总量（pump.fun 显示的口径，开盘就有约 28 SOL，因为算上了虚拟储备） */
export const simMcap = (p: SimParams, s: SimPool) => simPrice(s) * p.supply;

/** 流通市值（SOL）= 现价 × 大家手里的代币。开盘没人买时是 0，App 里的"市值"用这个 */
export const simCircMcap = (p: SimParams, s: SimPool) => simPrice(s) * simCirculating(p, s);

/** 池子里真实的 SOL（卖出时能拿走的上限） */
export const simLiquidity = (s: SimPool) => (s.phase === 'curve' ? s.rSol : s.poolSol);

/** 池子里的代币（内盘阶段 = 还能卖的 + 预留给外盘的） */
export const simPoolTokens = (p: SimParams, s: SimPool) => (s.phase === 'curve' ? s.rTok + (p.supply - p.initRealTokens) : s.poolTok);

/** 已经从池子里买走、在大家手里的代币 */
export const simCirculating = (p: SimParams, s: SimPool) => Math.max(0, p.supply - simPoolTokens(p, s));

/** 毕业进度 0–1：内盘可卖代币卖出了多少 */
export const simProgress = (p: SimParams, s: SimPool) => (s.phase === 'amm' ? 1 : Math.max(0, Math.min(1, 1 - s.rTok / p.initRealTokens)));

/** 买满内盘还要进池子的 SOL（不含手续费） */
export function simSolToGraduate(s: SimPool): number {
  if (s.phase === 'amm') return 0;
  const k = s.vSol * s.vTok;
  return Math.max(0, k / (s.vTok - s.rTok) - s.vSol);
}

/** 买满内盘还要花的 SOL（含手续费） */
export const simCostToGraduate = (p: SimParams, s: SimPool) => simSolToGraduate(s) * (1 + curveFeeRate(p));

/** 内盘买满：SOL 和预留代币全部迁移到外盘池子，价格连续 */
export function migrate(p: SimParams, s: SimPool): SimPool {
  return { ...s, phase: 'amm', poolSol: s.rSol, poolTok: s.rTok + (p.supply - p.initRealTokens), rSol: 0, rTok: 0 };
}

export interface SimQuote {
  side: 'buy' | 'sell';
  /** 买入：实际花掉的 SOL（含手续费）；卖出：到手的 SOL（已扣手续费） */
  sol: number;
  /** 买入：得到的代币；卖出：卖掉的代币 */
  tokens: number;
  fee: number;
  protocolFee: number;
  creatorFee: number;
  lpFee: number;
  priceBefore: number;
  priceAfter: number;
  /** 平均成交价（SOL / 枚，含手续费） */
  avgPrice: number;
  /** 价格变化：priceAfter / priceBefore − 1 */
  impact: number;
  venue: 'curve' | 'amm' | 'both';
  graduated: boolean;
  after: SimPool;
}

function finish(q: Omit<SimQuote, 'avgPrice' | 'impact' | 'priceAfter'>): SimQuote {
  const priceAfter = simPrice(q.after);
  return {
    ...q,
    priceAfter,
    avgPrice: q.tokens > 0 ? q.sol / q.tokens : 0,
    impact: q.priceBefore > 0 ? priceAfter / q.priceBefore - 1 : 0,
  };
}

/**
 * 花 spend SOL（含手续费）买入。内盘阶段按虚拟储备算；
 * 一笔买满内盘时：只按剩余可卖代币成交 → 迁移到外盘 → 剩下的 SOL 接着在外盘买。
 */
export function quoteBuy(p: SimParams, s: SimPool, spend: number): SimQuote {
  const priceBefore = simPrice(s);
  let st: SimPool = { ...s };
  let left = Number.isFinite(spend) && spend > 0 ? spend : 0;
  let tokens = 0;
  let protocolFee = 0;
  let creatorFee = 0;
  let lpFee = 0;
  let usedCurve = false;
  let usedAmm = false;
  let graduated = false;

  if (st.phase === 'curve' && left > EPS) {
    usedCurve = true;
    const k = st.vSol * st.vTok;
    let solIn = left / (1 + curveFeeRate(p));
    let out = st.vTok - k / (st.vSol + solIn);
    const fills = out >= st.rTok;
    if (fills) {
      out = st.rTok;
      solIn = k / (st.vTok - st.rTok) - st.vSol;
    }
    const pf = (solIn * p.curveProtocolBps) / 10_000;
    const cf = (solIn * p.curveCreatorBps) / 10_000;
    st = { ...st, vSol: st.vSol + solIn, vTok: st.vTok - out, rSol: st.rSol + solIn, rTok: fills ? 0 : st.rTok - out };
    tokens += out;
    protocolFee += pf;
    creatorFee += cf;
    left = fills ? Math.max(0, left - solIn - pf - cf) : 0;
    if (fills) {
      st = migrate(p, st);
      graduated = true;
    }
  }

  if (st.phase === 'amm' && left > EPS && st.poolSol > 0 && st.poolTok > 0) {
    usedAmm = true;
    const raw = left / (1 + ammFeeRate(p));
    const out = st.poolTok - (st.poolSol * st.poolTok) / (st.poolSol + raw);
    const lf = (raw * p.ammLpBps) / 10_000;
    const pf = (raw * p.ammProtocolBps) / 10_000;
    const cf = (raw * p.ammCreatorBps) / 10_000;
    st = { ...st, poolSol: st.poolSol + raw + lf, poolTok: st.poolTok - out };
    tokens += out;
    lpFee += lf;
    protocolFee += pf;
    creatorFee += cf;
    left = 0;
  }

  const spent = Math.max(0, (Number.isFinite(spend) ? spend : 0) - left);
  return finish({
    side: 'buy',
    sol: spent,
    tokens,
    fee: protocolFee + creatorFee + lpFee,
    protocolFee,
    creatorFee,
    lpFee,
    priceBefore,
    venue: usedCurve && usedAmm ? 'both' : usedAmm ? 'amm' : 'curve',
    graduated,
    after: st,
  });
}

/** 卖出 tokens 枚。内盘阶段以内盘里真实的 SOL 封顶。 */
export function quoteSell(p: SimParams, s: SimPool, tokens: number): SimQuote {
  const priceBefore = simPrice(s);
  const t = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  let st: SimPool = { ...s };
  let gross = 0;
  let protocolFee = 0;
  let creatorFee = 0;
  let lpFee = 0;
  if (t > 0 && st.phase === 'curve') {
    gross = Math.min(st.rSol, (st.vSol * t) / (st.vTok + t));
    protocolFee = (gross * p.curveProtocolBps) / 10_000;
    creatorFee = (gross * p.curveCreatorBps) / 10_000;
    st = { ...st, vSol: st.vSol - gross, vTok: st.vTok + t, rSol: st.rSol - gross, rTok: st.rTok + t };
  } else if (t > 0 && st.poolSol > 0) {
    gross = (st.poolSol * t) / (st.poolTok + t);
    lpFee = (gross * p.ammLpBps) / 10_000;
    protocolFee = (gross * p.ammProtocolBps) / 10_000;
    creatorFee = (gross * p.ammCreatorBps) / 10_000;
    st = { ...st, poolSol: st.poolSol - gross + lpFee, poolTok: st.poolTok + t };
  }
  const fee = protocolFee + creatorFee + lpFee;
  return finish({
    side: 'sell',
    sol: Math.max(0, gross - fee),
    tokens: t,
    fee,
    protocolFee,
    creatorFee,
    lpFee,
    priceBefore,
    venue: s.phase,
    graduated: false,
    after: st,
  });
}

/** 从现在的盘口再买 0…maxSpend SOL，流通市值怎么涨（拉盘预演曲线） */
export function projectBuys(p: SimParams, s: SimPool, maxSpend: number, n = 60): { spend: number; mcap: number; fdv: number; graduated: boolean }[] {
  const out: { spend: number; mcap: number; fdv: number; graduated: boolean }[] = [];
  const max = Math.max(0, maxSpend);
  for (let i = 0; i <= n; i++) {
    const spend = (max * i) / n;
    const q = quoteBuy(p, s, spend);
    out.push({ spend, mcap: simCircMcap(p, q.after), fdv: simMcap(p, q.after), graduated: q.after.phase === 'amm' });
  }
  return out;
}
