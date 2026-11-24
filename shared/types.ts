import type { CompanyWalletConfig } from './constants';

/** pump.fun bonding curve 状态（数量均已换算为 UI 单位：代币 / SOL） */
export interface CurveState {
  address: string;
  virtualTokenReserves: number;
  virtualSolReserves: number;
  realTokenReserves: number;
  realSolReserves: number;
  tokenTotalSupply: number;
  complete: boolean;
  creator: string;
  slot: number;
  updatedAt: number;
}

/** 一笔链上成交（来自 pump.fun TradeEvent） */
export interface Trade {
  id: string; // `${sig}:${eventIndex}`
  sig: string;
  slot: number;
  txIndex: number; // 区块内交易序号，-1 = 未知
  ts: number; // 链上时间（unix 秒，来自事件）
  chainMs?: number; // 实时成交：所在 slot 的出块时刻估算（毫秒）
  recvMs?: number; // 实时成交：服务器收到的时刻（毫秒）
  isBuy: boolean;
  sol: number; // 进/出池子的 SOL（不含手续费）
  tokens: number;
  user: string;
  priceSol: number; // 成交后现价（SOL/枚）
  prePriceSol: number; // 成交前现价
  vSol: number;
  vTok: number;
  rSol: number;
  rTok: number;
  fee: number; // 协议手续费（SOL）
  creatorFee: number; // 创作者手续费（SOL）
  feeBps: number;
  creatorFeeBps: number;
  solUsd: number; // 成交时 SOL/USD（0 = 未知）
  status: 'processed' | 'confirmed';
  /** 成交场所：pump.fun 内盘 / PumpSwap 池子（旧数据没有此字段，视为 curve） */
  venue?: 'curve' | 'amm';
}

export interface SolPrice {
  usd: number;
  usdCny: number; // 1 USD = ? CNY
  source: string;
  updatedAt: number;
}

export type HolderTag = 'curve' | 'company' | 'external';

export interface Holder {
  owner: string;
  amount: number;
  pct: number; // 占总供应 %
  tag: HolderTag;
  label?: string;
  isCreator?: boolean;
  tokenAccounts: string[];
}

export interface CompanyWallet extends CompanyWalletConfig {
  tokens: number;
  solBalance: number | null;
  rank: number | null; // 全网持仓排名（含池子）
  tokenAccount: string; // ATA
  isCreator: boolean;
  lastChangeMs: number;
  lastDelta: number;
}

export interface WindowStats {
  window: '5m' | '1h' | '6h' | '24h';
  priceChange: number; // 比例，0.1 = +10%
  volumeSol: number;
  volumeUsd: number;
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
  traders: number;
  companyNetSol: number; // 公司钱包净买入 SOL
}

export interface MarketStats {
  windows: WindowStats[];
  athPriceSol: number;
  athPriceUsd: number;
  athTs: number;
  atlPriceSol: number;
  totalTrades: number;
  totalVolumeSol: number;
  totalCreatorFeeSol: number;
  firstTradeTs: number;
}

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  image: string; // 本地缓存路径
  imageRemote: string;
  decimals: number;
  supply: number;
  tokenProgram: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  updateAuthority: string | null;
  metadataUri: string;
  createdAt: number; // unix 秒
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface MarketInfo {
  mode: 'curve' | 'amm';
  dex: string;
  poolAddress: string;
  priceSol: number;
  poolSol: number; // 池内真实 SOL
  poolTokens: number;
  /** 计算滑点用的储备（curve 模式为虚拟储备） */
  reserveSol: number;
  reserveTokens: number;
  progress: number; // 0..1 毕业进度
  solToGraduate: number;
  /** PumpSwap 池子的 LP 流通量；0 = 已全部销毁（流动性永久锁定） */
  lpSupply?: number;
}

export interface CreatorVault {
  address: string;
  claimableSol: number;
  totalEarnedSol: number;
}

