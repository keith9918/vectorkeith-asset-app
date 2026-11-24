// Solana 底层工具：Base58 / PDA / 账户与事件解码（零重依赖，PDA 已对链上地址核实）
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ATA_PROGRAM, PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL_MINT } from '../shared/constants';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function bs58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

export function bs58decode(str: string): Uint8Array {
  let n = 0n;
  for (const c of str) {
    const v = ALPHABET_MAP.get(c);
    if (v === undefined) throw new Error(`非法 base58 字符: ${c}`);
    n = n * 58n + v;
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of str) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export function isValidPubkey(s: string): boolean {
  try {
    return bs58decode(s).length === 32;
  } catch {
    return false;
  }
}

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

export function findProgramAddress(seeds: Uint8Array[], programId: string): [string, number] {
  const program = bs58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, PDA_MARKER];
    const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const hash = sha256(buf);
    if (!isOnCurve(hash)) return [bs58encode(hash), bump];
  }
  throw new Error('无法找到 PDA');
}

const te = new TextEncoder();
export const bondingCurveAddress = (mint: string) =>
  findProgramAddress([te.encode('bonding-curve'), bs58decode(mint)], PUMP_PROGRAM)[0];
export const creatorVaultAddress = (creator: string) =>
  findProgramAddress([te.encode('creator-vault'), bs58decode(creator)], PUMP_PROGRAM)[0];
const ataCache = new Map<string, string>();
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  const key = `${owner}:${mint}:${tokenProgram}`;
  let v = ataCache.get(key);
  if (!v) {
    v = findProgramAddress([bs58decode(owner), bs58decode(tokenProgram), bs58decode(mint)], ATA_PROGRAM)[0];
    ataCache.set(key, v);
  }
  return v;
}

// ─── 解码 ─────────────────────────────────────────────────────

class Reader {
  o = 0;
  constructor(private b: Buffer) {}
  u8() {
    return this.b[this.o++];
  }
  bool() {
    return this.u8() !== 0;
  }
  u64() {
    const v = this.b.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  i64() {
    const v = this.b.readBigInt64LE(this.o);
    this.o += 8;
    return v;
  }
  pubkey() {
    const v = bs58encode(this.b.subarray(this.o, this.o + 32));
    this.o += 32;
    return v;
  }
  get remaining() {
    return this.b.length - this.o;
  }
}

const TOKEN_UNIT = 1e6;
const LAMPORTS = 1e9;

export interface RawCurve {
  virtualTokenReserves: number;
  virtualSolReserves: number;
  realTokenReserves: number;
  realSolReserves: number;
  tokenTotalSupply: number;
  complete: boolean;
  creator: string;
}

/** pump.fun BondingCurve 账户（discriminator 17b7f83760d8ac60） */
export function decodeBondingCurve(data: Buffer, decimals = 6): RawCurve {
  const unit = 10 ** decimals;
  const r = new Reader(data);
  r.o = 8;
  const vt = r.u64();
  const vs = r.u64();
  const rt = r.u64();
  const rs = r.u64();
  const sup = r.u64();
  const complete = r.bool();
  const creator = r.remaining >= 32 ? r.pubkey() : '';
  return {
    virtualTokenReserves: Number(vt) / unit,
    virtualSolReserves: Number(vs) / LAMPORTS,
    realTokenReserves: Number(rt) / unit,
    realSolReserves: Number(rs) / LAMPORTS,
    tokenTotalSupply: Number(sup) / unit,
    complete,
    creator,
  };
}

/** SPL Token / Token-2022 账户前 72 字节布局相同：mint(32) owner(32) amount(u64) */
export function decodeTokenAccount(data: Buffer): { mint: string; owner: string; amountRaw: bigint } | null {
  if (data.length < 72) return null;
  return {
    mint: bs58encode(data.subarray(0, 32)),
    owner: bs58encode(data.subarray(32, 64)),
    amountRaw: data.readBigUInt64LE(64),
  };
}

export interface TradeEvent {
  venue: 'curve' | 'amm';
  mint: string;
  solAmount: number;
  tokenAmount: number;
  isBuy: boolean;
  user: string;
  timestamp: number;
  virtualSolReserves: number;
  virtualTokenReserves: number;
  realSolReserves: number;
  realTokenReserves: number;
  feeBps: number;
  fee: number;
  creator: string;
  creatorFeeBps: number;
  creatorFee: number;
}

const TRADE_EVENT_DISC = 'bddb7fd34ee661ee';
const PROGRAM_DATA = 'Program data: ';

export function decodeTradeEvent(b: Buffer, decimals = 6): TradeEvent | null {
  if (b.length < 129 || b.subarray(0, 8).toString('hex') !== TRADE_EVENT_DISC) return null;
  const unit = 10 ** decimals;
  const r = new Reader(b);
  r.o = 8;
  const ev: TradeEvent = {
    venue: 'curve',
    mint: r.pubkey(),
    solAmount: Number(r.u64()) / LAMPORTS,
    tokenAmount: Number(r.u64()) / unit,
    isBuy: r.bool(),
    user: r.pubkey(),
    timestamp: Number(r.i64()),
    virtualSolReserves: Number(r.u64()) / LAMPORTS,
    virtualTokenReserves: Number(r.u64()) / unit,
    realSolReserves: Number(r.u64()) / LAMPORTS,
    realTokenReserves: Number(r.u64()) / unit,
    feeBps: 0,
    fee: 0,
    creator: '',
    creatorFeeBps: 0,
    creatorFee: 0,
  };
  // 新版事件追加了手续费字段（旧版没有，读不到就保持 0）
  if (r.remaining >= 32 + 8 + 8 + 32 + 8 + 8) {
    r.pubkey(); // fee_recipient
    ev.feeBps = Number(r.u64());
    ev.fee = Number(r.u64()) / LAMPORTS;
    ev.creator = r.pubkey();
    ev.creatorFeeBps = Number(r.u64());
    ev.creatorFee = Number(r.u64()) / LAMPORTS;
  }
  return ev;
}

/** 从交易日志中提取属于指定 mint 的 TradeEvent（保持日志顺序） */
// ─── 销毁交易（只组装、不签名：由用户自己的钱包签名发送） ─────────

/** Solana compact-u16（shortvec）长度编码 */
function shortvec(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return Buffer.from(out);
    }
    out.push(b | 0x80);
  }
}

