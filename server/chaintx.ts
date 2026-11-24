// ───────────────────────────────────────────────────────────────
//  VK 链交易组装（未签名）+ 服务器端签名（只用于水龙头 / 金库发放）
//  · 发行资产：Token-2022 + 元数据扩展（名称 / 符号 / 图标链接直接写在代币账户里）
//      createAccountWithSeed → InitializeMetadataPointer → InitializeMint2 → TokenMetadata::Initialize
//      → 创建自己的关联代币账户 → MintToChecked →（可选）放弃增发权限
//    代币地址由"钱包地址 + 种子"推导，只需要钱包自己签名
//  · 转账（VK / 代币，可带备注）、增发、销毁、放弃增发权限
// ───────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import fs from 'node:fs';
import { MEMO_PROGRAM } from '../shared/chain';
import { ATA_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../shared/constants';
import { associatedTokenAddress, bs58decode, bs58encode } from './solana';
import { addressWithSeed, compileTx } from './staketx';

interface Meta {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}
interface Ix {
  program: string;
  keys: Meta[];
  data: Buffer;
}

const key = (s: string) => {
  const b = Buffer.from(bs58decode(s));
  if (b.length !== 32) throw new Error(`地址格式错误：${s}`);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const borshStr = (s: string) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(b.length), b]);
};
const w = (pubkey: string, signer = false): Meta => ({ pubkey, signer, writable: true });
const r = (pubkey: string, signer = false): Meta => ({ pubkey, signer, writable: false });

/** Mint(82) 补齐到 165 + 账户类型(1) + MetadataPointer 扩展(2+2+64) */
export const MINT_WITH_POINTER_LEN = 234;
/** TokenMetadata 扩展的 TLV 长度：类型(2) + 长度(2) + 更新权限(32) + mint(32) + 三个字符串 + 附加字段 vec(4) */
export function metadataTlvLen(name: string, symbol: string, uri: string): number {
  return 4 + 32 + 32 + 4 + Buffer.byteLength(name) + 4 + Buffer.byteLength(symbol) + 4 + Buffer.byteLength(uri) + 4;
}
/** spl-token-metadata-interface 的指令判别符：sha256("spl_token_metadata_interface:initialize_account") 前 8 字节 */
const META_INIT_DISC = crypto.createHash('sha256').update('spl_token_metadata_interface:initialize_account').digest().subarray(0, 8);

export const tokenProgramId = (p: 'token' | 'token-2022') => (p === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);

function createAtaIdempotent(payer: string, ata: string, owner: string, mint: string, program: string): Ix {
  return {
    program: ATA_PROGRAM,
    keys: [w(payer, true), w(ata), r(owner), r(mint), r(SYSTEM_PROGRAM), r(program)],
    data: Buffer.from([1]), // CreateIdempotent：已存在就跳过
  };
}

function memoIx(signer: string, memo?: string): Ix[] {
  const m = (memo ?? '').trim();
  if (!m) return [];
  const data = Buffer.from(m, 'utf8');
  if (data.length > 180) throw new Error('备注太长（最多约 60 个汉字）');
  return [{ program: MEMO_PROGRAM, keys: [r(signer, true)], data }];
}

export function buildCreateTokenTx(p: {
  owner: string;
  seed: string;
  name: string;
  symbol: string;
  uri: string;
  decimals: number;
  amountRaw: bigint;
  fixed: boolean;
  lamports: bigint;
  blockhash: string;
}): { tx: Buffer; mint: string; ata: string } {
  const program = TOKEN_2022_PROGRAM;
  const mint = addressWithSeed(p.owner, p.seed, program);
  const ata = associatedTokenAddress(p.owner, mint, program);
  const seed = Buffer.from(p.seed, 'utf8');
  if (seed.length > 32) throw new Error('seed 太长');
  const ixs: Ix[] = [
    {
      program: SYSTEM_PROGRAM,
      keys: [w(p.owner, true), w(mint)],
      // SystemInstruction::CreateAccountWithSeed { base, seed, lamports, space, owner }
      data: Buffer.concat([u32(3), key(p.owner), u64(BigInt(seed.length)), seed, u64(p.lamports), u64(BigInt(MINT_WITH_POINTER_LEN)), key(program)]),
    },
    // MetadataPointerExtension(39)::Initialize(0) { authority, metadata_address = mint 自己 }
    { program, keys: [w(mint)], data: Buffer.concat([Buffer.from([39, 0]), key(p.owner), key(mint)]) },
    // InitializeMint2(20) { decimals, mint_authority, freeze_authority = None }
    { program, keys: [w(mint)], data: Buffer.concat([Buffer.from([20, p.decimals]), key(p.owner), Buffer.from([0])]) },
    // TokenMetadata::Initialize { name, symbol, uri }：账户 [metadata(=mint), 更新权限, mint, 增发权限(签名)]
    {
      program,
      keys: [w(mint), r(p.owner), r(mint), r(p.owner, true)],
      data: Buffer.concat([META_INIT_DISC, borshStr(p.name), borshStr(p.symbol), borshStr(p.uri)]),
    },
    createAtaIdempotent(p.owner, ata, p.owner, mint, program),
    // MintToChecked(14) { amount, decimals }
    { program, keys: [w(mint), w(ata), r(p.owner, true)], data: Buffer.concat([Buffer.from([14]), u64(p.amountRaw), Buffer.from([p.decimals])]) },
  ];
  if (p.fixed) ixs.push(setAuthorityIx(mint, p.owner, program));
  return { tx: compileTx(p.owner, ixs, p.blockhash), mint, ata };
}