export interface EngineStatus {
  startedAt: number;
  rpcHttp: string;
  rpcWs: string;
  wsConnected: boolean;
  slot: number;
  slotMs: number;
  backfillDone: boolean;
  backfillTrades: number;
  backfillTotal: number; // 本轮需要从链上解析的交易数
  backfillFetched: number;
  lastTradeMs: number;
  lastHoldersMs: number;
  errors: string[];
}

export interface AppConfig {
  companyWallets: CompanyWalletConfig[];
  dividendRatio: number;
  /** 管理员标记为"不是公司钱包"的地址：不再出现在候选列表和资产页提醒里 */
  ignoredWallets: string[];
  adminEnabled: boolean;
}

// ─── 公司金库：公司钱包里的 SOL 就是公司资产 ─────────────────────

export interface TreasuryWallet {
  address: string;
  label: string;
  sol: number; // 原生 SOL 余额（NaN = 还没读到）
  slot: number;
  updatedAt: number;
  lastDelta: number; // 最近一次余额变化（SOL）
  lastChangeMs: number;
}

/** stake = 把钱包里的 SOL 质押出去（原生质押或换成 JitoSOL 等）；unstake = 取回 */
export type ActivityKind = 'in' | 'out' | 'buy' | 'sell' | 'fee' | 'other' | 'stake' | 'unstake' | 'stableIn' | 'stableOut';

export interface TreasuryActivity {
  id: string; // `${sig}:${wallet}`
  sig: string;
  slot: number;
  ts: number; // unix 秒
  wallet: string;
  deltaSol: number; // 这个钱包的 SOL 变化（已含手续费）
  fee: number; // 这个钱包付的网络费（SOL）
  kind: ActivityKind;
  counterparty?: string; // 转入 / 转出的对方地址
  dust?: boolean; // 金额极小（< 0.001 SOL）的转账
  note?: string; // 补充说明（例如关闭代币账户收回租金）
  /** 疑似地址投毒：对方地址开头结尾都和这个已知地址很像，却不是它 */
  poisonOf?: string;
  tokens: { mint: string; delta: number; symbol?: string }[]; // 同一笔交易里这个钱包的代币变化
  /** 这笔交易里从这个钱包转出的每一笔 SOL（用来识别发给股东的分红；一笔交易可以同时转给多人） */
  outs?: { to: string; sol: number }[];
  failed?: boolean;
  /** 稳定币转入 / 转出（kind = stableIn / stableOut 时）：币种和数量（正数） */
  stable?: { symbol: 'USDT' | 'USDC'; amount: number };
  balanceAfter: number; // 交易后这个钱包的 SOL 余额
  solUsd: number; // 交易时 SOL/USD
}

export interface TreasurySnapshot {
  wallets: TreasuryWallet[];
  totalSol: number; // 公司总资产（SOL）= 钱包里的 SOL + stakedSol
  stakedSol: number; // 质押中的 SOL（含已到账的质押收益；管理员关闭"计入总资产"时为 0）
  dividendRatio: number;
  /** 最近的资金流水（新 → 旧） */
  activity: TreasuryActivity[];
  activityCount: number;
  /** 24 小时前的总 SOL（历史还没同步到那么早时为 null） */
  totalSol24hAgo: number | null;
  solUsd24hAgo: number | null;
  status: { backfillDone: boolean; fetched: number; total: number };
  /** 公司钱包里的稳定币（Solana 主网官方 USDT / USDC，1 枚 = 1 美元）：计入公司总资产的显示，不计入分红 */
  stables?: {
    ready: boolean;
    usdt: number;
    usdc: number;
    usd: number;
    wallets: { address: string; usdt: number; usdc: number }[];
    fakes: { mint: string; symbol: string; amount: number }[];
  };
}

export interface TreasuryHistoryPoint {
  t: number; // unix 秒
  sol: number; // 当时所有公司钱包的 SOL 合计
  solUsd: number;
  d?: number; // 这一点上的 SOL 变化（同一秒多笔交易合并）
  k?: ActivityKind; // 这一点上（金额最大的）交易类型
  n?: number; // 这一点合并了几笔交易
}