/**
 * 组装一笔只含 BurnChecked 指令的 legacy 交易（签名位留空）。
 * 账户顺序：owner（付手续费 + 签名）、代币账户（可写）、mint（可写，总量减少）、代币程序（只读）。
 * BurnChecked 在 SPL Token 与 Token-2022 中都是指令 15，数据 = [15, amount u64 LE, decimals u8]。
 */
export function buildBurnCheckedTx(p: {
  owner: string;
  tokenAccount: string;
  mint: string;
  tokenProgram: string;
  amountRaw: bigint;
  decimals: number;
  blockhash: string;
}): Buffer {
  const keys = [p.owner, p.tokenAccount, p.mint, p.tokenProgram].map((k) => Buffer.from(bs58decode(k)));
  if (keys.some((k) => k.length !== 32)) throw new Error('地址格式错误');
  const header = Buffer.from([1, 0, 1]); // 1 个签名者、0 个只读签名者、1 个只读非签名账户（代币程序）
  const data = Buffer.alloc(10);
  data[0] = 15;
  data.writeBigUInt64LE(p.amountRaw, 1);
  data[9] = p.decimals;
  const ix = Buffer.concat([Buffer.from([3]), shortvec(3), Buffer.from([1, 2, 0]), shortvec(data.length), data]);
  const blockhash = Buffer.from(bs58decode(p.blockhash));
  if (blockhash.length !== 32) throw new Error('blockhash 格式错误');
  const message = Buffer.concat([header, shortvec(keys.length), ...keys, blockhash, shortvec(1), ix]);
  return Buffer.concat([shortvec(1), Buffer.alloc(64), message]);
}

// ─── PumpSwap（毕业后的 AMM 池子） ─────────────────────────────

/** 毕业时 pump.fun 创建的标准池子：pool-authority PDA → pool PDA（已与链上地址核对） */
export function pumpSwapPoolAddress(mint: string): string {
  const [authority] = findProgramAddress([te.encode('pool-authority'), bs58decode(mint)], PUMP_PROGRAM);
  return findProgramAddress(
    [te.encode('pool'), new Uint8Array(2), bs58decode(authority), bs58decode(mint), bs58decode(WSOL_MINT)],
    PUMP_AMM_PROGRAM,
  )[0];
}

