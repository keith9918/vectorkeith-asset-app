// ───────────────────────────────────────────────────────────────
//  VectorKeith 资产 App —— 链上常量
//  所有数字均已在 Solana 主网上核实
// ───────────────────────────────────────────────────────────────

export const COMPANY_NAME = 'VectorKeith';

/** App 跟踪的 pump.fun 代币：在 .env 里设置 TOKEN_MINT（这里不内置任何地址） */
export const DEFAULT_TOKEN_MINT = '';
/** 可选：以前跟踪过的旧代币（资金流水里显示成 USVK）；默认不设置 */
export const USVK_MINT = '';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** PumpSwap（pump.fun 毕业后的 AMM） */
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** pump.fun Global 账户参数（链上读取核实） */
export const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000;
export const INITIAL_VIRTUAL_SOL_RESERVES = 30;
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000;

/** 默认手续费（会被链上最新成交事件里的真实费率覆盖） */
export const DEFAULT_PROTOCOL_FEE_BPS = 95;
export const DEFAULT_CREATOR_FEE_BPS = 30;

/** 股东分红 = 公司总资产 × 10% */
export const DEFAULT_DIVIDEND_RATIO = 0.1;

/** 0 字节系统账户的免租金最低余额（lamports） */
export const RENT_EXEMPT_ZERO_BYTES = 890_880;

export interface CompanyWalletConfig {
  address: string;
  label: string;
}

/** 持仓前 N 名（不含池子）里出现不在公司名单里的地址时，资产页提示"是不是公司新钱包" */
export const WATCH_TOP_HOLDERS = 8;

/**
 * 首次跟踪某个代币时的默认公司钱包（之后由管理员在「设置」里维护，保存在服务器 data/<mint>/config.json）。
 * 新代币默认没有公司钱包，由管理员自己添加。
 */
export const DEFAULT_COMPANY_WALLETS_BY_MINT: Record<string, CompanyWalletConfig[]> = {};

/** 常见的流动性质押代币（LST）：持有它们等于在质押 SOL */
export const LST_MINTS: Record<string, string> = {
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JitoSOL',
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 'bSOL',
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: 'JupSOL',
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm': 'INF',
  he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A: 'hSOL',
  Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ: 'dSOL',
};