export interface WalletPreview {
  address: string; // 规范化后的钱包地址（填的是代币账户时，换成它所属的钱包）
  note?: string;
  sol: number;
  txCount: number; // 最多统计 1000
  firstTs: number | null;
  lastTs: number | null;
  isSystemAccount: boolean;
}

export interface Snapshot {
  serverTime: number;
  treasury: TreasurySnapshot;
  goal?: GoalView | null; // 公司目标（管理员设置）
  mint: string; // App 正在跟踪的代币
  supply: number; // 代币实际总量（从链上读取）
  token: TokenInfo | null;
  curve: CurveState | null;
  market: MarketInfo | null;
  solPrice: SolPrice;
  fees: { protocolBps: number; creatorBps: number };
  stats: MarketStats;
  holders: Holder[];
  holderCount: number;
  company: CompanyWallet[];
  creatorVault: CreatorVault | null;
  config: AppConfig;
  trades: Trade[];
  status: EngineStatus;
}

export interface CompanyHistoryPoint {
  t: number; // unix 秒
  tokens: number; // 公司持仓
  priceSol: number;
  solUsd: number;
  payoutSol: number; // 当时全部流通代币卖回池子能换出的 SOL（内盘阶段 = 池内真实 SOL）
  circ: number; // 当时流通代币（已从池子卖出的数量）
}

/** 服务器 → App 推送消息 */
export type ServerMessage =
  | { t: 'snapshot'; data: Snapshot }
  | { t: 'trade'; trade: Trade; market: MarketInfo | null; curve: CurveState | null; stats: MarketStats }
  | { t: 'trade_update'; trade: Trade }
  | { t: 'trade_remove'; id: string }
  | { t: 'curve'; curve: CurveState; market: MarketInfo | null }
  | { t: 'holders'; holders: Holder[]; holderCount: number; company: CompanyWallet[]; creatorVault: CreatorVault | null; supply: number }
  | { t: 'sol'; solPrice: SolPrice }
  | { t: 'treasury'; treasury: TreasurySnapshot }
  | { t: 'stats'; stats: MarketStats }
  | { t: 'slot'; slot: number; ms: number }
  | { t: 'status'; status: EngineStatus }
  | { t: 'config'; config: AppConfig }
  | { t: 'token'; token: TokenInfo }
  | { t: 'pong'; id: number; serverTime: number }
  /** 股东名册或分红发放有变化：App 用自己的身份重新拉取 /api/shareholders（内容按身份不同，不能广播） */
  | { t: 'shareholders'; rev: number }
  /** 访问设置变了：App 重新检查自己是否还有权限 */
  | { t: 'access' }
  /** 公司目标变了（设置 / 清除 / 达成）；reached = 刚刚达成（放烟花） */
  | { t: 'goal'; goal: GoalView | null; reached?: boolean }
  /** 内部质押有变化：App 用自己的身份重新拉取 /api/internal */
  | { t: 'internal'; rev: number }
  /** 解锁了新成就：App 重新拉取成就墙（unlocked = 刚解锁的成就 key，用来播放解锁动画） */
  | { t: 'achievements'; rev: number; unlocked: string[] }
  /** USVK 模拟盘有新成交 / 账号变化：App 用自己的身份重新拉取 /api/sim */
  | { t: 'sim'; rev: number };

/** App → 服务器 */
export type ClientMessage = { t: 'ping'; id: number; clientTime: number };

// ─── 访问控制 ────────────────────────────────────────────────
/** public = 没登录；viewer = 用访问密码登录；holder = 用股东查看码登录；member = 用员工登录码登录（内部质押）；trader = 用模拟盘登录码登录（员工 / 客户）；admin = 管理员 */
export type Role = 'public' | 'viewer' | 'holder' | 'member' | 'trader' | 'admin';
export type AccessMode = 'public' | 'code';

export interface AccessInfo {
  mode: AccessMode; // public = 知道网址就能看；code = 需要输入访问码
  role: Role;
  name?: string; // 股东登录时：股东名字
  sid?: string;
  /** 模拟盘账号：员工 / 客户 */
  kind?: SimKind;
  needLogin: boolean;
}

