// ───────────────────────────────────────────────────────────────
//  质押交易组装（未签名）：签名和发送都在用户自己的钱包里完成，服务器接触不到私钥
//  · 质押：createAccountWithSeed（质押账户地址由钱包地址 + 种子推导，不需要额外的签名者）
//          + Stake::Initialize（质押权限、提取权限都是用户自己的钱包）+ Stake::DelegateStake
//  · 解除质押：Stake::Deactivate（下一期开始冷却，约 1 期后可提取）
//  · 提取：Stake::Withdraw（取回到自己的钱包）
// ───────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { SYSTEM_PROGRAM } from '../shared/constants';
import { bs58decode, bs58encode } from './solana';

export const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';
const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111';
const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_STAKE_HISTORY = 'SysvarStakeHistory1111111111111111111111111';
const STAKE_CONFIG = 'StakeConfig11111111111111111111111111111111';
export const STAKE_SPACE = 200;

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

function shortvec(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v) b |= 0x80;
    out.push(b);
    if (!v) break;
  }
  return Buffer.from(out);
}

function key(s: string): Buffer {
  const b = Buffer.from(bs58decode(s));
  if (b.length !== 32) throw new Error(`地址格式错误：${s}`);
  return b;
}

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

/** 把指令编译成 legacy 交易（签名位留空，由钱包填） */
export function compileTx(feePayer: string, ixs: Ix[], blockhash: string): Buffer {
  const metas = new Map<string, Meta>();
  const add = (m: Meta) => {
    const cur = metas.get(m.pubkey);
    if (cur) {
      cur.signer ||= m.signer;
      cur.writable ||= m.writable;
    } else metas.set(m.pubkey, { ...m });
  };
  add({ pubkey: feePayer, signer: true, writable: true });
  for (const ix of ixs) {
    for (const k of ix.keys) add(k);
    add({ pubkey: ix.program, signer: false, writable: false });
  }
  const all = [...metas.values()];
  const rank = (m: Meta) => (m.signer ? (m.writable ? 0 : 1) : m.writable ? 2 : 3);
  // 付费者固定排第一，其余按"签名+可写 / 签名只读 / 可写 / 只读"排序（排序稳定）
  const ordered = [all[0], ...all.slice(1).sort((a, b) => rank(a) - rank(b))];
  const index = new Map(ordered.map((m, i) => [m.pubkey, i]));
  const numSigners = ordered.filter((m) => m.signer).length;
  const header = Buffer.from([numSigners, ordered.filter((m) => m.signer && !m.writable).length, ordered.filter((m) => !m.signer && !m.writable).length]);
  const compiled = ixs.map((ix) =>
    Buffer.concat([Buffer.from([index.get(ix.program)!]), shortvec(ix.keys.length), Buffer.from(ix.keys.map((k) => index.get(k.pubkey)!)), shortvec(ix.data.length), ix.data]),
  );
  const message = Buffer.concat([header, shortvec(ordered.length), ...ordered.map((m) => key(m.pubkey)), key(blockhash), shortvec(ixs.length), ...compiled]);
  return Buffer.concat([shortvec(numSigners), Buffer.alloc(64 * numSigners), message]);
}

/** createWithSeed 推导地址：sha256(base ‖ seed ‖ owner_program) */
export function addressWithSeed(base: string, seed: string, program: string): string {
  return bs58encode(createHash('sha256').update(Buffer.concat([key(base), Buffer.from(seed, 'utf8'), key(program)])).digest());
}

export function buildStakeTx(p: { owner: string; vote: string; lamports: bigint; seed: string; blockhash: string }): { tx: Buffer; stakeAccount: string } {
  if (p.seed.length > 32) throw new Error('seed 太长');
  const stake = addressWithSeed(p.owner, p.seed, STAKE_PROGRAM);
  const seedBytes = Buffer.from(p.seed, 'utf8');
  const create: Ix = {
    program: SYSTEM_PROGRAM,
    keys: [
      { pubkey: p.owner, signer: true, writable: true },
      { pubkey: stake, signer: false, writable: true },
    ],
    // SystemInstruction::CreateAccountWithSeed { base, seed, lamports, space, owner }
    data: Buffer.concat([u32(3), key(p.owner), u64(BigInt(seedBytes.length)), seedBytes, u64(p.lamports), u64(BigInt(STAKE_SPACE)), key(STAKE_PROGRAM)]),
  };
  const init: Ix = {
    program: STAKE_PROGRAM,
    keys: [
      { pubkey: stake, signer: false, writable: true },
      { pubkey: SYSVAR_RENT, signer: false, writable: false },
    ],
    // StakeInstruction::Initialize(Authorized { staker, withdrawer }, Lockup { 0, 0, 0 })
    data: Buffer.concat([u32(0), key(p.owner), key(p.owner), Buffer.alloc(8 + 8 + 32)]),
  };
  const delegate: Ix = {
    program: STAKE_PROGRAM,
    keys: [
      { pubkey: stake, signer: false, writable: true },
      { pubkey: p.vote, signer: false, writable: false },
      { pubkey: SYSVAR_CLOCK, signer: false, writable: false },
      { pubkey: SYSVAR_STAKE_HISTORY, signer: false, writable: false },
      { pubkey: STAKE_CONFIG, signer: false, writable: false },
      { pubkey: p.owner, signer: true, writable: false },
    ],
    data: u32(2), // StakeInstruction::DelegateStake
  };
  return { tx: compileTx(p.owner, [create, init, delegate], p.blockhash), stakeAccount: stake };
}

export function buildDeactivateTx(p: { owner: string; stake: string; blockhash: string }): Buffer {
  return compileTx(
    p.owner,
    [
      {
        program: STAKE_PROGRAM,
        keys: [
          { pubkey: p.stake, signer: false, writable: true },
          { pubkey: SYSVAR_CLOCK, signer: false, writable: false },
          { pubkey: p.owner, signer: true, writable: false },
        ],
        data: u32(5), // StakeInstruction::Deactivate
      },
    ],
    p.blockhash,
  );
}

export function buildWithdrawTx(p: { owner: string; stake: string; lamports: bigint; blockhash: string }): Buffer {
  return compileTx(
    p.owner,
    [
      {
        program: STAKE_PROGRAM,
        keys: [
          { pubkey: p.stake, signer: false, writable: true },
          { pubkey: p.owner, signer: false, writable: true },
          { pubkey: SYSVAR_CLOCK, signer: false, writable: false },
          { pubkey: SYSVAR_STAKE_HISTORY, signer: false, writable: false },
          { pubkey: p.owner, signer: true, writable: false },
        ],
        data: Buffer.concat([u32(4), u64(p.lamports)]), // StakeInstruction::Withdraw(lamports)
      },
    ],
    p.blockhash,
  );
}

/** 一笔交易里给多个地址转 SOL（系统程序 Transfer）：员工充值、管理员一键发分息 / 处理赎回 */
export function buildTransfersTx(p: { owner: string; items: { to: string; lamports: bigint }[]; blockhash: string }): Buffer {
  if (!p.items.length) throw new Error('没有要转账的地址');
  return compileTx(
    p.owner,
    p.items.map((it) => ({
      program: SYSTEM_PROGRAM,
      keys: [
        { pubkey: p.owner, signer: true, writable: true },
        { pubkey: it.to, signer: false, writable: true },
      ],
      data: Buffer.concat([u32(2), u64(it.lamports)]), // SystemInstruction::Transfer { lamports }
    })),
    p.blockhash,
  );
}