export interface PumpSwapPool {
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  baseVault: string;
  quoteVault: string;
  coinCreator: string;
}

/** Pool 账户：8 判别符 + bump(u8) + index(u16) + creator + base_mint + quote_mint + lp_mint + 两个金库 + lp_supply + coin_creator */
export function decodePumpSwapPool(data: Buffer): PumpSwapPool | null {
  if (data.length < 211) return null;
  const at = (o: number) => bs58encode(data.subarray(o, o + 32));
  return {
    baseMint: at(43),
    quoteMint: at(75),
    lpMint: at(107),
    baseVault: at(139),
    quoteVault: at(171),
    coinCreator: data.length >= 243 ? at(211) : '',
  };
}

const AMM_BUY_DISC = '67f4521f2cf57777'; // sha256("event:BuyEvent")[0..8]
const AMM_SELL_DISC = '3e2f370aa503dc2a'; // sha256("event:SellEvent")[0..8]

/**
 * PumpSwap BuyEvent / SellEvent。事件里的池子储备是成交前的金库余额；
 * 成交后余额 = 买入：代币 − 买到的数量，SOL + 付入金额；卖出：代币 + 卖出数量，SOL − 用户到手金额
 * （已逐笔对照链上金库余额核实）。
 */
export function decodeSwapEvent(b: Buffer, pool: string, mint: string, decimals = 6): TradeEvent | null {
  const disc = b.subarray(0, 8).toString('hex');
  const isBuy = disc === AMM_BUY_DISC;
  if (!isBuy && disc !== AMM_SELL_DISC) return null;
  const o = 8;
  if (b.length < o + 176) return null;
  if (bs58encode(b.subarray(o + 112, o + 144)) !== pool) return null;
  const u = (x: number) => b.readBigUInt64LE(o + x);
  const unit = 10 ** decimals;
  const baseAmt = u(8);
  const poolBase = u(40);
  const poolQuote = u(48);
  const quoteIn = u(56); // 买入：进入池子的 SOL
  const quoteOut = u(104); // 卖出：用户到手的 SOL
  const postBase = isBuy ? poolBase - baseAmt : poolBase + baseAmt;
  const postQuote = isBuy ? poolQuote + quoteIn : poolQuote > quoteOut ? poolQuote - quoteOut : 0n;
  const hasCreator = b.length >= o + 352;
  return {
    venue: 'amm',
    mint,
    solAmount: Number(isBuy ? quoteIn : quoteOut) / LAMPORTS,
    tokenAmount: Number(baseAmt) / unit,
    isBuy,
    user: bs58encode(b.subarray(o + 144, o + 176)),
    timestamp: Number(b.readBigInt64LE(o)),
    virtualSolReserves: Number(postQuote) / LAMPORTS,
    virtualTokenReserves: Number(postBase) / unit,
    realSolReserves: Number(postQuote) / LAMPORTS,
    realTokenReserves: Number(postBase) / unit,
    feeBps: Number(u(64) + u(80)), // LP 费 + 协议费
    fee: Number(u(72) + u(88)) / LAMPORTS,
    creator: hasCreator ? bs58encode(b.subarray(o + 304, o + 336)) : '',
    creatorFeeBps: hasCreator ? Number(u(336)) : 0,
    creatorFee: hasCreator ? Number(u(344)) / LAMPORTS : 0,
  };
}

/** 从交易日志中提取该代币的成交（内盘 TradeEvent + 指定 PumpSwap 池子的 Buy/SellEvent），保持日志顺序 */
export function parseTradeEvents(logs: string[] | null | undefined, mint: string, decimals = 6, pool?: string): TradeEvent[] {
  const out: TradeEvent[] = [];
  if (!logs) return out;
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA)) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(PROGRAM_DATA.length), 'base64');
    } catch {
      continue;
    }
    const ev = decodeTradeEvent(buf, decimals) ?? (pool ? decodeSwapEvent(buf, pool, mint, decimals) : null);
    if (ev && ev.mint === mint) out.push(ev);
  }
  return out;
}

export const TOKEN_DECIMALS_UNIT = TOKEN_UNIT;