/** 管理员看到的访问设置 */
export interface AccessSettings {
  mode: AccessMode;
  password: string; // 通用访问密码（空 = 没设置）
}

// ─── 股东与分红发放 ──────────────────────────────────────────
export interface Shareholder {
  id: string;
  name: string;
  pct: number; // 持股比例（%）：应得分红 = 分红池 × pct%
  wallets: string[]; // 收款钱包：公司钱包转到这些地址的 SOL 自动记为分红发放
  note?: string;
  code?: string; // 股东查看码（只有管理员能看到）
  createdAt: number;
}

export interface Payout {
  id: string; // 链上：`${sig}:${收款地址}`；手动：随机
  sid: string; // 股东 id
  ts: number; // unix 秒
  sol: number; // 折合 SOL
  usd: number; // 发放时的美元价值
  source: 'chain' | 'manual';
  sig?: string;
  wallet?: string; // 哪个公司钱包付的
  to?: string; // 收款地址
  amount?: number; // 手动记录：原始金额
  currency?: 'cny' | 'usd' | 'sol'; // 手动记录：原始币种
  note?: string;
  excluded?: boolean; // 管理员标记"不是分红"（链上记录）
}

export interface ShareholderView {
  role: Role;
  count: number; // 股东人数（public 时为 0）
  totalPct: number; // 已登记的持股比例合计
  paidSol: number; // 已发放分红合计（折合 SOL，不含"不是分红"的记录）
  paidUsd: number; // 按发放当时的价格合计
  holders: Shareholder[]; // 管理员：全部；股东：只有自己；其他：空
  payouts: Payout[]; // 新 → 旧
}

// ─── 手机推送提醒 ────────────────────────────────────────────
export interface PushPrefs {
  flow: boolean; // 转入、转出
  trade: boolean; // 买卖代币
  poison: boolean; // 地址投毒
  payout: boolean; // 分红发放
  badge: boolean; // 解锁成就
}

export interface PushSettings {
  minSol: number; // 单笔变动达到多少 SOL 才提醒
  lowSol: number; // 总资产低于多少 SOL 时提醒（0 = 不提醒）
  subscribers: number;
}

// ─── 成就墙 ──────────────────────────────────────────────────
export interface Achievement {
  id: string; // 成就系列
  icon: string; // emoji
  name: string;
  desc: string; // 怎么解锁
  level: number; // 已达到的等级（0 = 未解锁）
  maxLevel: number;
  levelLabel?: string; // 当前等级，例如 "50 SOL"
  nextLabel?: string; // 下一级，例如 "100 SOL"
  progress: number; // 到下一级的进度 0–1（满级为 1）
  progressText?: string; // 例如 "50.76 / 100 SOL"
  unlockedAt?: number; // 当前等级的解锁时间（unix 秒）
  detail?: string; // 纪录详情，例如 "+12.35 SOL · 01-01"
}

export interface AchievementsView {
  list: Achievement[];
  unlocked: number; // 已解锁的等级总数
  total: number; // 全部等级数
}

/** SOL 参考价位（价格模拟器用） */
export interface SolLevels {
  now: number;
  ath?: { usd: number; t: number }; // 历史最高（月 K 线最高价）
  yearHigh?: { usd: number; t: number }; // 今年最高
  yearLow?: { usd: number; t: number };
  avgIn?: number; // 公司钱包收到 SOL 时的加权平均价格
  firstIn?: { usd: number; t: number }; // 第一笔入账时的价格
}

// ─── SOL 价格图 ──────────────────────────────────────────────
export type SolRange = '24h' | '7d' | '30d' | '1y' | 'all';

export interface SolCandle {
  t: number; // 开盘时间（unix 秒）
  o: number;
  h: number;
  l: number;
  c: number; // 美元
}

export interface SolCandles {
  range: SolRange;
  sec: number; // 每根 K 线的秒数
  candles: SolCandle[];
  source: string;
}

// ─── 质押 ────────────────────────────────────────────────────
export type StakeStatus = 'activating' | 'active' | 'deactivating' | 'inactive';

