// ───────────────────────────────────────────────────────────────
//  VK 链（公司自己的单节点区块链，正式网）—— 节点在同一台服务器上（systemd vkchain，只监听本机）
//  · 索引器：逐块读取非投票交易，保存到 data/chain/（节点只保留最近几小时的区块，App 永久保存交易记录）
//  · 区块浏览器数据：概览 / 区块 / 交易 / 地址 / 资产
//  · App 内钱包：服务器组装未签名交易并模拟 → 手机上用本地私钥签名 → 服务器广播并等待确认
//  · 水龙头（限频）、管理员发放 VK
//  · 对外公开的 RPC（方法白名单 + 限频，WebSocket 订阅同路径），外部钱包 / 命令行可直接连
// ───────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CHAIN_NAME,
  CHAIN_RPC_PATH,
  FEE_PER_SIG,
  LAMPORTS_PER_VK,
  MEMO_PROGRAM,
  VK_SYMBOL,
  VOTE_PROGRAM,
  type ChainAddressView,
  type ChainAdminView,
  type ChainAllocation,
  type ChainBlock,
  type ChainBlockView,
  type ChainFaucetResult,
  type ChainMirror,
  type ChainOverview,
  type ChainPrepared,
  type ChainSendResult,
  type ChainToken,
  type ChainTokenBalance,
  type ChainTx,
  type ChainTxKind,
  type ChainTxView,
} from '../shared/chain';
import { ATA_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../shared/constants';
import {
  MINT_MIRROR_LEN,
  MINT_WITH_POINTER_LEN,
  buildBurnTx,
  buildCreateMirrorTx,
  buildMirrorSyncTx,
  buildCreateTokenTx,
  buildMintToTx,
  buildRenounceTx,
  buildTokenTransferTx,
  buildVkTransferTx,
  loadKeypair,
  metadataTlvLen,
  parseTx,
  signWith,
  type ServerKeypair,
} from './chaintx';
import { HttpError } from './access';
import { associatedTokenAddress, bs58encode, isValidPubkey } from './solana';
import { addressWithSeed } from './staketx';

const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';
/** solana-test-validator 创世时给 --mint 地址（公司金库）的固定数量 */
const TREASURY_GENESIS_VK = 500_000_000;
/** 创世时节点自己的账户：身份 500 + 投票账户 100 万 + 质押账户 100 万 */
const NODE_GENESIS_VK = 2_000_500;
/** 公司资产凭证：1 cSOL = 公司在 Solana 主网上的 1 SOL（钱包 + 计入资产的质押）；cUSDT / cUSDC 同理。都不可转让 */
type MirrorKey = 'sol' | 'usdt' | 'usdc';
const MIRRORS: Record<MirrorKey, { seed: string; name: string; symbol: string; unit: string; decimals: number; desc: string }> = {
  sol: {
    seed: 'vk-mirror-csol',
    name: 'VK公司SOL凭证',
    symbol: 'cSOL',
    unit: 'SOL',
    decimals: 9,
    desc: 'VectorKeith 公司资产凭证：1 cSOL = 公司 Solana 主网钱包里的 1 SOL（含计入资产的质押），总量随真实余额自动增减，不能转让、不能兑换。',
  },
  usdt: {
    seed: 'vk-mirror-cusdt',
    name: 'VK公司USDT凭证',
    symbol: 'cUSDT',
    unit: 'USDT',
    decimals: 6,
    desc: 'VectorKeith 公司资产凭证：1 cUSDT = 公司 Solana 主网钱包里的 1 USDT（官方 USDT），总量随真实余额自动增减，不能转让、不能兑换。',
  },
  usdc: {
    seed: 'vk-mirror-cusdc',
    name: 'VK公司USDC凭证',
    symbol: 'cUSDC',
    unit: 'USDC',
    decimals: 6,
    desc: 'VectorKeith 公司资产凭证：1 cUSDC = 公司 Solana 主网钱包里的 1 USDC（官方 USDC），总量随真实余额自动增减，不能转让、不能兑换。',
  },
};
const MIRROR_KEYS: MirrorKey[] = ['sol', 'usdt', 'usdc'];
const BLOCK_OPTS = { encoding: 'jsonParsed', transactionDetails: 'full', rewards: false, maxSupportedTransactionVersion: 0, commitment: 'confirmed' };
const MAX_BLOCKS = 240;
const DAY = 86_400_000;

const PROGRAM_LABELS: Record<string, string> = {
  [SYSTEM_PROGRAM]: '系统程序',
  [TOKEN_PROGRAM]: '代币程序',
  [TOKEN_2022_PROGRAM]: '代币程序 2022',
  [ATA_PROGRAM]: '关联代币账户程序',
  [MEMO_PROGRAM]: '备注程序',
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: '备注程序 v1',
  [VOTE_PROGRAM]: '投票程序',
  [STAKE_PROGRAM]: '质押程序',
  ComputeBudget111111111111111111111111111111: '计算预算程序',
  AddressLookupTab1e1111111111111111111111111: '地址查找表程序',
  BPFLoaderUpgradeab1e11111111111111111111111: '程序加载器（可升级）',
  BPFLoader2111111111111111111111111111111111: '程序加载器 v2',
  BPFLoader1111111111111111111111111111111111: '程序加载器 v1',
  Config1111111111111111111111111111111111111: '配置程序',
  Ed25519SigVerify111111111111111111111111111: 'Ed25519 验签程序',
  KeccakSecp256k11111111111111111111111111111: 'Secp256k1 验签程序',
  So11111111111111111111111111111111111111112: '原生币包装账户',
};
const isSysvar = (a: string) => a.startsWith('Sysvar') || a === 'Sysvar1111111111111111111111111111111111111';

const RPC_ALLOW = new Set([
  'getAccountInfo', 'getBalance', 'getBlock', 'getBlockCommitment', 'getBlockHeight', 'getBlockProduction', 'getBlockTime', 'getBlocks',
  'getBlocksWithLimit', 'getClusterNodes', 'getEpochInfo', 'getEpochSchedule', 'getFeeForMessage', 'getFirstAvailableBlock', 'getGenesisHash',
  'getHealth', 'getHighestSnapshotSlot', 'getIdentity', 'getInflationGovernor', 'getInflationRate', 'getInflationReward', 'getLargestAccounts',
  'getLatestBlockhash', 'getLeaderSchedule', 'getMaxRetransmitSlot', 'getMaxShredInsertSlot', 'getMinimumBalanceForRentExemption',
  'getMultipleAccounts', 'getProgramAccounts', 'getRecentPerformanceSamples', 'getRecentPrioritizationFees', 'getSignatureStatuses',
  'getSignaturesForAddress', 'getSlot', 'getSlotLeader', 'getSlotLeaders', 'getStakeMinimumDelegation', 'getSupply', 'getTokenAccountBalance',
  'getTokenAccountsByDelegate', 'getTokenAccountsByOwner', 'getTokenLargestAccounts', 'getTokenSupply', 'getTransaction', 'getTransactionCount',
  'getVersion', 'getVoteAccounts', 'isBlockhashValid', 'minimumLedgerSlot', 'sendTransaction', 'simulateTransaction',
]);
const WS_ALLOW = new Set([
  'accountSubscribe', 'accountUnsubscribe', 'logsSubscribe', 'logsUnsubscribe', 'programSubscribe', 'programUnsubscribe', 'signatureSubscribe',
  'signatureUnsubscribe', 'slotSubscribe', 'slotUnsubscribe', 'rootSubscribe', 'rootUnsubscribe', 'slotsUpdatesSubscribe', 'slotsUpdatesUnsubscribe',
]);

export class ChainError extends HttpError {
  constructor(message: string, status = 400) {
    super(status, message);
  }
}

function readRaw(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface RpcReply {
  result?: any;
  error?: { code: number; message: string; data?: any };
}

/** 本机节点的 JSON-RPC（不需要多节点回退和限流重试） */
class NodeRpc {
  constructor(public url: string) {}
  async batch(calls: [string, unknown[]][], timeoutMs = 15_000): Promise<RpcReply[]> {
    const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body.length === 1 ? body[0] : body), signal: ctrl.signal });
      const json = await res.json();
      const arr: any[] = Array.isArray(json) ? json : [json];
      const out: RpcReply[] = calls.map(() => ({ error: { code: -1, message: 'no response' } }));
      for (const item of arr) if (typeof item?.id === 'number' && item.id < calls.length) out[item.id] = item;
      return out;
    } finally {
      clearTimeout(t);
    }
  }
  async call<T = any>(method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<T> {
    const [r] = await this.batch([[method, params]], timeoutMs);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data });
    return r.result as T;
  }
  async raw(body: string, timeoutMs = 20_000): Promise<{ status: number; text: string }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal });
      return { status: res.status, text: await res.text() };
    } finally {
      clearTimeout(t);
    }
  }
}

interface Settings {
  faucetEnabled: boolean;
  faucetAmount: number;
  faucetCooldownH: number;
  faucetPerIpPerDay: number;
  /** 每个地址终身只能领一次（正式链：新钱包领一点 VK 当 gas） */
  faucetOnce: boolean;
}
interface Claim {
  a: string;
  ip: string;
  at: number;
  amt: number;
  sig: string;
}
interface State {
  genesisHash: string;
  lastSlot: number;
  gasTotal: number;
  settings: Settings;
  claims: Claim[];
  /** 领过水龙头的全部地址（不随 30 天的领取记录一起清理，"只能领一次"靠它判断） */
  claimed: string[];
}
interface GenesisInfo {
  genesisHash: string;
  createdAt: number;
  supply: string;
  treasury: string;
  faucet: string;
  reserve: string;
  faucetGenesis: string;
  reserveGenesis: string;
  identity?: string;
  vote?: string;
  consensus?: string;
  version?: string;
}
interface TokenMeta {
  description?: string;
  icon?: string;
}
interface Intent {
  mint: string;
  owner: string;
  description?: string;
  icon?: { data: Buffer; ext: string };
  expires: number;
}

const DEFAULT_SETTINGS: Settings = { faucetEnabled: true, faucetAmount: 1, faucetCooldownH: 24, faucetPerIpPerDay: 5, faucetOnce: true };
const ICON_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };

function parseAmount(v: unknown, decimals: number, what = '数量'): bigint {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new ChainError(`${what}格式不对`);
  const [int, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new ChainError(`${what}最多 ${decimals} 位小数`);
  const raw = BigInt(int + frac.padEnd(decimals, '0'));
  if (raw <= 0n) throw new ChainError(`${what}要大于 0`);
  if (raw > 18_446_744_073_709_551_615n) throw new ChainError(`${what}太大`);
  return raw;
}
const rawToUi = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;
const fmtVk = (lamports: number) => +(lamports / LAMPORTS_PER_VK).toFixed(9);
const trimNum = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(+v.toFixed(9)));
const ipKey = (ip: string) => crypto.createHash('sha256').update('vkchain:' + ip).digest('hex').slice(0, 16);

