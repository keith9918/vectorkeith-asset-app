// ───────────────────────────────────────────────────────────────
//  VK 链（公司自己的单节点区块链，正式网；Solana Agave + Alpenglow 共识）—— 前后端共享类型
//  原生币 VK：交易手续费（gas）和账户租金都用 VK 支付；1 VK = 10^9 最小单位
// ───────────────────────────────────────────────────────────────

export const CHAIN_NAME = 'VK Chain';
export const VK_SYMBOL = 'VK';
export const VK_DECIMALS = 9;
export const LAMPORTS_PER_VK = 1_000_000_000;
/** 每个签名的基础 gas（链上固定：5000 最小单位 = 0.000005 VK；一半销毁、一半归出块节点） */
export const FEE_PER_SIG = 5000;
/** 对外公开的 RPC 路径（App 服务器代理到节点，外部钱包 / 命令行可以填这个地址） */
export const CHAIN_RPC_PATH = '/chain/rpc';

export const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export const vkFromLamports = (n: number | bigint) => Number(n) / LAMPORTS_PER_VK;

export interface ChainBlock {
  slot: number;
  height: number | null;
  /** 出块时间（unix 秒） */
  time: number | null;
  hash: string;
  /** 非投票交易数 */
  txs: number;
  /** 本块 gas 合计（最小单位） */
  fees: number;
}

export type ChainTxKind =
  | 'transfer'
  | 'faucet'
  | 'airdrop'
  | 'token-create'
  | 'token-mint'
  | 'token-transfer'
  | 'token-burn'
  | 'token-authority'
  | 'account'
  | 'program'
  | 'other';

export interface ChainTx {
  sig: string;
  slot: number;
  /** unix 秒 */
  time: number | null;
  ok: boolean;
  err?: string;
  /** gas（最小单位） */
  fee: number;
  /** 付 gas 的地址 */
  payer: string;
  kind: ChainTxKind;
  /** 中文摘要，例如"转账 12.5 VK" */
  title: string;
  /** 主要金额（列表上显示） */
  amount?: { value: number; symbol: string; mint?: string };
  from?: string;
  to?: string;
  mint?: string;
  memo?: string;
  /** 涉及的地址（不含程序和系统变量） */
  accounts: string[];
  /** VK 余额变化（最小单位，含 gas） */
  vk: { a: string; d: number }[];
  /** 代币余额变化（按持有人：o 持有人，m 代币，d 变化量，dec 小数位） */
  tok: { o: string; m: string; d: number; dec: number }[];
  /** 解析后的指令（p 程序，t 类型） */
  ix: { p: string; t: string; info?: Record<string, unknown> }[];
}

export interface ChainToken {
  mint: string;
  program: 'token' | 'token-2022';
  name: string;
  symbol: string;
  decimals: number;
  /** 当前总量（按小数位换算后的数量） */
  supply: number;
  uri?: string;
  /** 图标地址（App 服务器托管；没有时前端显示字母头像） */
  image?: string;
  description?: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  updateAuthority?: string | null;
  creator?: string;
  createdAt?: number;
  sig?: string;
  holders?: number;
  /** 公司资产凭证（总量随公司真实 SOL 自动增减，不可转让） */
  mirror?: boolean;
}

/** 公司资产凭证 cSOL：链上总量 vs 主网真实余额 */
export interface ChainMirror {
  mint: string;
  symbol: string;
  /** 链上凭证总量（SOL） */
  chainSol: number | null;
  /** 主网真实公司资产（SOL，钱包 + 计入资产的质押） */
  realSol: number | null;
  inSync: boolean;
  stakedSol: number;
  wallets: { address: string; label: string }[];
  lastSync?: number;
  lastSig?: string;
  syncs: number;
  error?: string;
  /** 稳定币凭证 cUSDT / cUSDC（公司持有过才有） */
  stables?: { symbol: string; unit: string; mint: string; chain: number | null; real: number | null; inSync: boolean; lastSig?: string; syncs: number; error?: string }[];
}