export interface ValidatorInfo {
  vote: string; // 投票账户（质押时选的就是它）
  name: string;
  image?: string;
  commission: number; // %
  apy?: number; // 预计年化 %（含 Jito MEV 分成）
  stake?: number; // 已获得的质押量（SOL）
  uptime?: number;
  skipRate?: number;
  delinquent?: boolean;
  website?: string;
}

export interface StakeAccountInfo {
  address: string;
  owner: string; // 提取权限（谁的钱）
  staker: string;
  sol: number; // 账户余额（含押金和已到账收益）
  delegated: number; // 委托中的 SOL
  status: StakeStatus;
  vote?: string;
  validator?: ValidatorInfo;
  activationEpoch?: number;
  deactivationEpoch?: number;
  lastReward?: { epoch: number; sol: number }; // 上一期收益
  apr?: number; // 按上一期收益折算的年化 %
  withdrawable: number; // 现在可以提取的 SOL
}

export interface LstHolding {
  owner: string;
  mint: string;
  symbol: string;
  amount: number; // 代币数量
  solPerToken: number;
  sol: number; // 折合 SOL
  apy?: number;
}

export interface StakePositions {
  owners: string[];
  walletSol: number; // 这些钱包里可用的 SOL
  accounts: StakeAccountInfo[];
  lst: LstHolding[];
  stakedSol: number; // 质押账户 + LST 折合
  lastEpochReward: number; // 上一期收益合计
  apy?: number; // 加权年化 %
}

export interface EpochInfoView {
  epoch: number;
  progress: number; // 0–1
  endsInSec: number; // 这一期还剩多久（下一次发收益）
  epochSec: number; // 每期多长
}

export interface StakingView {
  epoch: EpochInfoView;
  networkApy: number; // 全网加权年化 %
  validators: ValidatorInfo[]; // 推荐的验证者
  company: StakePositions & { principal: number; rewardsSol: number }; // principal = 投入的本金；rewardsSol = 累计收益
  includeInAssets: boolean;
}

export interface HolderStaking {
  sid: string;
  name: string;
  pct: number;
  wallets: string[];
  positions: StakePositions;
}

export type StakeAction = 'stake' | 'deactivate' | 'withdraw';

export interface PreparedStakeTx {
  transaction: string; // base64，未签名
  action: StakeAction;
  stakeAccount: string;
  sol?: number;
  rent?: number; // 新建质押账户的押金（取回时退还）
}

// ─── 公司内部质押（员工充值 SOL，按年化分息） ─────────────────────
export type LedgerType = 'deposit' | 'withdraw' | 'interest'; // 充值 / 赎回（取回本金）/ 分息

export interface InternalProgram {
  enabled: boolean;
  name: string;
  apr: number; // 当前年化分息率 %
  minDeposit: number; // 最低充值（SOL）
  lockDays: number; // 每笔充值的锁定天数（期间不能赎回）
  payoutNote: string; // 发放规则说明，例如"每月 1 号发放上月分息"
  poolWallet?: string; // 内部质押收款钱包（员工和管理员可见）
  rates?: { from: number; apr: number }[]; // 年化调整记录（管理员可见）
}

export interface InternalRecord {
  id: string;
  ts: number;
  type: LedgerType;
  sol: number;
  usd: number; // 发生时的美元价值
  source: 'chain' | 'manual';
  sig?: string;
  from?: 'pool' | 'company'; // 链上记录：哪个钱包相关
  addr?: string; // 链上记录：员工那一侧的地址
  mid?: string; // 员工 id（未认领的充值为空）
  name?: string;
  note?: string;
  auto?: boolean; // 类型是自动判断的（管理员没改过）
  ignored?: boolean; // 管理员标记"不计入"
  amount?: number; // 手动记录的原始金额
  currency?: 'cny' | 'usd' | 'sol';
}

export interface RedeemRequest {
  id: string;
  mid: string;
  name?: string;
  ts: number;
  sol: number;
  status: 'pending' | 'done' | 'cancelled';
  note?: string;
  doneAt?: number;
}