/** 链上错误 → 中文说明 */
export function explainChainError(err: unknown, logs?: string[]): string {
  const s = typeof err === 'string' ? err : JSON.stringify(err ?? '');
  const log = (logs ?? []).join('\n');
  if (/AccountNotFound|no record of a prior credit/i.test(s + log)) return '钱包里还没有 VK（先去水龙头领一点，用来付 gas）';
  if (/InsufficientFundsForRent/i.test(s)) return '金额太小：新地址第一次收款至少要 0.00089088 VK（账户免租金押金）';
  if (/InsufficientFundsForFee/i.test(s)) return 'VK 不够付 gas';
  if (/BlockhashNotFound|Blockhash not found/i.test(s + log)) return '交易已过期，请重新操作';
  if (/AlreadyProcessed|already been processed/i.test(s + log)) return '这笔交易已经处理过了';
  if (/SignatureFailure|signature verification/i.test(s + log)) return '签名无效：交易内容被改动过，或者不是用对应的钱包签的';
  if (/fixed/i.test(log) && /supply/i.test(log)) return '这个资产已经放弃增发权限，总量固定，不能再增发';
  if (/insufficient funds/i.test(log)) return '余额不足';
  if (/owner does not match|OwnerMismatch/i.test(log)) return '没有这个资产的操作权限';
  const m = s.match(/"Custom":(\d+)/);
  if (m) {
    const code = Number(m[1]);
    if (/Transfer: insufficient lamports/i.test(log) || (code === 1 && /system/i.test(log))) return 'VK 余额不足';
    if (code === 1) return '余额不足';
    if (code === 4) return '没有这个资产的操作权限';
    if (code === 5) return '这个资产的总量已经固定，不能再增发';
    return `链上程序返回错误 ${code}`;
  }
  if (/InstructionError/.test(s)) return '交易执行失败';
  return s.replace(/^"|"$/g, '').slice(0, 120) || '交易失败';
}

export interface VkChainOptions {
  dataDir: string;
  rpcUrl: string;
  wsUrl: string;
  /** systemd 服务的 cgroup 目录（读节点内存 / CPU / 运行时长；不存在时不显示） */
  cgroupDir?: string;
  /** 对外网址（写进资产元数据的图标链接），默认 http://localhost:8787 */
  publicOrigin?: string;
  /** 公司资产凭证的图标（PNG） */
  mirrorIcon?: string;
  warn?: (label: string, e: unknown) => void;
}

/** 公司资产凭证的数据来源：App 跟踪的主网公司钱包 */
export interface MirrorSource {
  /** 所有公司钱包的余额都已读到 */
  ready(): boolean;
  /** 公司总资产（最小单位，= 「资产」页上的公司总资产） */
  lamports(): number;
  wallets(): { address: string; label: string }[];
  /** 其中计入资产的质押（SOL） */
  stakedSol(): number;
  /** 公司持有的稳定币（最小单位，6 位小数）；还没读到时 null */
  stable?(symbol: 'USDT' | 'USDC'): number | null;
}

interface MirrorState {
  mint?: string;
  createdAt?: number;
  lastSync?: number;
  lastSig?: string;
  syncs?: number;
  lastError?: string;
}

export class VkChain extends EventEmitter {
  private rpc: NodeRpc;
  private dir: string;
  private iconDir: string;
  private state: State;
  private genesis: GenesisInfo | null = null;
  private keys: Partial<Record<'treasury' | 'faucet' | 'reserve', ServerKeypair>> = {};
  private txs: ChainTx[] = [];
  private bySig = new Map<string, number>();
  private byAddr = new Map<string, number[]>();
  private tokens = new Map<string, ChainToken>();
  private meta: Record<string, TokenMeta> = {};
  private blocks: ChainBlock[] = [];
  private intents = new Map<string, Intent>();
  private refreshQueue = new Set<string>();
  private holdersAt = new Map<string, number>();
  private rentCache = new Map<number, number>();
  private samples: [number, number][] = [];
  private timers: NodeJS.Timeout[] = [];
  private ticking = false;
  private rerun = false;
  private genesisChecked = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingFaucet = new Set<string>();
  private claimedSet = new Set<string>();
  private mirrorSrc: MirrorSource | null = null;
  private mirrors: Record<MirrorKey, MirrorState> = { sol: {}, usdt: {}, usdc: {} };
  private mirrorSupply: Record<MirrorKey, number | null> = { sol: null, usdt: null, usdc: null };
  private mirrorBusy = false;
  private mirrorAgain = false;
  private mirrorDebounce: NodeJS.Timeout | null = null;
  private mirrorPendingBig: Record<MirrorKey, { target: bigint; at: number } | null> = { sol: null, usdt: null, usdc: null };
  private nodeStake = '';

  online = false;
  lastError = '';
  slot = 0;
  height = 0;
  epoch = { epoch: 0, slotIndex: 0, slotsInEpoch: 0 };
  version = '';
  totalSupply = 0;
  private balances = new Map<string, number>();
  private cpu: { at: number; usec: number; pct?: number } | null = null;
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
  private wsPerIp = new Map<string, number>();
  private proxyHits = new Map<string, number[]>();

  constructor(private opts: VkChainOptions) {
    super();
    this.rpc = new NodeRpc(opts.rpcUrl);
    this.dir = path.join(opts.dataDir, 'chain');
    this.iconDir = path.join(this.dir, 'icons');
    fs.mkdirSync(this.iconDir, { recursive: true });
    this.state = { genesisHash: '', lastSlot: -1, gasTotal: 0, settings: { ...DEFAULT_SETTINGS }, claims: [], claimed: [] };
    this.load();
    this.wss.on('connection', (ws, req) => this.onProxySocket(ws, req));
  }

  // ─── 持久化 ────────────────────────────────────────────────

  private file(name: string) {
    return path.join(this.dir, name);
  }