export interface ChainAllocation {
  key: 'treasury' | 'reserve' | 'faucet' | 'node' | 'system';
  label: string;
  address?: string;
  /** 创世分配（VK） */
  genesis: number;
  /** 当前余额（VK） */
  balance: number;
}

export interface ChainOverview {
  online: boolean;
  error?: string;
  name: string;
  genesisHash?: string;
  genesisAt?: number;
  version?: string;
  consensus: string;
  slot: number;
  height: number;
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  /** 最近平均出块间隔（毫秒） */
  slotMs: number;
  /** 最近 1 分钟的每秒交易数（不含投票） */
  tps: number;
  txTotal: number;
  tx24h: number;
  addresses: number;
  supply: { genesis: number; total: number; burned: number };
  /** 每个签名的 gas（VK） */
  feePerSig: number;
  gasTotal: number;
  blocks: ChainBlock[];
  txs: ChainTx[];
  tokens: ChainToken[];
  /** once：每个地址终身只能领一次（这时 cooldownH 不起作用） */
  faucet: { enabled: boolean; amount: number; cooldownH: number; once: boolean; balance: number };
  allocation: ChainAllocation[];
  rpcPath: string;
  mirror?: ChainMirror;
  serverTime: number;
}

export interface ChainTokenBalance {
  mint: string;
  account: string;
  amount: number;
  decimals: number;
  program: 'token' | 'token-2022';
  symbol?: string;
  name?: string;
  image?: string;
}

export interface ChainAddressView {
  address: string;
  label?: string;
  kind: 'wallet' | 'program' | 'token' | 'token-account' | 'sysvar' | 'new';
  vk: number;
  owner?: string;
  executable?: boolean;
  space?: number;
  tokens: ChainTokenBalance[];
  txs: ChainTx[];
  token?: ChainToken;
  tokenAccount?: { mint: string; owner: string; amount: number };
  /** 水龙头：这个地址下次可以领取的时间（unix 毫秒，0 = 现在就能领） */
  faucetNextAt?: number;
  /** 水龙头：这个地址领过（"只能领一次"模式下就不能再领） */
  faucetClaimed?: boolean;
  /** 公司资产凭证的储备核对（只有凭证资产页有） */
  mirror?: ChainMirror;
}

export interface ChainBlockView extends ChainBlock {
  parentSlot: number;
  previousBlockhash: string;
  txList: ChainTx[];
  /** 本块里的投票交易数（Alpenglow 共识下投票不上链，一般为 0） */
  votes: number;
}

export interface ChainTxView extends ChainTx {
  logs?: string[];
  computeUnits?: number;
  confirmations?: string;
}

export type ChainPrepareKind = 'transfer' | 'token-create' | 'token-transfer' | 'token-mint' | 'token-burn' | 'token-renounce';

export interface ChainPrepared {
  /** 未签名交易（base64），由 App 内钱包签名 */
  tx: string;
  summary: string;
  /** gas（VK） */
  fee: number;
  /** 新建账户需要的免租金押金（VK，账户关闭时可退回） */
  rent: number;
  mint?: string;
  warnings?: string[];
}

export interface ChainSendResult {
  sig: string;
  ok: boolean;
  err?: string;
  slot?: number;
}

export interface ChainFaucetResult {
  sig: string;
  amount: number;
  nextAt: number;
}

export interface ChainAdminView {
  node: {
    active: boolean;
    memMB?: number;
    cpuPct?: number;
    uptimeSec?: number;
    diskFreeGB?: number;
    diskTotalGB?: number;
    identity?: string;
    version?: string;
    rpc: string;
  };
  keys: { key: 'treasury' | 'faucet' | 'reserve'; label: string; address: string; vk: number; loaded: boolean }[];
  faucet: { enabled: boolean; amount: number; cooldownH: number; perIpPerDay: number; once: boolean; claimedAddresses: number; claimsToday: number; claimsTotal: number; givenTotal: number };
  index: { lastSlot: number; behind: number; txs: number; tokens: number };
  recentClaims: { address: string; amount: number; at: number; sig: string }[];
}