export interface InternalAccount {
  id: string;
  name: string;
  wallets: string[];
  note?: string; // 管理员可见
  code?: string; // 登录码（管理员可见）
  principal: number; // 本金（SOL）
  locked: number; // 还在锁定期的本金
  available: number; // 现在可以申请赎回的本金
  nextUnlock?: number; // 下一笔解锁时间（unix 秒）
  accrued: number; // 累计应得分息
  paid: number; // 已发分息
  unpaid: number; // 待发分息
  daily: number; // 按当前本金和年化，每天产生的分息
  pendingRedeem: number;
  records: InternalRecord[]; // 新 → 旧
  requests: RedeemRequest[];
}

export interface InternalTotals {
  members: number;
  principal: number;
  accrued: number;
  paid: number;
  unpaid: number;
  daily: number;
  poolWalletSol: number;
  poolStakedSol: number;
  coverage: number | null; // 资金池 ÷（本金 + 待发分息）
}

export interface InternalView {
  role: Role;
  program: InternalProgram;
  me?: InternalAccount; // 员工本人
  totals?: InternalTotals; // 管理员
  members?: InternalAccount[]; // 管理员
  unassigned?: InternalRecord[]; // 管理员：发到资金池、但不是登记钱包转来的充值
  requests?: RedeemRequest[]; // 管理员：全部赎回申请
  records?: InternalRecord[]; // 管理员：全部记录
}

export interface PreparedTransfer {
  transaction: string; // base64，未签名
  items: { to: string; sol: number; type: LedgerType; mid?: string }[];
}

// ─── 公司目标 ────────────────────────────────────────────────
export interface GoalView {
  target: number; // 目标（SOL，按公司总资产算）
  label?: string; // 例如"年底冲刺"
  setAt: number; // 设定时间（unix 秒）
  startSol: number; // 设定时的公司总资产
  reachedAt?: number; // 达成时间
  past: { target: number; label?: string; setAt: number; reachedAt: number }[]; // 以前达成过的目标
}

// ─── 年度报告 ────────────────────────────────────────────────
export interface ReportData {
  year: number;
  years: number[];
  from: number;
  to: number;
  usdCny: number;
  solUsdNow: number;
  txCount: number;
  activeDays: number;
  first?: { ts: number; sol: number; solUsd: number; fromLabel?: string };
  start: number; // 年初的 SOL
  end: number; // 现在（或年底）的 SOL
  peak?: { ts: number; sol: number };
  biggestIn?: { ts: number; sol: number; usd: number; fromLabel?: string };
  bestDay?: { date: string; net: number; count: number };
  busiestDay?: { date: string; count: number };
  night: { count: number; latest?: string }; // latest = 最晚的一次（北京时间 HH:MM）
  topHour?: { hour: number; count: number };
  kinds: Partial<Record<ActivityKind, { count: number; sol: number }>>;
  totalIn: number;
  totalOut: number;
  fees: number;
  poison: { count: number; imitated: string[] };
  hodlDays: number;
  topSender?: { label: string; count: number; sol: number };
  topToken?: { symbol: string; buys: number; sells: number };
  dividends?: { count: number; sol: number };
  achievements: { unlocked: number; total: number; icons: string[]; thisYear: number };
  growth: { t: number; sol: number }[]; // 资产曲线（抽样）
}

// ─── USVK 模拟盘（虚拟 SOL，不上链） ─────────────────────────────

/** 代币和盘口参数（pump.fun 规则，按总量等比放大） */
export interface SimParams {
  name: string;
  symbol: string;
  supply: number; // 总量（枚）
  decimals: number;
  initVirtualSol: number; // 内盘初始虚拟 SOL 储备
  initVirtualTokens: number; // 内盘初始虚拟代币储备
  initRealTokens: number; // 内盘可卖出的代币；其余留给毕业后的池子
  curveProtocolBps: number; // 内盘协议手续费
  curveCreatorBps: number; // 内盘创作者手续费（归发行方）
  ammLpBps: number; // 外盘 LP 手续费（留在池子里）
  ammProtocolBps: number;
  ammCreatorBps: number;
}