  private readJson<T>(name: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private writeJson(name: string, data: unknown) {
    const f = this.file(name);
    fs.writeFileSync(f + '.tmp', JSON.stringify(data));
    fs.renameSync(f + '.tmp', f);
  }

  private load() {
    const s = this.readJson<Partial<State>>('state.json');
    if (s) {
      const claims = s.claims ?? [];
      // 旧版本没有 claimed：用现有的领取记录补上
      this.state = { ...this.state, ...s, settings: { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) }, claims, claimed: s.claimed ?? [...new Set(claims.map((c) => c.a))] };
    }
    this.claimedSet = new Set(this.state.claimed);
    this.genesis = this.readJson<GenesisInfo>('genesis.json');
    this.loadKeys();
    for (const t of Object.values(this.readJson<Record<string, ChainToken>>('tokens.json') ?? {})) this.tokens.set(t.mint, t);
    this.meta = this.readJson<Record<string, TokenMeta>>('meta.json') ?? {};
    // mirror.json：旧版只有 cSOL（平铺的 MirrorState），新版按 sol / usdt / usdc 分开
    const mj = this.readJson<any>('mirror.json');
    if (mj && (mj.sol || mj.usdt || mj.usdc)) this.mirrors = { sol: mj.sol ?? {}, usdt: mj.usdt ?? {}, usdc: mj.usdc ?? {} };
    else if (mj) this.mirrors.sol = mj;
    try {
      for (const line of fs.readFileSync(this.file('txs.jsonl'), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.indexTx(JSON.parse(line) as ChainTx);
        } catch {
          /* 跳过损坏的行 */
        }
      }
    } catch {
      /* 还没有交易记录 */
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.writeJson('state.json', this.state);
        this.writeJson('tokens.json', Object.fromEntries(this.tokens));
      } catch (e) {
        this.opts.warn?.('save', e);
      }
    }, 1500);
  }

  /** 链重新创世了（genesis hash 变了）：清空旧链的索引 */
  private resetIndex(genesisHash: string) {
    console.log(`[vkchain] 检测到新的创世区块 ${genesisHash}，清空旧链索引`);
    this.txs = [];
    this.bySig.clear();
    this.byAddr.clear();
    this.tokens.clear();
    this.blocks = [];
    this.meta = {};
    this.samples = [];
    this.holdersAt.clear();
    this.refreshQueue.clear();
    this.intents.clear();
    this.balances.clear();
    this.nodeStake = '';
    this.state = { ...this.state, genesisHash, lastSlot: -1, gasTotal: 0, claims: [], claimed: [] };
    this.claimedSet.clear();
    for (const f of ['txs.jsonl', 'tokens.json', 'meta.json']) fs.rmSync(this.file(f), { force: true });
    fs.rmSync(this.iconDir, { recursive: true, force: true });
    fs.mkdirSync(this.iconDir, { recursive: true });
    this.writeJson('state.json', this.state);
    this.loadKeys(); // 重新创世时可能换了金库 / 水龙头私钥
  }

  private loadKeys() {
    this.keys = {};
    for (const k of ['treasury', 'faucet', 'reserve'] as const) {
      const kp = loadKeypair(path.join(this.dir, 'keys', `${k}.json`));
      if (kp) this.keys[k] = kp;
    }
  }

  // ─── 生命周期 ──────────────────────────────────────────────

  start() {
    void this.tick();
    void this.refreshStats();
    this.timers.push(setInterval(() => void this.tick(), 1000));
    this.timers.push(setInterval(() => void this.refreshStats(), 5000));
    this.timers.push(setInterval(() => this.cleanup(), 60_000));
    this.timers.push(setInterval(() => void this.syncMirror('定时核对'), 5 * 60_000));
    setTimeout(() => void this.syncMirror('启动核对'), 20_000);
  }

  // ─── 公司资产凭证（cSOL）：总量 = 公司主网真实 SOL ─────────

  setMirrorSource(src: MirrorSource) {
    this.mirrorSrc = src;
  }

  /** 公司余额变了：8 秒后同步（连续变化只同步一次） */
  mirrorChanged() {
    if (this.mirrorDebounce) clearTimeout(this.mirrorDebounce);
    this.mirrorDebounce = setTimeout(() => {
      this.mirrorDebounce = null;
      void this.syncMirror('余额变化');
    }, 8000);
  }

  private saveMirror() {
    try {
      this.writeJson('mirror.json', this.mirrors);
    } catch (e) {
      this.opts.warn?.('mirror', e);
    }
  }

  private isMirrorMint(mint?: string): MirrorKey | undefined {
    if (!mint) return undefined;
    return MIRROR_KEYS.find((k) => this.mirrors[k].mint === mint);
  }

  /** 凭证资产不存在就创建（金库付 gas 和押金） */
  private async ensureMirrorMint(key: MirrorKey): Promise<{ mint: string; ata: string } | null> {
    const kp = this.keys.treasury;
    if (!kp) return null;
    const M = MIRRORS[key];
    const st = this.mirrors[key];
    const mint = addressWithSeed(kp.address, M.seed, TOKEN_2022_PROGRAM);
    const ata = associatedTokenAddress(kp.address, mint, TOKEN_2022_PROGRAM);
    if (st.mint === mint && st.createdAt) return { mint, ata };
    const exists = (await this.rpc.call<any>('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }])).value;
    if (!exists) {
      const origin = (this.opts.publicOrigin ?? 'http://localhost:8787').replace(/\/+$/, '');
      const uri = `${origin}/chain/meta/${mint}.json`;
      const lamports = await this.rent(MINT_MIRROR_LEN + metadataTlvLen(M.name, M.symbol, uri));
      const { tx } = buildCreateMirrorTx({ authority: kp.address, seed: M.seed, name: M.name, symbol: M.symbol, uri, decimals: M.decimals, lamports: BigInt(lamports), blockhash: await this.blockhash() });
      await this.simulate(tx);
      const r = await this.sendRaw(signWith(tx, kp));
      if (!r.ok) throw new Error(`创建公司资产凭证失败：${r.err}`);
      console.log(`[vkchain] 已创建公司资产凭证 ${M.symbol} ${mint}`);
    }
    // 图标 + 简介（浏览器和外部钱包都能看到）
    const m: TokenMeta = { ...(this.meta[mint] ?? {}), description: M.desc };
    if (!m.icon && this.opts.mirrorIcon) {
      try {
        fs.copyFileSync(this.opts.mirrorIcon, path.join(this.iconDir, `${mint}.png`));
        m.icon = 'png';
      } catch (e) {
        this.opts.warn?.('mirror icon', e);
      }
    }
    this.meta[mint] = m;
    try {
      this.writeJson('meta.json', this.meta);
    } catch (e) {
      this.opts.warn?.('meta', e);
    }
    this.mirrors[key] = { ...st, mint, createdAt: st.createdAt ?? Date.now() };
    this.saveMirror();
    return { mint, ata };
  }

  /** 凭证的目标总量（最小单位）；数据还没读到时 null */
  private mirrorTarget(key: MirrorKey): bigint | null {
    const src = this.mirrorSrc;
    if (!src) return null;
    if (key === 'sol') return src.ready() ? BigInt(Math.max(0, Math.round(src.lamports()))) : null;
    const v = src.stable?.(key === 'usdt' ? 'USDT' : 'USDC');
    return v == null ? null : BigInt(Math.max(0, Math.round(v)));
  }

  /** 把凭证总量调到 = 公司主网真实余额（多了增发、少了销毁，每次都带一条链上备注） */
  async syncMirror(reason: string) {
    const src = this.mirrorSrc;
    const kp = this.keys.treasury;
    if (!src || !kp || !this.online) return;
    if (this.mirrorBusy) {
      this.mirrorAgain = true;
      return;
    }
    this.mirrorBusy = true;
    try {
      for (const key of MIRROR_KEYS) await this.syncOne(key, reason, kp);
    } finally {
      this.mirrorBusy = false;
      if (this.mirrorAgain) {
        this.mirrorAgain = false;
        setTimeout(() => void this.syncMirror('补充同步'), 2000);
      }
    }
  }

  private async syncOne(key: MirrorKey, reason: string, kp: ServerKeypair) {
    const M = MIRRORS[key];
    const st = this.mirrors[key];
    try {
      const target = this.mirrorTarget(key);
      if (target == null) return;
      // 稳定币从来没有持有过：先不创建凭证（等第一次转入）
      if (key !== 'sol' && target === 0n && !st.mint) return;
      const m = await this.ensureMirrorMint(key);
      if (!m) return;
      const supplyRaw = BigInt((await this.rpc.call<any>('getTokenSupply', [m.mint, { commitment: 'confirmed' }])).value.amount);
      const delta = target - supplyRaw;
      const unit = 10 ** M.decimals;
      if (delta !== 0n) {
        // 变化超过一半：可能是主网节点暂时读错，隔 1 分钟连续两次读数一致才执行
        const big = supplyRaw > 0n && (delta < 0n ? -delta : delta) * 2n > supplyRaw;
        if (big) {
          const p = this.mirrorPendingBig[key];
          if (!p || p.target !== target) {
            this.mirrorPendingBig[key] = { target, at: Date.now() };
            setTimeout(() => void this.syncMirror('大额变化复核'), 65_000);
            return;
          }
          if (Date.now() - p.at < 60_000) return;
        }
        this.mirrorPendingBig[key] = null;
        const amt = trimNum(Number(target) / unit);
        const memo = `公司资产同步：${amt} ${M.unit}（${reason}）`;
        const tx = buildMirrorSyncTx({ authority: kp.address, mint: m.mint, ata: m.ata, delta, decimals: M.decimals, memo, blockhash: await this.blockhash() });
        const r = await this.sendRaw(signWith(tx, kp));
        if (!r.ok) throw new Error(r.err ?? '同步失败');
        st.lastSig = r.sig;
        st.syncs = (st.syncs ?? 0) + 1;
        console.log(`[vkchain] 公司资产凭证 ${M.symbol} 同步到 ${amt} ${M.unit}（${delta > 0n ? '+' : ''}${trimNum(Number(delta) / unit)}）`);
      }
      this.mirrorSupply[key] = Number(target) / unit;
      st.lastSync = Date.now();
      st.lastError = undefined;
      this.mirrors[key] = { ...this.mirrors[key], ...st };
      this.saveMirror();
    } catch (e) {
      this.mirrors[key].lastError = (e as Error).message;
      this.opts.warn?.(`mirror ${M.symbol}`, e);
    }
  }

  private mirrorView(): ChainMirror | undefined {
    const st = this.mirrors.sol;
    const mint = st.mint;
    const src = this.mirrorSrc;
    if (!mint || !src) return undefined;
    const realSol = src.ready() ? src.lamports() / LAMPORTS_PER_VK : null;
    const chainSol = this.mirrorSupply.sol ?? this.tokens.get(mint)?.supply ?? null;
    const stables: ChainMirror['stables'] = [];
    for (const key of ['usdt', 'usdc'] as const) {
      const s2 = this.mirrors[key];
      if (!s2.mint) continue;
      const t = this.mirrorTarget(key);
      const real = t == null ? null : Number(t) / 1e6;
      const chain = this.mirrorSupply[key] ?? this.tokens.get(s2.mint)?.supply ?? null;
      stables.push({ symbol: MIRRORS[key].symbol, unit: MIRRORS[key].unit, mint: s2.mint, chain, real, inSync: real != null && chain != null && Math.round(real * 1e6) === Math.round(chain * 1e6), lastSig: s2.lastSig, syncs: s2.syncs ?? 0, error: s2.lastError });
    }
    const errors = [st.lastError, ...stables.map((x) => x.error)].filter(Boolean);
    return {
      mint,
      symbol: MIRRORS.sol.symbol,
      chainSol,
      realSol,
      inSync: realSol != null && chainSol != null && Math.round(realSol * LAMPORTS_PER_VK) === Math.round(chainSol * LAMPORTS_PER_VK) && stables.every((x) => x.inSync),
      stakedSol: src.stakedSol(),
      wallets: src.wallets(),
      lastSync: st.lastSync,
      lastSig: st.lastSig,
      syncs: (st.syncs ?? 0) + stables.reduce((n, x) => n + x.syncs, 0),
      error: errors.length ? errors.join('；') : undefined,
      stables,
    };
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      try {
        this.writeJson('state.json', this.state);
        this.writeJson('tokens.json', Object.fromEntries(this.tokens));
      } catch {
        /* ignore */
      }
    }
  }

  get keysLoaded() {
    return !!this.keys.faucet;
  }

  private kick() {
    setTimeout(() => void this.tick(), 250);
  }

  private async tick() {
    if (this.ticking) {
      this.rerun = true;
      return;
    }
    this.ticking = true;
    try {
      if (!this.genesisChecked) await this.checkGenesis();
      let slot = await this.rpc.call<number>('getSlot', [{ commitment: 'confirmed' }], 5000);
      // 节点重连、或者区块号往回走了（链重新创世）：重新核对创世哈希，变了就清空旧索引
      if (!this.online || slot < this.state.lastSlot - 5) {
        await this.checkGenesis();
        slot = await this.rpc.call<number>('getSlot', [{ commitment: 'confirmed' }], 5000);
        if (slot < this.state.lastSlot - 5) {
          // 创世哈希没变但区块号倒退（例如从快照恢复）：从节点现有的区块继续
          this.state.lastSlot = slot - 1;
          this.scheduleSave();
        }
      }
      if (!this.online) console.log(`[vkchain] 节点在线，slot ${slot}`);
      this.online = true;
      this.lastError = '';
      this.slot = slot;
      const now = Date.now();
      this.samples.push([now, slot]);
      while (this.samples.length > 2 && now - this.samples[0][0] > 60_000) this.samples.shift();
      await this.catchUp(slot);
      await this.processRefresh();
    } catch (e) {
      if (this.online) console.warn('[vkchain] 节点连接失败：', (e as Error).message);
      this.online = false;
      this.lastError = (e as Error).message;
    } finally {
      this.ticking = false;
      if (this.rerun) {
        this.rerun = false;
        this.kick();
      }
    }
  }

  private async checkGenesis() {
    const gh = await this.rpc.call<string>('getGenesisHash', [], 5000);
    if (this.state.genesisHash && this.state.genesisHash !== gh) this.resetIndex(gh);
    else if (!this.state.genesisHash) {
      this.state.genesisHash = gh;
      this.scheduleSave();
    }
    const g = this.readJson<GenesisInfo>('genesis.json');
    this.genesis = g && g.genesisHash === gh ? g : null;
    // 节点的质押账户（委托给节点投票账户的那个）：用于创世分配展示
    try {
      const votes = await this.rpc.call<any>('getVoteAccounts', [], 5000);
      const v = [...(votes.current ?? []), ...(votes.delinquent ?? [])][0];
      if (v) {
        if (this.genesis) {
          this.genesis.identity ??= v.nodePubkey;
          this.genesis.vote ??= v.votePubkey;
        }
        const stakes = await this.rpc.call<any[]>('getProgramAccounts', [STAKE_PROGRAM, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 124, bytes: v.votePubkey } }] }], 8000);
        this.nodeStake = stakes[0]?.pubkey ?? '';
      }
    } catch (e) {
      this.opts.warn?.('genesis', e);
    }
    this.genesisChecked = true;
  }

  private async catchUp(slot: number) {
    let from = this.state.lastSlot + 1;
    if (from > slot) return;
    if (from === 0 || slot - from > 2000) {
      const first = await this.rpc.call<number>('getFirstAvailableBlock', [], 5000).catch(() => 0);
      if (from < first) from = first;
    }
    // 落后很多时（服务重启后补数据）每轮多抓一些；空块很小，按 40 个一批
    const to = Math.min(slot, from + 1000);
    const slots = await this.rpc.call<number[]>('getBlocks', [from, to, { commitment: 'confirmed' }], 10_000);
    for (let i = 0; i < slots.length; i += 40) {
      const chunk = slots.slice(i, i + 40);
      const replies = await this.rpc.batch(chunk.map((s) => ['getBlock', [s, BLOCK_OPTS]]), 20_000);
      const lines: string[] = [];
      for (let k = 0; k < chunk.length; k++) {
        const r = replies[k];
        if (r.result) {
          lines.push(...this.ingestBlock(chunk[k], r.result));
          continue;
        }
        // -32004 区块不可用 / -32007 跳过的 slot / -32009 已清理：跳过；其他错误下次重试
        if (r.error && [-32004, -32007, -32009].includes(r.error.code)) continue;
        if (lines.length) fs.appendFileSync(this.file('txs.jsonl'), lines.join(''));
        this.state.lastSlot = chunk[k] - 1;
        this.scheduleSave();
        return;
      }
      if (lines.length) fs.appendFileSync(this.file('txs.jsonl'), lines.join(''));
    }
    this.state.lastSlot = to;
    this.scheduleSave();
  }

  /** 返回要追加到 txs.jsonl 的行 */
  private ingestBlock(slot: number, b: any): string[] {
    const out: string[] = [];
    let nonVote = 0;
    let fees = 0;
    for (const t of b.transactions ?? []) {
      fees += t.meta?.fee ?? 0;
      if (this.isVote(t)) continue;
      nonVote++;
      const rec = this.parseTx(t, slot, b.blockTime ?? null);
      if (!rec || this.bySig.has(rec.sig)) continue;
      this.indexTx(rec);
      this.onNewTx(rec);
      out.push(JSON.stringify(rec) + '\n');
    }
    this.state.gasTotal += fees;
    this.blocks.push({ slot, height: b.blockHeight ?? null, time: b.blockTime ?? null, hash: b.blockhash, txs: nonVote, fees });
    if (this.blocks.length > MAX_BLOCKS) this.blocks.splice(0, this.blocks.length - MAX_BLOCKS);
    if (b.blockHeight != null) this.height = b.blockHeight;
    return out;
  }

  private isVote(t: any) {
    const ixs = t.transaction?.message?.instructions ?? [];
    return ixs.length > 0 && ixs.every((i: any) => i.programId === VOTE_PROGRAM);
  }

  private indexTx(rec: ChainTx) {
    const i = this.txs.length;
    this.txs.push(rec);
    this.bySig.set(rec.sig, i);
    const addrs = new Set([...rec.accounts, ...rec.tok.map((x) => x.o)]);
    for (const a of addrs) {
      let list = this.byAddr.get(a);
      if (!list) this.byAddr.set(a, (list = []));
      list.push(i);
    }
    if (rec.mint) {
      let list = this.byAddr.get(rec.mint);
      if (!list) this.byAddr.set(rec.mint, (list = []));
      if (list[list.length - 1] !== i) list.push(i);
    }
  }

  private onNewTx(rec: ChainTx) {
    if (!rec.ok) return;
    if (rec.kind === 'token-create' && rec.mint && !this.tokens.has(rec.mint)) {
      const create = rec.ix.find((x) => x.t === 'initializeMint' || x.t === 'initializeMint2');
      const info = (create?.info ?? {}) as Record<string, any>;
      this.tokens.set(rec.mint, {
        mint: rec.mint,
        program: create?.p === 'spl-token' ? 'token' : 'token-2022',
        name: '',
        symbol: '',
        decimals: Number(info.decimals ?? 0),
        supply: 0,
        mintAuthority: info.mintAuthority ?? null,
        freezeAuthority: info.freezeAuthority ?? null,
        creator: rec.payer,
        createdAt: rec.time ?? Math.floor(Date.now() / 1000),
        sig: rec.sig,
      });
      this.scheduleSave();
    }
    for (const m of new Set([rec.mint, ...rec.tok.map((x) => x.m)].filter(Boolean) as string[])) {
      if (this.tokens.has(m)) {
        this.refreshQueue.add(m);
        this.holdersAt.delete(m);
      }
    }
  }

  /** 刷新资产的链上信息（名称 / 符号 / 总量 / 权限 / 持有人数） */
  private async processRefresh() {
    const list = [...this.refreshQueue].slice(0, 10);
    if (!list.length) return;
    for (const m of list) this.refreshQueue.delete(m);
    const replies = await this.rpc.batch(list.map((m) => ['getAccountInfo', [m, { encoding: 'jsonParsed', commitment: 'confirmed' }]]));
    list.forEach((m, k) => {
      const v = replies[k].result?.value;
      const t = this.tokens.get(m);
      if (!v || !t) return;
      this.applyMintInfo(t, v);
    });
    for (const m of list) await this.refreshHolders(m).catch(() => {});
    this.scheduleSave();
    this.emit('tokens');
  }

  private applyMintInfo(t: ChainToken, v: any) {
    const info = v.data?.parsed?.info;
    if (!info) return;
    t.program = v.owner === TOKEN_PROGRAM ? 'token' : 'token-2022';
    t.decimals = info.decimals ?? t.decimals;
    t.supply = rawToUi(BigInt(info.supply ?? '0'), t.decimals);
    t.mintAuthority = info.mintAuthority ?? null;
    t.freezeAuthority = info.freezeAuthority ?? null;
    const md = (info.extensions ?? []).find((e: any) => e.extension === 'tokenMetadata')?.state;
    if (md) {
      t.name = String(md.name ?? '').slice(0, 64);
      t.symbol = String(md.symbol ?? '').slice(0, 16);
      t.uri = md.uri || undefined;
      t.updateAuthority = md.updateAuthority ?? null;
    }
    if (!t.symbol) t.symbol = `TKN-${t.mint.slice(0, 4)}`;
    if (!t.name) t.name = `未命名资产 ${t.mint.slice(0, 4)}`;
  }

  private async refreshHolders(mint: string) {
    const t = this.tokens.get(mint);
    if (!t) return;
    const last = this.holdersAt.get(mint) ?? 0;
    if (Date.now() - last < 30_000) return;
    this.holdersAt.set(mint, Date.now());
    const accts = await this.rpc.call<any[]>('getProgramAccounts', [t.program === 'token' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 64, length: 8 }, filters: [{ memcmp: { offset: 0, bytes: mint } }] }], 10_000);
    t.holders = accts.filter((a) => {
      const b = Buffer.from(a.account.data[0], 'base64');
      return b.length === 8 && b.readBigUInt64LE(0) > 0n;
    }).length;
  }

  private async refreshStats() {
    if (!this.online && this.genesisChecked) return;
    // 重新创世时，安装脚本在新节点启动之后才写 genesis.json：还没对上就再读一次
    if (this.state.genesisHash && this.genesis?.genesisHash !== this.state.genesisHash) {
      const g = this.readJson<GenesisInfo>('genesis.json');
      if (g?.genesisHash === this.state.genesisHash) this.genesis = g;
    }
    try {
      const watch = this.watchAddresses();
      const calls: [string, unknown[]][] = [
        ['getSupply', [{ commitment: 'confirmed', excludeNonCirculatingAccountsList: true }]],
        ['getEpochInfo', [{ commitment: 'confirmed' }]],
        ['getMultipleAccounts', [watch, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }]],
      ];
      if (!this.version) calls.push(['getVersion', []]);
      else calls.push(['getHealth', []]);
      const mkeys = MIRROR_KEYS.filter((k) => this.mirrors[k].mint);
      for (const k of mkeys) calls.push(['getTokenSupply', [this.mirrors[k].mint, { commitment: 'confirmed' }]]);
      const [sup, ep, multi, ver, ...ms] = await this.rpc.batch(calls, 8000);
      mkeys.forEach((k, i) => {
        const v = ms[i]?.result?.value?.uiAmountString;
        if (v != null) this.mirrorSupply[k] = Number(v);
      });
      if (sup.result) this.totalSupply = sup.result.value.total;
      if (ep.result) {
        this.epoch = { epoch: ep.result.epoch, slotIndex: ep.result.slotIndex, slotsInEpoch: ep.result.slotsInEpoch };
        this.height = ep.result.blockHeight ?? this.height;
      }
      if (multi.result) watch.forEach((a, i) => this.balances.set(a, multi.result.value[i]?.lamports ?? 0));
      if (ver?.result?.['solana-core']) this.version = ver.result['solana-core'];
      // 持有人数：每分钟刷新一次（小链，直接扫代币账户）
      for (const t of this.tokens.values()) if (Date.now() - (this.holdersAt.get(t.mint) ?? 0) > 60_000) this.refreshQueue.add(t.mint);
    } catch (e) {
      this.opts.warn?.('stats', e);
    }
    this.sampleCpu();
  }

  private watchAddresses(): string[] {
    const g = this.genesis;
    return [this.keys.treasury?.address ?? g?.treasury, this.keys.reserve?.address ?? g?.reserve, this.keys.faucet?.address ?? g?.faucet, g?.identity, g?.vote, this.nodeStake].filter(
      (a): a is string => !!a,
    );
  }

  private cleanup() {
    const now = Date.now();
    for (const [k, v] of this.intents) if (v.expires < now) this.intents.delete(k);
    const keep = now - 30 * DAY;
    if (this.state.claims.length > 5000 || this.state.claims.some((c) => c.at < keep)) {
      this.state.claims = this.state.claims.filter((c) => c.at >= keep).slice(-5000);
      this.scheduleSave();
    }
    for (const [ip, list] of this.proxyHits) if (!list.some((t) => now - t < 60_000)) this.proxyHits.delete(ip);
  }

  // ─── 视图 ──────────────────────────────────────────────────

  private labelOf(a: string): string | undefined {
    const g = this.genesis;
    if (a === (this.keys.treasury?.address ?? g?.treasury)) return '公司金库';
    if (a === (this.keys.reserve?.address ?? g?.reserve)) return '生态储备';
    if (a === (this.keys.faucet?.address ?? g?.faucet)) return '水龙头';
    if (g && a === g.identity) return '验证节点';
    if (g && a === g.vote) return '节点投票账户';
    if (a === this.nodeStake) return '节点质押账户';
    if (PROGRAM_LABELS[a]) return PROGRAM_LABELS[a];
    if (isSysvar(a)) return '系统变量';
    const t = this.tokens.get(a);
    if (t) return `资产 · ${t.symbol}`;
    return undefined;
  }

  private tokenOut(t: ChainToken): ChainToken {
    const m = this.meta[t.mint];
    return { ...t, description: m?.description, image: `/chain/icon/${t.mint}`, mirror: this.isMirrorMint(t.mint) ? true : undefined };
  }

  private symbolOf(mint?: string) {
    return (mint && this.tokens.get(mint)?.symbol) || '代币';
  }

  /** 生成列表上显示的中文摘要（资产符号可能在交易之后才读到，所以每次输出时重新生成） */
  private decorate(tx: ChainTx): ChainTx {
    const sym = this.symbolOf(tx.mint);
    const v = tx.amount ? trimNum(tx.amount.value) : '';
    let title: string;
    switch (tx.kind) {
      case 'transfer':
        title = `转账 ${v} VK`;
        break;
      case 'faucet':
        title = `水龙头发放 ${v} VK`;
        break;
      case 'airdrop':
        title = `金库发放 ${v} VK`;
        break;
      case 'token-create':
        title = this.isMirrorMint(tx.mint) ? `创建公司资产凭证 ${sym}` : `发行资产 ${sym}${tx.amount ? ` · ${v}` : ''}`;
        break;
      case 'token-mint':
        title = this.isMirrorMint(tx.mint) ? `公司资产增加 +${v} ${MIRRORS[this.isMirrorMint(tx.mint)!].unit}` : `增发 ${v} ${sym}`;
        break;
      case 'token-transfer':
        title = `转账 ${v} ${sym}`;
        break;
      case 'token-burn':
        title = this.isMirrorMint(tx.mint) ? `公司资产减少 −${v} ${MIRRORS[this.isMirrorMint(tx.mint)!].unit}` : `销毁 ${v} ${sym}`;
        break;
      case 'token-authority':
        title = `${tx.ix.some((i) => i.t === 'setAuthority' && i.info?.newAuthority == null) ? '放弃增发权限' : '修改权限'} · ${sym}`;
        break;
      case 'account':
        title = '创建账户';
        break;
      case 'program':
        title = tx.ix.some((i) => /loader/i.test(i.p)) ? '部署程序' : '调用程序';
        break;
      default:
        title = '交易';
    }
    const amount = tx.amount ? { ...tx.amount, symbol: tx.amount.mint ? sym : VK_SYMBOL } : undefined;
    return { ...tx, title: tx.ok ? title : `${title}（失败）`, amount };
  }

  private parseTx(t: any, slot: number, time: number | null): ChainTx | null {
    const msg = t.transaction?.message;
    const meta = t.meta;
    if (!msg || !meta) return null;
    const keys: string[] = (msg.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k.pubkey));
    const loaded = meta.loadedAddresses ? [...(meta.loadedAddresses.writable ?? []), ...(meta.loadedAddresses.readonly ?? [])] : [];
    const all = [...keys, ...loaded];
    const top: any[] = msg.instructions ?? [];
    const inner: any[] = (meta.innerInstructions ?? []).flatMap((x: any) => x.instructions ?? []);
    const programs = new Set([...top, ...inner].map((i) => i.programId));

    // 代币账户 → 持有人 / 代币 / 小数位
    const tokAcct = new Map<string, { owner: string; mint: string; dec: number }>();
    const pre = new Map<number, any>();
    const post = new Map<number, any>();
    for (const b of meta.preTokenBalances ?? []) {
      pre.set(b.accountIndex, b);
      tokAcct.set(all[b.accountIndex], { owner: b.owner, mint: b.mint, dec: b.uiTokenAmount.decimals });
    }
    for (const b of meta.postTokenBalances ?? []) {
      post.set(b.accountIndex, b);
      tokAcct.set(all[b.accountIndex], { owner: b.owner, mint: b.mint, dec: b.uiTokenAmount.decimals });
    }
    const tokMap = new Map<string, { o: string; m: string; d: bigint; dec: number }>();
    for (const idx of new Set([...pre.keys(), ...post.keys()])) {
      const a = pre.get(idx);
      const b = post.get(idx);
      const ref = b ?? a;
      const d = BigInt(b?.uiTokenAmount.amount ?? '0') - BigInt(a?.uiTokenAmount.amount ?? '0');
      if (d === 0n) continue;
      const k = `${ref.owner}:${ref.mint}`;
      const cur = tokMap.get(k) ?? { o: ref.owner, m: ref.mint, d: 0n, dec: ref.uiTokenAmount.decimals };
      cur.d += d;
      tokMap.set(k, cur);
    }
    const tok = [...tokMap.values()].filter((x) => x.d !== 0n).map((x) => ({ o: x.o, m: x.m, d: rawToUi(x.d, x.dec), dec: x.dec }));
    const vk: { a: string; d: number }[] = [];
    (meta.preBalances ?? []).forEach((p: number, i: number) => {
      const d = (meta.postBalances?.[i] ?? p) - p;
      if (d !== 0) vk.push({ a: all[i], d });
    });

    const parsedOf = (i: any) => (i.parsed && typeof i.parsed === 'object' ? i.parsed : null);
    const tokenIxs = [...top, ...inner].filter((i) => i.program === 'spl-token' || i.program === 'spl-token-2022');
    const find = (types: string[]) => tokenIxs.find((i) => types.includes(parsedOf(i)?.type));
    let kind: ChainTxKind = 'other';
    let mint: string | undefined;
    let from: string | undefined;
    let to: string | undefined;
    let amount: ChainTx['amount'];
    const uiOf = (info: any, m?: string) => {
      if (info?.tokenAmount?.uiAmount != null) return Number(info.tokenAmount.uiAmountString ?? info.tokenAmount.uiAmount);
      const dec = info?.tokenAmount?.decimals ?? (m ? this.tokens.get(m)?.decimals : undefined) ?? tokAcct.get(info?.account ?? info?.source ?? '')?.dec ?? 0;
      return rawToUi(BigInt(info?.amount ?? '0'), dec);
    };
    let ix: any;
    if ((ix = find(['initializeMint', 'initializeMint2']))) {
      kind = 'token-create';
      mint = parsedOf(ix).info.mint;
      const mt = find(['mintTo', 'mintToChecked']);
      if (mt) amount = { value: uiOf(parsedOf(mt).info, mint), symbol: '', mint };
      from = msg.accountKeys?.[0]?.pubkey ?? keys[0];
    } else if ((ix = find(['mintTo', 'mintToChecked']))) {
      kind = 'token-mint';
      const info = parsedOf(ix).info;
      mint = info.mint;
      to = tokAcct.get(info.account)?.owner;
      amount = { value: uiOf(info, mint), symbol: '', mint };
    } else if ((ix = find(['transfer', 'transferChecked']))) {
      kind = 'token-transfer';
      const info = parsedOf(ix).info;
      mint = info.mint ?? tokAcct.get(info.source)?.mint ?? tokAcct.get(info.destination)?.mint;
      from = info.authority ?? info.multisigAuthority ?? tokAcct.get(info.source)?.owner;
      to = tokAcct.get(info.destination)?.owner;
      amount = { value: uiOf(info, mint), symbol: '', mint };
    } else if ((ix = find(['burn', 'burnChecked']))) {
      kind = 'token-burn';
      const info = parsedOf(ix).info;
      mint = info.mint ?? tokAcct.get(info.account)?.mint;
      from = info.authority ?? tokAcct.get(info.account)?.owner;
      amount = { value: uiOf(info, mint), symbol: '', mint };
    } else if ((ix = find(['setAuthority']))) {
      kind = 'token-authority';
      const info = parsedOf(ix).info;
      mint = info.mint ?? info.account;
      from = info.authority;
    } else {
      const sys = top.filter((i) => i.program === 'system' && parsedOf(i)?.type === 'transfer');
      if (sys.length) {
        const lamports = sys.reduce((s, i) => s + Number(parsedOf(i).info.lamports ?? 0), 0);
        from = parsedOf(sys[0]).info.source;
        to = sys.length === 1 ? parsedOf(sys[0]).info.destination : undefined;
        amount = { value: fmtVk(lamports), symbol: VK_SYMBOL };
        const g = this.genesis;
        kind = from === (this.keys.faucet?.address ?? g?.faucet) ? 'faucet' : from === (this.keys.treasury?.address ?? g?.treasury) || from === (this.keys.reserve?.address ?? g?.reserve) ? 'airdrop' : 'transfer';
      } else if (top.some((i) => i.program === 'system' && /^createAccount/.test(parsedOf(i)?.type ?? ''))) kind = 'account';
      else if ([...programs].some((p) => p !== SYSTEM_PROGRAM && p !== MEMO_PROGRAM && p !== 'ComputeBudget111111111111111111111111111111')) kind = 'program';
    }
    const memoIx = top.find((i) => i.program === 'spl-memo' || i.programId === MEMO_PROGRAM);
    const memo = memoIx && typeof memoIx.parsed === 'string' ? memoIx.parsed.slice(0, 200) : undefined;
    const compactInfo = (info: any) => {
      if (!info || typeof info !== 'object') return undefined;
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(info)) {
        if (v == null || typeof v !== 'object') o[k] = v;
        else if ((v as any).uiAmountString != null) o[k] = (v as any).uiAmountString;
      }
      return o;
    };
    const ixList = top.slice(0, 12).map((i) => {
      const p = i.program ?? PROGRAM_LABELS[i.programId] ?? i.programId;
      if (i.program === 'spl-memo') return { p, t: 'memo', info: { memo: typeof i.parsed === 'string' ? i.parsed : '' } };
      const pi = parsedOf(i);
      return { p, t: pi?.type ?? 'unknown', info: compactInfo(pi?.info) };
    });
    // 内部指令里的代币操作也记下来（例如发行时的 initializeMint 来自同一笔交易的顶层指令；这里补充 CPI 产生的）
    for (const i of inner.slice(0, 6)) {
      const pi = parsedOf(i);
      if (pi && (i.program === 'spl-token' || i.program === 'spl-token-2022') && ixList.length < 16) ixList.push({ p: i.program, t: pi.type, info: compactInfo(pi.info) });
    }
    // 只记钱包级别的地址（代币账户归到它的持有人名下，见 tok）
    const accounts = all.filter((a) => a && !programs.has(a) && !isSysvar(a) && !PROGRAM_LABELS[a] && !tokAcct.has(a));
    const err = meta.err ? explainChainError(meta.err, meta.logMessages) : undefined;
    return {
      sig: t.transaction.signatures[0],
      slot,
      time,
      ok: !meta.err,
      err,
      fee: meta.fee ?? 0,
      payer: keys[0],
      kind,
      title: '',
      amount,
      from,
      to,
      mint,
      memo,
      accounts: [...new Set(accounts)],
      vk,
      tok,
      ix: ixList,
    };
  }

  private allocation(): ChainAllocation[] {
    const g = this.genesis;
    const bal = (a?: string) => fmtVk(a ? (this.balances.get(a) ?? 0) : 0);
    const treasury = this.keys.treasury?.address ?? g?.treasury;
    const reserve = this.keys.reserve?.address ?? g?.reserve;
    const faucet = this.keys.faucet?.address ?? g?.faucet;
    const genesisSupply = g ? Number(BigInt(g.supply)) / LAMPORTS_PER_VK : 0;
    const reserveG = g ? Number(BigInt(g.reserveGenesis)) / LAMPORTS_PER_VK : 0;
    const faucetG = g ? Number(BigInt(g.faucetGenesis)) / LAMPORTS_PER_VK : 0;
    const node = [g?.identity, g?.vote, this.nodeStake].reduce((s, a) => s + bal(a), 0);
    const list: ChainAllocation[] = [
      { key: 'treasury', label: '公司金库', address: treasury, genesis: TREASURY_GENESIS_VK, balance: bal(treasury) },
      { key: 'reserve', label: '生态储备', address: reserve, genesis: reserveG, balance: bal(reserve) },
      { key: 'faucet', label: '水龙头', address: faucet, genesis: faucetG, balance: bal(faucet) },
      { key: 'node', label: '验证节点', address: g?.identity, genesis: NODE_GENESIS_VK, balance: node },
    ];
    if (g) list.push({ key: 'system', label: '系统账户（程序 / 系统变量）', genesis: Math.max(0, genesisSupply - TREASURY_GENESIS_VK - reserveG - faucetG - NODE_GENESIS_VK), balance: 0 });
    return list;
  }

  overview(): ChainOverview {
    const now = Date.now();
    const s0 = this.samples[0];
    const s1 = this.samples[this.samples.length - 1];
    const slotMs = s0 && s1 && s1[1] > s0[1] ? Math.round((s1[0] - s0[0]) / (s1[1] - s0[1])) : 400;
    const nowSec = Math.floor(now / 1000);
    const recentTxs = this.blocks.filter((b) => b.time != null && nowSec - b.time <= 60).reduce((s, b) => s + b.txs, 0);
    let tx24h = 0;
    for (let i = this.txs.length - 1; i >= 0; i--) {
      const t = this.txs[i].time;
      if (t != null && nowSec - t > 86_400) break;
      tx24h++;
    }
    const genesisLamports = this.genesis ? Number(BigInt(this.genesis.supply)) : this.totalSupply;
    const faucetAddr = this.keys.faucet?.address ?? this.genesis?.faucet;
    const st = this.state.settings;
    return {
      online: this.online,
      error: this.online ? undefined : this.lastError || '节点未连接',
      name: CHAIN_NAME,
      genesisHash: this.state.genesisHash || undefined,
      genesisAt: this.genesis?.createdAt,
      version: this.version || undefined,
      consensus: this.genesis?.consensus === 'alpenglow' || !this.genesis ? 'Alpenglow' : this.genesis.consensus ?? '',
      slot: this.slot,
      height: this.height,
      epoch: this.epoch.epoch,
      slotIndex: this.epoch.slotIndex,
      slotsInEpoch: this.epoch.slotsInEpoch,
      slotMs,
      tps: +(recentTxs / 60).toFixed(2),
      txTotal: this.txs.length,
      tx24h,
      addresses: [...this.byAddr.keys()].filter((a) => !this.tokens.has(a)).length,
      supply: { genesis: fmtVk(genesisLamports), total: fmtVk(this.totalSupply), burned: fmtVk(Math.max(0, genesisLamports - this.totalSupply)) },
      feePerSig: FEE_PER_SIG / LAMPORTS_PER_VK,
      gasTotal: fmtVk(this.state.gasTotal),
      blocks: this.blocks.slice(-24).reverse(),
      txs: this.txs.slice(-20).reverse().map((t) => this.decorate(t)),
      tokens: [...this.tokens.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 50).map((t) => this.tokenOut(t)),
      faucet: { enabled: st.faucetEnabled && !!this.keys.faucet, amount: st.faucetAmount, cooldownH: st.faucetCooldownH, once: st.faucetOnce, balance: faucetAddr ? fmtVk(this.balances.get(faucetAddr) ?? 0) : 0 },
      allocation: this.allocation(),
      rpcPath: CHAIN_RPC_PATH,
      mirror: this.mirrorView(),
      serverTime: now,
    };
  }

  private requireOnline() {
    if (!this.online) throw new ChainError('VK 链节点暂时连不上，请稍后再试', 503);
  }

  private txsOf(addr: string, limit = 60): ChainTx[] {
    const list = this.byAddr.get(addr) ?? [];
    return list
      .slice(-limit)
      .reverse()
      .map((i) => this.decorate(this.txs[i]));
  }

  private faucetNextAt(addr: string): number {
    if (this.state.settings.faucetOnce) return 0; // 只能领一次：看 claimedSet，不按时间
    const cd = this.state.settings.faucetCooldownH * 3600_000;
    const last = [...this.state.claims].reverse().find((c) => c.a === addr);
    return last && Date.now() - last.at < cd ? last.at + cd : 0;
  }

  async address(addr: string): Promise<ChainAddressView> {
    if (!isValidPubkey(addr)) throw new ChainError('地址格式不对');
    this.requireOnline();
    const [acct, t22, tk] = await this.rpc.batch([
      ['getAccountInfo', [addr, { encoding: 'jsonParsed', commitment: 'confirmed' }]],
      ['getTokenAccountsByOwner', [addr, { programId: TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]],
      ['getTokenAccountsByOwner', [addr, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]],
    ]);
    const v = acct.result?.value;
    const view: ChainAddressView = { address: addr, label: this.labelOf(addr), kind: 'new', vk: 0, tokens: [], txs: this.txsOf(addr) };
    if (v) {
      view.vk = fmtVk(v.lamports);
      view.owner = v.owner;
      view.executable = v.executable;
      view.space = v.space;
      const parsed = v.data?.parsed;
      if (v.executable) view.kind = 'program';
      else if (isSysvar(addr) || v.owner === 'Sysvar1111111111111111111111111111111111111') view.kind = 'sysvar';
      else if ((v.owner === TOKEN_2022_PROGRAM || v.owner === TOKEN_PROGRAM) && parsed?.type === 'mint') {
        view.kind = 'token';
        let t = this.tokens.get(addr);
        if (!t) {
          t = { mint: addr, program: 'token-2022', name: '', symbol: '', decimals: 0, supply: 0, mintAuthority: null, freezeAuthority: null };
          this.tokens.set(addr, t);
        }
        this.applyMintInfo(t, v);
        await this.refreshHolders(addr).catch(() => {});
        view.token = this.tokenOut(t);
        if (this.isMirrorMint(addr)) view.mirror = this.mirrorView();
      } else if ((v.owner === TOKEN_2022_PROGRAM || v.owner === TOKEN_PROGRAM) && parsed?.type === 'account') {
        view.kind = 'token-account';
        view.tokenAccount = { mint: parsed.info.mint, owner: parsed.info.owner, amount: Number(parsed.info.tokenAmount?.uiAmountString ?? 0) };
      } else view.kind = 'wallet';
    }
    for (const list of [t22.result?.value ?? [], tk.result?.value ?? []]) {
      for (const it of list) {
        const info = it.account?.data?.parsed?.info;
        if (!info) continue;
        const t = this.tokens.get(info.mint);
        view.tokens.push({
          mint: info.mint,
          account: it.pubkey,
          amount: Number(info.tokenAmount?.uiAmountString ?? 0),
          decimals: info.tokenAmount?.decimals ?? 0,
          program: it.account.owner === TOKEN_PROGRAM ? 'token' : 'token-2022',
          symbol: t?.symbol,
          name: t?.name,
          image: `/chain/icon/${info.mint}`,
        } satisfies ChainTokenBalance);
      }
    }
    view.tokens.sort((a, b) => b.amount - a.amount);
    if (view.kind === 'wallet' || view.kind === 'new') {
      view.faucetNextAt = this.faucetNextAt(addr);
      view.faucetClaimed = this.claimedSet.has(addr);
    }
    return view;
  }

  async tx(sig: string): Promise<ChainTxView> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw new ChainError('交易签名格式不对');
    const i = this.bySig.get(sig);
    let base: ChainTx | null = i != null ? this.txs[i] : null;
    let extra: Partial<ChainTxView> = {};
    if (this.online) {
      try {
        const t = await this.rpc.call<any>('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
        if (t) {
          base ??= this.parseTx(t, t.slot, t.blockTime ?? null);
          extra = { logs: t.meta?.logMessages ?? undefined, computeUnits: t.meta?.computeUnitsConsumed ?? undefined };
          const st = await this.rpc.call<any>('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
          extra.confirmations = st?.value?.[0]?.confirmationStatus ?? undefined;
        }
      } catch {
        /* 节点上已经清理掉了：用索引里的记录 */
      }
    }
    if (!base) throw new ChainError('找不到这笔交易（可能还没上链，或签名有误）', 404);
    return { ...this.decorate(base), ...extra };
  }

  async block(slot: number): Promise<ChainBlockView> {
    if (!Number.isInteger(slot) || slot < 0) throw new ChainError('区块号不对');
    this.requireOnline();
    let b: any;
    try {
      b = await this.rpc.call<any>('getBlock', [slot, BLOCK_OPTS]);
    } catch (e) {
      const code = (e as any).code;
      if (code === -32007) throw new ChainError(`区块 ${slot} 是空位（这个时间片没有出块）`, 404);
      if (slot > this.slot) throw new ChainError(`区块 ${slot} 还没产生（当前高度 ${this.slot}）`, 404);
      throw new ChainError(`区块 ${slot} 已经从节点上清理（节点只保留最近几小时的完整区块；交易记录仍可在 App 里查到）`, 404);
    }
    let votes = 0;
    const txList: ChainTx[] = [];
    let fees = 0;
    for (const t of b.transactions ?? []) {
      fees += t.meta?.fee ?? 0;
      if (this.isVote(t)) {
        votes++;
        continue;
      }
      const rec = this.parseTx(t, slot, b.blockTime ?? null);
      if (rec) txList.push(this.decorate(rec));
    }
    return { slot, height: b.blockHeight ?? null, time: b.blockTime ?? null, hash: b.blockhash, txs: txList.length, fees, parentSlot: b.parentSlot, previousBlockhash: b.previousBlockhash, txList, votes };
  }

  tokenList(): ChainToken[] {
    return [...this.tokens.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).map((t) => this.tokenOut(t));
  }

  /** 资产符号谁都能用（可能重名）：多个匹配时返回候选列表，按持有人多、发行早排序（防止被后来的同名资产冒充） */
  search(q: string): { type: 'block' | 'tx' | 'address' | 'tokens'; id: string; matches?: ChainToken[] } {
    const s = q.trim();
    if (/^\d{1,12}$/.test(s)) return { type: 'block', id: s };
    if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) return { type: 'tx', id: s };
    if (isValidPubkey(s)) return { type: 'address', id: s };
    const low = s.toLowerCase().replace(/^\$/, '');
    if (low) {
      const all = [...this.tokens.values()];
      const rank = (a: ChainToken, b: ChainToken) => (b.holders ?? 0) - (a.holders ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0);
      let hits = all.filter((x) => x.symbol.toLowerCase() === low);
      if (!hits.length) hits = all.filter((x) => x.name.toLowerCase().includes(low) || x.symbol.toLowerCase().includes(low));
      hits.sort(rank);
      if (hits.length === 1) return { type: 'address', id: hits[0].mint };
      if (hits.length > 1) return { type: 'tokens', id: '', matches: hits.slice(0, 10).map((t) => this.tokenOut(t)) };
    }
    throw new ChainError('没找到：可以输入地址、交易签名、区块号或资产符号', 404);
  }

  // ─── 交易：组装 / 发送 ─────────────────────────────────────

  private async rent(size: number): Promise<number> {
    let v = this.rentCache.get(size);
    if (v == null) {
      v = await this.rpc.call<number>('getMinimumBalanceForRentExemption', [size]);
      this.rentCache.set(size, v);
    }
    return v;
  }

  private async blockhash(): Promise<string> {
    return (await this.rpc.call<any>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  }

  private async lamportsOf(addr: string): Promise<number> {
    return (await this.rpc.call<any>('getBalance', [addr, { commitment: 'confirmed' }])).value ?? 0;
  }

  private async simulate(tx: Buffer) {
    const r = await this.rpc.call<any>('simulateTransaction', [tx.toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
    if (r.value?.err) throw new ChainError(explainChainError(r.value.err, r.value.logs));
  }

  private async mintInfo(mint: string): Promise<{ program: string; decimals: number; mintAuthority: string | null; symbol: string }> {
    if (!isValidPubkey(mint)) throw new ChainError('资产地址不对');
    const v = (await this.rpc.call<any>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
    if (!v || v.data?.parsed?.type !== 'mint') throw new ChainError('这不是 VK 链上的资产地址');
    const t = this.tokens.get(mint);
    return { program: v.owner, decimals: v.data.parsed.info.decimals, mintAuthority: v.data.parsed.info.mintAuthority ?? null, symbol: t?.symbol ?? '代币' };
  }

  private async sourceAccount(owner: string, mint: string, need: bigint, decimals: number, symbol: string): Promise<{ account: string; raw: bigint }> {
    const list = (await this.rpc.call<any>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value ?? [];
    let best: { account: string; raw: bigint } | null = null;
    for (const it of list) {
      const raw = BigInt(it.account.data.parsed.info.tokenAmount.amount);
      if (!best || raw > best.raw) best = { account: it.pubkey, raw };
    }
    if (!best || best.raw < need) throw new ChainError(`余额不足：只有 ${trimNum(rawToUi(best?.raw ?? 0n, decimals))} ${symbol}`);
    return best;
  }

  async prepare(body: any, origin: string): Promise<ChainPrepared> {
    this.requireOnline();
    const owner = String(body?.owner ?? '').trim();
    if (!isValidPubkey(owner)) throw new ChainError('钱包地址不对');
    const kind = String(body?.kind ?? '');
    const fee = FEE_PER_SIG / LAMPORTS_PER_VK;
    const balance = await this.lamportsOf(owner);
    const needVk = (lamports: number, what: string) => {
      if (balance < lamports) throw new ChainError(`VK 不够：${what}需要约 ${trimNum(lamports / LAMPORTS_PER_VK)} VK，钱包里只有 ${trimNum(balance / LAMPORTS_PER_VK)} VK（可以去水龙头领取）`);
    };
    const memo = typeof body?.memo === 'string' ? body.memo.slice(0, 120) : undefined;
    let tx: Buffer;
    let summary: string;
    let rent = 0;
    let mint: string | undefined;
    const warnings: string[] = [];

    if (kind === 'transfer') {
      const to = String(body?.to ?? '').trim();
      if (!isValidPubkey(to)) throw new ChainError('收款地址不对');
      if (to === owner) throw new ChainError('不能转给自己');
      const lamports = parseAmount(body?.amount, 9, '金额');
      needVk(Number(lamports) + FEE_PER_SIG, '转账加 gas ');
      const toBal = await this.lamportsOf(to);
      const min0 = await this.rent(0);
      if (toBal === 0 && Number(lamports) < min0) throw new ChainError(`这是新地址：第一次至少要转 ${min0 / LAMPORTS_PER_VK} VK（账户免租金押金）`);
      if (toBal === 0) warnings.push('收款地址在 VK 链上还没有记录（第一次收款）');
      tx = buildVkTransferTx({ from: owner, to, lamports, memo, blockhash: await this.blockhash() });
      summary = `转账 ${trimNum(rawToUi(lamports, 9))} VK → ${to.slice(0, 4)}…${to.slice(-4)}`;
    } else if (kind === 'token-create') {
      const name = String(body?.name ?? '').trim();
      const symbol = String(body?.symbol ?? '').trim().toUpperCase();
      const decimals = Number(body?.decimals ?? 0);
      if (!name || Buffer.byteLength(name) > 32) throw new ChainError('名称要 1–32 个字节（约 10 个汉字）');
      if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new ChainError('符号只能是 1–10 个英文字母或数字');
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new ChainError('小数位要在 0–9 之间');
      const amountRaw = parseAmount(body?.supply, decimals, '发行总量');
      const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 200) : undefined;
      let icon: Intent['icon'];
      if (typeof body?.icon === 'string' && body.icon) {
        const m = body.icon.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
        if (!m) throw new ChainError('图标要是 PNG / JPG / WebP / GIF 图片');
        const data = Buffer.from(m[2], 'base64');
        if (data.length > 300 * 1024) throw new ChainError('图标太大（最多 300KB）');
        icon = { data, ext: m[1] === 'jpeg' ? 'jpg' : m[1] };
      }
      const seed = 'vk' + crypto.randomBytes(8).toString('hex');
      const fixed = !!body?.fixed;
      // 地址先算出来，图标链接里要用
      const { mint: m0 } = buildCreateTokenTx({ owner, seed, name, symbol, uri: 'x', decimals, amountRaw, fixed, lamports: 0n, blockhash: '11111111111111111111111111111111' });
      mint = m0;
      const uri = `${origin.replace(/\/+$/, '')}/chain/meta/${mint}.json`;
      const mintRent = await this.rent(MINT_WITH_POINTER_LEN + metadataTlvLen(name, symbol, uri));
      const ataRent = await this.rent(170);
      rent = (mintRent + ataRent) / LAMPORTS_PER_VK;
      needVk(mintRent + ataRent + FEE_PER_SIG, '发行（押金 + gas）');
      tx = buildCreateTokenTx({ owner, seed, name, symbol, uri, decimals, amountRaw, fixed, lamports: BigInt(mintRent), blockhash: await this.blockhash() }).tx;
      summary = `发行资产 ${name}（${symbol}）· 总量 ${trimNum(rawToUi(amountRaw, decimals))}${fixed ? ' · 固定总量' : ' · 可增发'}`;
      this.intents.set(mint, { mint, owner, description, icon, expires: Date.now() + 15 * 60_000 });
    } else if (kind === 'token-transfer') {
      const to = String(body?.to ?? '').trim();
      if (!isValidPubkey(to)) throw new ChainError('收款地址不对');
      if (to === owner) throw new ChainError('不能转给自己');
      mint = String(body?.mint ?? '');
      const mi = await this.mintInfo(mint);
      const amountRaw = parseAmount(body?.amount, mi.decimals, '数量');
      const src = await this.sourceAccount(owner, mint, amountRaw, mi.decimals, mi.symbol);
      // 收款方填的是代币账户还是钱包地址
      const toInfo = (await this.rpc.call<any>('getAccountInfo', [to, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
      let dest: string;
      let createFor: string | undefined;
      if (toInfo && (toInfo.owner === TOKEN_PROGRAM || toInfo.owner === TOKEN_2022_PROGRAM)) {
        if (toInfo.data?.parsed?.type !== 'account' || toInfo.data.parsed.info.mint !== mint) throw new ChainError('收款地址是别的资产的账户，请填对方的钱包地址');
        dest = to;
      } else {
        dest = associatedTokenAddress(to, mint, mi.program);
        const exists = (await this.rpc.call<any>('getAccountInfo', [dest, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }])).value;
        if (!exists) {
          createFor = to;
          rent = (await this.rent(mi.program === TOKEN_PROGRAM ? 165 : 170)) / LAMPORTS_PER_VK;
          warnings.push(`对方还没有 ${mi.symbol} 账户：会顺便帮对方开一个（押金约 ${trimNum(rent)} VK，由你支付）`);
        }
      }
      needVk(Math.round(rent * LAMPORTS_PER_VK) + FEE_PER_SIG, '转账 gas ');
      tx = buildTokenTransferTx({ owner, source: src.account, mint, program: mi.program, dest, createFor, amountRaw, decimals: mi.decimals, memo, blockhash: await this.blockhash() });
      summary = `转账 ${trimNum(rawToUi(amountRaw, mi.decimals))} ${mi.symbol} → ${to.slice(0, 4)}…${to.slice(-4)}`;
    } else if (kind === 'token-mint') {
      mint = String(body?.mint ?? '');
      const mi = await this.mintInfo(mint);
      if (mi.mintAuthority !== owner) throw new ChainError(mi.mintAuthority ? '只有这个资产的增发权限地址才能增发' : '这个资产已经放弃增发权限，总量固定');
      const amountRaw = parseAmount(body?.amount, mi.decimals, '增发数量');
      const dest = associatedTokenAddress(owner, mint, mi.program);
      tx = buildMintToTx({ owner, mint, program: mi.program, dest, createFor: owner, amountRaw, decimals: mi.decimals, blockhash: await this.blockhash() });
      needVk(FEE_PER_SIG, 'gas ');
      summary = `增发 ${trimNum(rawToUi(amountRaw, mi.decimals))} ${mi.symbol}（到自己的钱包）`;
    } else if (kind === 'token-burn') {
      mint = String(body?.mint ?? '');
      const mi = await this.mintInfo(mint);
      const amountRaw = parseAmount(body?.amount, mi.decimals, '销毁数量');
      const src = await this.sourceAccount(owner, mint, amountRaw, mi.decimals, mi.symbol);
      tx = buildBurnTx({ owner, account: src.account, mint, program: mi.program, amountRaw, decimals: mi.decimals, blockhash: await this.blockhash() });
      needVk(FEE_PER_SIG, 'gas ');
      summary = `销毁 ${trimNum(rawToUi(amountRaw, mi.decimals))} ${mi.symbol}（总量永久减少）`;
    } else if (kind === 'token-renounce') {
      mint = String(body?.mint ?? '');
      const mi = await this.mintInfo(mint);
      if (mi.mintAuthority !== owner) throw new ChainError(mi.mintAuthority ? '只有增发权限地址才能放弃增发权限' : '已经放弃过了');
      tx = buildRenounceTx({ owner, mint, program: mi.program, blockhash: await this.blockhash() });
      needVk(FEE_PER_SIG, 'gas ');
      summary = `放弃 ${mi.symbol} 的增发权限：总量永久固定，无法撤销`;
    } else throw new ChainError('未知操作');

    await this.simulate(tx);
    return { tx: tx.toString('base64'), summary, fee, rent, mint, warnings: warnings.length ? warnings : undefined };
  }

  private async sendRaw(tx: Buffer): Promise<ChainSendResult> {
    if (tx.length > 1232) throw new ChainError('交易太大');
    const p = parseTx(tx);
    if (p.signatures.some((s) => s.every((x) => x === 0))) throw new ChainError('交易还没有签名');
    const sig = bs58encode(p.signatures[0]);
    try {
      await this.rpc.call('sendTransaction', [tx.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }], 15_000);
    } catch (e) {
      const data = (e as any).data;
      throw new ChainError(explainChainError(data?.err ?? (e as Error).message, data?.logs));
    }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const st = (await this.rpc.call<any>('getSignatureStatuses', [[sig]]).catch(() => null))?.value?.[0];
      if (!st) continue;
      if (st.err) return { sig, ok: false, err: explainChainError(st.err), slot: st.slot };
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
        this.kick();
        return { sig, ok: true, slot: st.slot };
      }
    }
    this.kick();
    return { sig, ok: false, err: '已广播，但 18 秒内没有确认（稍后可在浏览器里按签名查询）' };
  }

  /** 广播 App 内钱包签好的交易 */
  async send(b64: string): Promise<ChainSendResult> {
    this.requireOnline();
    let tx: Buffer;
    try {
      tx = Buffer.from(String(b64 ?? ''), 'base64');
    } catch {
      throw new ChainError('交易格式不对');
    }
    const p = parseTx(tx);
    const r = await this.sendRaw(tx);
    if (r.ok) {
      for (const a of p.accounts) {
        const it = this.intents.get(a);
        if (!it || !p.signers.includes(it.owner)) continue;
        this.intents.delete(a);
        const m: TokenMeta = { description: it.description };
        if (it.icon) {
          fs.writeFileSync(path.join(this.iconDir, `${it.mint}.${it.icon.ext}`), it.icon.data);
          m.icon = it.icon.ext;
        }
        this.meta[it.mint] = m;
        try {
          this.writeJson('meta.json', this.meta);
        } catch (e) {
          this.opts.warn?.('meta', e);
        }
      }
    }
    return r;
  }

  // ─── 水龙头 / 管理员 ───────────────────────────────────────

  async faucet(address: string, ip: string): Promise<ChainFaucetResult> {
    this.requireOnline();
    const st = this.state.settings;
    const kp = this.keys.faucet;
    if (!kp) throw new ChainError('服务器上没有水龙头私钥', 503);
    if (!st.faucetEnabled) throw new ChainError('水龙头已暂停发放');
    const a = String(address ?? '').trim();
    if (!isValidPubkey(a)) throw new ChainError('钱包地址不对');
    if (this.labelOf(a)) throw new ChainError('这个地址不能领取');
    if (st.faucetOnce && this.claimedSet.has(a)) throw new ChainError('这个钱包已经领过了：每个钱包只能领一次。需要更多 VK 请找管理员发放', 429);
    const next = this.faucetNextAt(a);
    if (next) throw new ChainError(`这个地址已经领过了，${Math.ceil((next - Date.now()) / 3600_000)} 小时后可以再领`, 429);
    const ik = ipKey(ip);
    const dayAgo = Date.now() - DAY;
    if (this.state.claims.filter((c) => c.ip === ik && c.at > dayAgo).length >= st.faucetPerIpPerDay) throw new ChainError('今天这个网络已经领了很多次，明天再来', 429);
    if (this.state.claims.filter((c) => c.at > dayAgo).length >= 2000) throw new ChainError('今天水龙头发放已达上限，明天再来', 429);
    if (this.pendingFaucet.has(a) || this.pendingFaucet.has(ik)) throw new ChainError('正在发放中，请稍等', 429);
    this.pendingFaucet.add(a);
    this.pendingFaucet.add(ik);
    try {
      const lamports = BigInt(Math.round(st.faucetAmount * LAMPORTS_PER_VK));
      const tx = signWith(buildVkTransferTx({ from: kp.address, to: a, lamports, memo: 'VK 水龙头', blockhash: await this.blockhash() }), kp);
      const r = await this.sendRaw(tx);
      if (!r.ok) throw new ChainError(r.err ?? '发放失败');
      const at = Date.now();
      this.state.claims.push({ a, ip: ik, at, amt: st.faucetAmount, sig: r.sig });
      if (!this.claimedSet.has(a)) {
        this.claimedSet.add(a);
        this.state.claimed.push(a);
      }
      this.scheduleSave();
      return { sig: r.sig, amount: st.faucetAmount, nextAt: st.faucetOnce ? 0 : at + st.faucetCooldownH * 3600_000 };
    } finally {
      this.pendingFaucet.delete(a);
      this.pendingFaucet.delete(ik);
    }
  }

  async admin(body: any): Promise<any> {
    const action = String(body?.action ?? '');
    if (action === 'settings') {
      const s = this.state.settings;
      if (typeof body.faucetEnabled === 'boolean') s.faucetEnabled = body.faucetEnabled;
      if (typeof body.faucetOnce === 'boolean') s.faucetOnce = body.faucetOnce;
      if (body.faucetAmount != null) {
        const v = Number(body.faucetAmount);
        if (!(v > 0 && v <= 100_000)) throw new ChainError('每次发放要在 0–100000 VK 之间');
        s.faucetAmount = +v.toFixed(9);
      }
      if (body.faucetCooldownH != null) {
        const v = Number(body.faucetCooldownH);
        if (!(v >= 0 && v <= 720)) throw new ChainError('冷却时间要在 0–720 小时之间');
        s.faucetCooldownH = v;
      }
      if (body.faucetPerIpPerDay != null) {
        const v = Math.round(Number(body.faucetPerIpPerDay));
        if (!(v >= 1 && v <= 1000)) throw new ChainError('每个网络每天的次数要在 1–1000 之间');
        s.faucetPerIpPerDay = v;
      }
      this.scheduleSave();
      return { ok: true, settings: s };
    }
    if (action === 'airdrop' || action === 'refill') {
      this.requireOnline();
      const fromKey = action === 'refill' ? 'treasury' : body.from === 'reserve' ? 'reserve' : 'treasury';
      const kp = this.keys[fromKey];
      if (!kp) throw new ChainError('服务器上没有这个账户的私钥', 503);
      const to = action === 'refill' ? this.keys.faucet?.address : String(body.to ?? '').trim();
      if (!to || !isValidPubkey(to)) throw new ChainError('收款地址不对');
      if (to === kp.address) throw new ChainError('不能转给自己');
      const lamports = parseAmount(body.amount, 9, '金额');
      const bal = await this.lamportsOf(kp.address);
      if (Number(lamports) + FEE_PER_SIG > bal) throw new ChainError(`余额不足：${fromKey === 'treasury' ? '金库' : '储备'}只有 ${trimNum(bal / LAMPORTS_PER_VK)} VK`);
      const memo = typeof body.memo === 'string' && body.memo.trim() ? body.memo.trim().slice(0, 60) : action === 'refill' ? '补充水龙头' : '金库发放';
      const tx = signWith(buildVkTransferTx({ from: kp.address, to, lamports, memo, blockhash: await this.blockhash() }), kp);
      const r = await this.sendRaw(tx);
      if (!r.ok) throw new ChainError(r.err ?? '发放失败');
      void this.refreshStats();
      return { ok: true, sig: r.sig };
    }
    throw new ChainError('未知操作');
  }

  private sampleCpu() {
    const dir = this.opts.cgroupDir;
    if (!dir) return;
    try {
      const usec = Number(/usage_usec (\d+)/.exec(fs.readFileSync(path.join(dir, 'cpu.stat'), 'utf8'))?.[1] ?? NaN);
      const at = Date.now();
      if (this.cpu && Number.isFinite(usec) && at > this.cpu.at) this.cpu = { at, usec, pct: Math.max(0, ((usec - this.cpu.usec) / 1000 / (at - this.cpu.at)) * 100) };
      else this.cpu = { at, usec };
    } catch {
      this.cpu = null;
    }
  }

  private nodeProc(): { memMB?: number; uptimeSec?: number; active: boolean } {
    const dir = this.opts.cgroupDir;
    if (!dir) return { active: this.online };
    try {
      const mem = Number(fs.readFileSync(path.join(dir, 'memory.current'), 'utf8'));
      const pid = fs.readFileSync(path.join(dir, 'cgroup.procs'), 'utf8').split('\n').find(Boolean);
      let uptimeSec: number | undefined;
      if (pid) {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const startTicks = Number(fields[19]);
        const btime = Number(/btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1]);
        if (startTicks && btime) uptimeSec = Math.max(0, Math.round(Date.now() / 1000 - (btime + startTicks / 100)));
      }
      return { memMB: Math.round(mem / 1048576), uptimeSec, active: !!pid };
    } catch {
      return { active: this.online };
    }
  }

  async adminView(): Promise<ChainAdminView> {
    const proc = this.nodeProc();
    let disk: { free?: number; total?: number } = {};
    try {
      const s = fs.statfsSync(this.dir);
      disk = { free: +((s.bavail * s.bsize) / 1e9).toFixed(1), total: +((s.blocks * s.bsize) / 1e9).toFixed(1) };
    } catch {
      /* ignore */
    }
    const keys: ChainAdminView['keys'] = [];
    for (const [k, label] of [
      ['treasury', '公司金库'],
      ['faucet', '水龙头'],
      ['reserve', '生态储备'],
    ] as const) {
      const kp = this.keys[k];
      const addr = kp?.address ?? this.genesis?.[k];
      if (addr) keys.push({ key: k, label, address: addr, vk: fmtVk(this.balances.get(addr) ?? 0), loaded: !!kp });
    }
    const dayAgo = Date.now() - DAY;
    const claims = this.state.claims;
    return {
      node: {
        active: proc.active,
        memMB: proc.memMB,
        cpuPct: this.cpu?.pct != null ? Math.round(this.cpu.pct) : undefined,
        uptimeSec: proc.uptimeSec,
        diskFreeGB: disk.free,
        diskTotalGB: disk.total,
        identity: this.genesis?.identity,
        version: this.version || undefined,
        rpc: this.opts.rpcUrl,
      },
      keys,
      faucet: {
        enabled: this.state.settings.faucetEnabled,
        amount: this.state.settings.faucetAmount,
        cooldownH: this.state.settings.faucetCooldownH,
        perIpPerDay: this.state.settings.faucetPerIpPerDay,
        once: this.state.settings.faucetOnce,
        claimedAddresses: this.claimedSet.size,
        claimsToday: claims.filter((c) => c.at > dayAgo).length,
        claimsTotal: claims.length,
        givenTotal: +claims.reduce((s, c) => s + c.amt, 0).toFixed(9),
      },
      index: { lastSlot: this.state.lastSlot, behind: Math.max(0, this.slot - this.state.lastSlot), txs: this.txs.length, tokens: this.tokens.size },
      recentClaims: claims
        .slice(-20)
        .reverse()
        .map((c) => ({ address: c.a, amount: c.amt, at: c.at, sig: c.sig })),
    };
  }

  // ─── 公开接口：RPC 代理 / 资产元数据 / 图标 ─────────────────

  private proxyAllowed(ip: string, cost = 1): boolean {
    const now = Date.now();
    const list = (this.proxyHits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (list.length + cost > 600) {
      this.proxyHits.set(ip, list);
      return false;
    }
    for (let i = 0; i < cost; i++) list.push(now);
    this.proxyHits.set(ip, list);
    return true;
  }

  /** App 内的 /api/chain/* 接口（需要查看权限；POST 的限频在 index.ts 里做） */
  async api(p: string, q: URLSearchParams, body: any, ip: string, origin: string): Promise<unknown> {
    switch (p) {
      case '/api/chain/overview':
        return this.overview();
      case '/api/chain/address':
        return this.address(String(q.get('a') ?? '').trim());
      case '/api/chain/tx':
        return this.tx(String(q.get('sig') ?? '').trim());
      case '/api/chain/block':
        return this.block(Number(q.get('slot')));
      case '/api/chain/tokens':
        return this.tokenList();
      case '/api/chain/search':
        return this.search(String(q.get('q') ?? ''));
      case '/api/chain/prepare':
        if (!body) throw new ChainError('Method Not Allowed', 405);
        return this.prepare(body, origin);
      case '/api/chain/send':
        if (!body) throw new ChainError('Method Not Allowed', 405);
        return this.send(body.tx);
      case '/api/chain/faucet':
        if (!body) throw new ChainError('Method Not Allowed', 405);
        return this.faucet(body.address, ip);
      default:
        throw new ChainError('Not Found', 404);
    }
  }

  /** 处理 /chain/* 请求；不是这个前缀时返回 false */
  async handlePublic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, ip: string, origin: string): Promise<boolean> {
    const readBody = () => readRaw(req);
    if (!pathname.startsWith('/chain/')) return false;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '86400' };
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors, ...extra });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return true;
    }
    if (pathname === CHAIN_RPC_PATH) {
      if (req.method === 'GET')
        return (json(200, { name: CHAIN_NAME, nativeToken: VK_SYMBOL, decimals: 9, rpc: `${origin}${CHAIN_RPC_PATH}`, websocket: `${origin.replace(/^http/, 'ws')}${CHAIN_RPC_PATH}`, genesisHash: this.state.genesisHash, online: this.online }), true);
      if (req.method !== 'POST') return (json(405, { error: 'Method Not Allowed' }), true);
      let raw: string;
      try {
        raw = await readBody();
      } catch (e) {
        return (json(413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: (e as Error).message } }), true);
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return (json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), true);
      }
      const list: any[] = Array.isArray(parsed) ? parsed : [parsed];
      if (!list.length || list.length > 20) return (json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch size must be 1-20' } }), true);
      // 扫描类请求（getProgramAccounts 等）按 20 次计
      const cost = list.reduce((s, it) => s + (/^(getProgramAccounts|getLargestAccounts|getTokenLargestAccounts|simulateTransaction)$/.test(String(it?.method)) ? 20 : 1), 0);
      if (!this.proxyAllowed(ip, cost)) return (json(429, { jsonrpc: '2.0', id: null, error: { code: 429, message: 'Too many requests' } }), true);
      for (const it of list) {
        const m = String(it?.method ?? '');
        if (!RPC_ALLOW.has(m)) {
          const message = m === 'requestAirdrop' ? 'requestAirdrop is disabled: use the faucet in the VectorKeith app (VK 链 → 钱包 → 领取 VK)' : `Method not allowed on public RPC: ${m}`;
          const err = { jsonrpc: '2.0', id: it?.id ?? null, error: { code: -32601, message } };
          return (json(200, Array.isArray(parsed) ? list.map((x) => (x === it ? err : { jsonrpc: '2.0', id: x?.id ?? null, error: { code: -32600, message: 'Batch rejected' } })) : err), true);
        }
      }
      try {
        const r = await this.rpc.raw(raw);
        return (json(r.status, r.text), true);
      } catch {
        return (json(503, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'VK Chain node unavailable' } }), true);
      }
    }
    let m = /^\/chain\/meta\/([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(pathname);
    if (m && req.method === 'GET') {
      const t = this.tokens.get(m[1]);
      if (!t) return (json(404, { error: 'unknown token' }), true);
      return (json(200, { name: t.name, symbol: t.symbol, description: this.meta[t.mint]?.description ?? `${t.name} — issued on ${CHAIN_NAME}`, image: `${origin}/chain/icon/${t.mint}` }, { 'Cache-Control': 'public, max-age=300' }), true);
    }
    m = /^\/chain\/icon\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(pathname);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const mint = m[1];
      const ext = this.meta[mint]?.icon;
      if (ext && ICON_TYPES[ext]) {
        try {
          const data = fs.readFileSync(path.join(this.iconDir, `${mint}.${ext}`));
          res.writeHead(200, { 'Content-Type': ICON_TYPES[ext], 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', ...cors });
          res.end(req.method === 'HEAD' ? undefined : data);
          return true;
        } catch {
          /* 文件丢了：用字母头像 */
        }
      }
      const t = this.tokens.get(mint);
      const letter = (t?.symbol || '?').slice(0, 2).replace(/[<>&"']/g, '');
      const h = crypto.createHash('sha256').update(mint).digest();
      const hue = h[0] * 1.4;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue.toFixed(0)},80%,55%)"/><stop offset="1" stop-color="hsl(${((hue + 60) % 360).toFixed(0)},80%,40%)"/></linearGradient></defs><circle cx="32" cy="32" r="32" fill="url(#g)"/><text x="32" y="41" font-family="Arial,Helvetica,sans-serif" font-size="${letter.length > 1 ? 22 : 28}" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=600', 'X-Content-Type-Options': 'nosniff', ...cors });
      res.end(req.method === 'HEAD' ? undefined : svg);
      return true;
    }
    json(404, { error: 'Not Found' });
    return true;
  }

  /** WebSocket 订阅代理（外部钱包 / 命令行用来等交易确认） */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, ip: string) {
    const n = this.wsPerIp.get(ip) ?? 0;
    if (n >= 8 || this.wss.clients.size >= 200) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).ip = ip;
      this.wss.emit('connection', ws, req);
    });
  }

  private onProxySocket(ws: WebSocket, _req: http.IncomingMessage) {
    const ip: string = (ws as any).ip ?? '';
    this.wsPerIp.set(ip, (this.wsPerIp.get(ip) ?? 0) + 1);
    const upstream = new WebSocket(this.opts.wsUrl);
    const queue: string[] = [];
    let subs = 0;
    let hits: number[] = [];
    upstream.on('open', () => {
      for (const m of queue.splice(0)) upstream.send(m);
    });
    upstream.on('message', (data) => {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(data.toString());
    });
    const closeBoth = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    };
    upstream.on('close', closeBoth);
    upstream.on('error', closeBoth);
    ws.on('close', () => {
      this.wsPerIp.set(ip, Math.max(0, (this.wsPerIp.get(ip) ?? 1) - 1));
      closeBoth();
    });
    ws.on('error', closeBoth);
    ws.on('message', (raw) => {
      const now = Date.now();
      hits = hits.filter((t) => now - t < 10_000);
      hits.push(now);
      if (hits.length > 60) return ws.close(1008, 'rate limit');
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const method = String(msg?.method ?? '');
      if (!WS_ALLOW.has(method)) return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32601, message: `Method not allowed: ${method}` } }));
      if (method.endsWith('Subscribe') && ++subs > 30) return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32000, message: 'Too many subscriptions' } }));
      const text = JSON.stringify(msg);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else if (queue.length < 20) queue.push(text);
    });
  }
}
