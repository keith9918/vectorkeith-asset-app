import { quoteSell, type SellQuote } from './curve';
import type { CompanyWallet, MarketInfo, SolPrice } from './types';

/**
 * 公司资产估值。
 *
 * 公司总资产 = 公司在池子里的 SOL 权益：
 *   全部流通代币卖回池子能换出的 SOL × 公司持仓占流通代币的比例。
 *   内盘阶段"能换出的 SOL"恰好等于池内真实 SOL；毕业到 PumpSwap 后，
 *   池子里永远留着预留代币，能换出的 SOL 小于池内 SOL（差额是永久锁定的流动性）。
 * 公司持有几乎全部流通代币，"持仓 × 现价"的账面市值根本卖不出来，只作参考。
 */
export interface CompanyValuation {
  totalTokens: number;
  circulating: number; // 流通代币 = 总供应 − 池内代币
  externalTokens: number; // 外部钱包持有的流通代币
  share: number; // 公司占流通代币比例 0..1
  pctSupply: number; // 公司占总供应 0..1
  priceSol: number;
  poolSol: number; // 池内真实 SOL
  poolPayoutSol: number; // 全部流通代币可从池子换出的 SOL
  equityPerToken: number; // 每枚流通代币对应的池内 SOL
  /** 公司总资产（池内 SOL 权益） */
  equitySol: number;
  equityUsd: number;
  equityCny: number;
  /** 账面市值：持仓 × 现价（仅供参考） */
  markSol: number;
  /** 此刻把公司全部持仓一次性卖回池子，扣除滑点与手续费后实际到手 */
  liquidation: SellQuote & { netUsd: number; netCny: number };
  dividend: {
    ratio: number;
    tokens: number;
    valueSol: number;
    valueUsd: number;
    valueCny: number;
  };
  walletSolTotal: number;
}

export function valueCompany(
  wallets: CompanyWallet[],
  market: MarketInfo,
  solPrice: SolPrice,
  supply: number,
  dividendRatio: number,
  totalFeeBps: number,
): CompanyValuation {
  const totalTokens = wallets.reduce((s, w) => s + w.tokens, 0);
  const circulating = Math.max(0, supply - market.poolTokens);
  const share = circulating > 0 ? Math.min(1, totalTokens / circulating) : 0;
  const poolPayoutSol = quoteSell(market, circulating, 0).grossSol;
  const equityPerToken = circulating > 0 ? poolPayoutSol / circulating : 0;
  const equitySol = poolPayoutSol * share;
  const usd = solPrice.usd;
  const cny = solPrice.usd * solPrice.usdCny;
  const liq = quoteSell(market, totalTokens, totalFeeBps);
  const dividendSol = equitySol * dividendRatio;
  return {
    totalTokens,
    circulating,
    externalTokens: Math.max(0, circulating - totalTokens),
    share,
    pctSupply: supply > 0 ? totalTokens / supply : 0,
    priceSol: market.priceSol,
    poolSol: market.poolSol,
    poolPayoutSol,
    equityPerToken,
    equitySol,
    equityUsd: equitySol * usd,
    equityCny: equitySol * cny,
    markSol: totalTokens * market.priceSol,
    liquidation: { ...liq, netUsd: liq.netSol * usd, netCny: liq.netSol * cny },
    dividend: {
      ratio: dividendRatio,
      tokens: totalTokens * dividendRatio,
      valueSol: dividendSol,
      valueUsd: dividendSol * usd,
      valueCny: dividendSol * cny,
    },
    walletSolTotal: wallets.reduce((s, w) => s + (w.solBalance ?? 0), 0),
  };
}

/** 历史时点的公司资产（SOL）：当时全部流通代币可换出的 SOL × 公司占当时流通代币的比例 */
export function historyEquitySol(p: { tokens: number; payoutSol: number; circ: number }): number {
  return p.circ > 0 ? p.payoutSol * Math.min(1, p.tokens / p.circ) : 0;
}