/** 盘口状态：内盘（bonding curve，有虚拟储备）→ 买满毕业 → 外盘（PumpSwap 恒定乘积池） */
export interface SimPool {
  phase: 'curve' | 'amm';
  vSol: number;
  vTok: number;
  rSol: number; // 内盘里真实的 SOL
  rTok: number; // 内盘还能卖出的代币
  poolSol: number; // 外盘池子里的 SOL
  poolTok: number; // 外盘池子里的代币
}

/** admin = 公司（管理员）；staff = 员工；client = 内部客户 */
export type SimKind = 'admin' | 'staff' | 'client';

export interface SimTrade {
  id: number;
  ts: number; // 毫秒
  name: string; // 别人的名字会打码（管理员看全名）
  kind: SimKind;
  me?: boolean;
  aid?: string; // 账号 id（只有管理员能看到）
  side: 'buy' | 'sell';
  venue: 'curve' | 'amm' | 'both';
  sol: number; // 买入：花掉的 SOL（含手续费）；卖出：到手的 SOL（已扣手续费）
  tokens: number;
  fee: number;
  priceBefore: number; // SOL / 枚
  priceAfter: number;
  graduated?: boolean; // 这一笔买满了内盘
  solUsd: number;
  /** 成交后的流通量（大家手里的代币）；流通市值 = 现价 × 流通量 */
  circAfter?: number;
}

/** K 线用的精简成交（一轮里的全部成交，按顺序） */
export interface SimTick {
  id: number;
  ts: number; // 毫秒
  side: 'buy' | 'sell';
  sol: number;
  tokens: number;
  pb: number; // 成交前价格（SOL / 枚）
  pa: number; // 成交后价格
  cb: number; // 成交前流通量
  ca: number; // 成交后流通量
  me?: boolean;
  grad?: boolean;
}

export interface SimHolder {
  name: string;
  kind: SimKind;
  tokens: number;
  me?: boolean;
  aid?: string;
}

export interface SimStats {
  trades: number;
  buys: number;
  sells: number;
  volumeSol: number;
  protocolFees: number;
  creatorFees: number; // 归发行方（公司）
  lpFees: number;
  athPrice: number;
  athAt: number;
  athMcap: number; // 流通市值的历史最高（SOL）
  athMcapAt: number;
}

export interface SimRoundSummary {
  round: number;
  startedAt: number;
  endedAt: number;
  trades: number;
  traders: number;
  volumeSol: number;
  peakPrice: number;
  peakMcap?: number; // 最高流通市值（SOL）
  endPrice: number;
  graduated: boolean;
}

/** 当前登录账号自己的情况 */
export interface SimMe {
  id: string;
  name: string;
  kind: SimKind;
  /** company = 公司总资产；staking = 内部质押本金；none = 还没关联内部质押 */
  budgetSource: 'company' | 'staking' | 'none';
  budget: number; // 额度（SOL）
  linkedName?: string; // 关联的内部质押员工
  available: number; // 现在还能花的 SOL = 额度 − 已投入 + 已收回
  tokens: number;
  cost: number; // 当前持仓成本（均价法，SOL）
  spent: number;
  received: number;
  realized: number;
  buys: number;
  sells: number;
  needPassword: boolean; // 管理员买卖要先输交易密码
  username?: string; // 登录账号
}

export interface SimAccountAdmin extends Omit<SimMe, 'needPassword'> {
  code?: string;
  hasPassword?: boolean;
  memberId?: string;
  note?: string;
  createdAt: number;
}

export interface SimView {
  rev: number;
  params: SimParams;
  round: number;
  startedAt: number;
  pool: SimPool;
  graduatedAt: number | null;
  stats: SimStats;
  holders: SimHolder[];
  holderCount: number;
  trades: SimTrade[]; // 新 → 旧
  past: SimRoundSummary[];
  companySol: number; // 公司总资产（拉盘预演用）
  me: SimMe | null;
  admin?: {
    accounts: SimAccountAdmin[];
    members: { id: string; name: string; principal: number }[]; // 内部质押里登记的员工（用来关联额度）
  };
}