/** SetAuthority(6) { MintTokens(0), new_authority = None }：放弃增发权限，总量从此固定 */
function setAuthorityIx(mint: string, owner: string, program: string): Ix {
  return { program, keys: [w(mint), r(owner, true)], data: Buffer.from([6, 0, 0]) };
}

// ─── 公司资产凭证（镜像资产）：不可转让，总量随公司真实 SOL 余额增减 ─────

/** Mint(82→165) + 账户类型(1) + MetadataPointer(2+2+64) + NonTransferable(2+2+0) */
export const MINT_MIRROR_LEN = 238;

/** 创建凭证资产：地址由金库地址 + 固定种子推导（每条链只有一个），增发权限和元数据更新权限都是金库 */
export function buildCreateMirrorTx(p: { authority: string; seed: string; name: string; symbol: string; uri: string; decimals: number; lamports: bigint; blockhash: string }): { tx: Buffer; mint: string; ata: string } {
  const program = TOKEN_2022_PROGRAM;
  const mint = addressWithSeed(p.authority, p.seed, program);
  const ata = associatedTokenAddress(p.authority, mint, program);
  const seed = Buffer.from(p.seed, 'utf8');
  const ixs: Ix[] = [
    {
      program: SYSTEM_PROGRAM,
      keys: [w(p.authority, true), w(mint)],
      data: Buffer.concat([u32(3), key(p.authority), u64(BigInt(seed.length)), seed, u64(p.lamports), u64(BigInt(MINT_MIRROR_LEN)), key(program)]),
    },
    // InitializeNonTransferableMint(32)：这个资产的所有账户都不能转出（只能由持有人销毁）
    { program, keys: [w(mint)], data: Buffer.from([32]) },
    { program, keys: [w(mint)], data: Buffer.concat([Buffer.from([39, 0]), key(p.authority), key(mint)]) },
    { program, keys: [w(mint)], data: Buffer.concat([Buffer.from([20, p.decimals]), key(p.authority), Buffer.from([0])]) },
    {
      program,
      keys: [w(mint), r(p.authority), r(mint), r(p.authority, true)],
      data: Buffer.concat([META_INIT_DISC, borshStr(p.name), borshStr(p.symbol), borshStr(p.uri)]),
    },
    createAtaIdempotent(p.authority, ata, p.authority, mint, program),
  ];
  return { tx: compileTx(p.authority, ixs, p.blockhash), mint, ata };
}

/** 同步：差额为正就增发到金库自己的账户，为负就从金库账户销毁；附一条链上备注 */
export function buildMirrorSyncTx(p: { authority: string; mint: string; ata: string; delta: bigint; decimals: number; memo?: string; blockhash: string }): Buffer {
  if (p.delta === 0n) throw new Error('没有差额');
  const program = TOKEN_2022_PROGRAM;
  const amount = p.delta > 0n ? p.delta : -p.delta;
  const ix: Ix =
    p.delta > 0n
      ? { program, keys: [w(p.mint), w(p.ata), r(p.authority, true)], data: Buffer.concat([Buffer.from([14]), u64(amount), Buffer.from([p.decimals])]) }
      : { program, keys: [w(p.ata), w(p.mint), r(p.authority, true)], data: Buffer.concat([Buffer.from([15]), u64(amount), Buffer.from([p.decimals])]) };
  return compileTx(p.authority, [ix, ...memoIx(p.authority, p.memo)], p.blockhash);
}

export function buildVkTransferTx(p: { from: string; to: string; lamports: bigint; memo?: string; blockhash: string }): Buffer {
  return compileTx(
    p.from,
    [{ program: SYSTEM_PROGRAM, keys: [w(p.from, true), w(p.to)], data: Buffer.concat([u32(2), u64(p.lamports)]) }, ...memoIx(p.from, p.memo)],
    p.blockhash,
  );
}

export function buildTokenTransferTx(p: {
  owner: string;
  source: string;
  mint: string;
  program: string;
  dest: string;
  /** 目标是钱包地址时：先（幂等地）创建它的关联代币账户 */
  createFor?: string;
  amountRaw: bigint;
  decimals: number;
  memo?: string;
  blockhash: string;
}): Buffer {
  const ixs: Ix[] = [];
  if (p.createFor) ixs.push(createAtaIdempotent(p.owner, p.dest, p.createFor, p.mint, p.program));
  // TransferChecked(12) { amount, decimals }：[来源, mint, 目标, 所有者(签名)]
  ixs.push({ program: p.program, keys: [w(p.source), r(p.mint), w(p.dest), r(p.owner, true)], data: Buffer.concat([Buffer.from([12]), u64(p.amountRaw), Buffer.from([p.decimals])]) });
  ixs.push(...memoIx(p.owner, p.memo));
  return compileTx(p.owner, ixs, p.blockhash);
}

export function buildMintToTx(p: { owner: string; mint: string; program: string; dest: string; createFor?: string; amountRaw: bigint; decimals: number; blockhash: string }): Buffer {
  const ixs: Ix[] = [];
  if (p.createFor) ixs.push(createAtaIdempotent(p.owner, p.dest, p.createFor, p.mint, p.program));
  ixs.push({ program: p.program, keys: [w(p.mint), w(p.dest), r(p.owner, true)], data: Buffer.concat([Buffer.from([14]), u64(p.amountRaw), Buffer.from([p.decimals])]) });
  return compileTx(p.owner, ixs, p.blockhash);
}

export function buildBurnTx(p: { owner: string; account: string; mint: string; program: string; amountRaw: bigint; decimals: number; blockhash: string }): Buffer {
  // BurnChecked(15) { amount, decimals }：[代币账户, mint, 所有者(签名)]
  return compileTx(p.owner, [{ program: p.program, keys: [w(p.account), w(p.mint), r(p.owner, true)], data: Buffer.concat([Buffer.from([15]), u64(p.amountRaw), Buffer.from([p.decimals])]) }], p.blockhash);
}

export function buildRenounceTx(p: { owner: string; mint: string; program: string; blockhash: string }): Buffer {
  return compileTx(p.owner, [setAuthorityIx(p.mint, p.owner, p.program)], p.blockhash);
}

// ─── 交易解析 / 签名 ─────────────────────────────────────────

function readShortvec(b: Buffer, o: number): [number, number] {
  let v = 0;
  let shift = 0;
  for (let i = 0; i < 3; i++) {
    const x = b[o + i];
    v |= (x & 0x7f) << shift;
    if (!(x & 0x80)) return [v, o + i + 1];
    shift += 7;
  }
  throw new Error('交易格式错误');
}

export interface ParsedTx {
  sigCount: number;
  sigOffset: number;
  message: Buffer;
  signers: string[];
  accounts: string[];
  signatures: Buffer[];
}

/** 拆出 legacy / v0 交易的签名区和消息体，以及需要签名的地址 */
export function parseTx(tx: Buffer): ParsedTx {
  const [n, o] = readShortvec(tx, 0);
  if (n < 1 || n > 12) throw new Error('交易签名数量不对');
  const message = tx.subarray(o + 64 * n);
  let m = 0;
  if (message[0] & 0x80) m = 1; // v0 消息：第一个字节是版本前缀
  const numRequired = message[m];
  const [nKeys, ko] = readShortvec(message, m + 3);
  const accounts: string[] = [];
  for (let i = 0; i < nKeys; i++) accounts.push(bs58encode(message.subarray(ko + i * 32, ko + i * 32 + 32)));
  const signatures: Buffer[] = [];
  for (let i = 0; i < n; i++) signatures.push(tx.subarray(o + i * 64, o + i * 64 + 64));
  return { sigCount: n, sigOffset: o, message, signers: accounts.slice(0, numRequired), accounts, signatures };
}

export interface ServerKeypair {
  address: string;
  key: crypto.KeyObject;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** 读取 solana-keygen 格式的私钥文件（64 个数字：私钥种子 32 + 公钥 32） */
export function loadKeypair(file: string): ServerKeypair | null {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(arr) || arr.length !== 64) return null;
    const bytes = Buffer.from(arr);
    const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, bytes.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
    const pub = Buffer.from(crypto.createPublicKey(key).export({ format: 'jwk' }).x as string, 'base64url');
    if (!pub.equals(bytes.subarray(32))) return null; // 私钥和公钥对不上
    return { address: bs58encode(pub), key };
  } catch {
    return null;
  }
}

/** 用服务器上的密钥给交易签名（只签自己那一位） */
export function signWith(tx: Buffer, kp: ServerKeypair): Buffer {
  const p = parseTx(tx);
  const i = p.signers.indexOf(kp.address);
  if (i < 0) throw new Error('这笔交易不需要这个地址签名');
  const sig = crypto.sign(null, p.message, kp.key);
  const out = Buffer.from(tx);
  sig.copy(out, p.sigOffset + i * 64);
  return out;
}
