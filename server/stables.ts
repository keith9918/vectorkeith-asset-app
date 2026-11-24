// ───────────────────────────────────────────────────────────────
//  公司稳定币资产：Solana 主网上的 USDT / USDC（只认官方 mint，冒牌币不计入）
//  · 余额：公司钱包名下这两种币的所有代币账户之和（每 30 秒刷新，有变化时广播）
//  · 流水：公司钱包的 SOL 流水里本来就带了每笔交易的代币变化；稳定币只转入转出、SOL 不变的那些
//          由这里单独记成"转入 / 转出 USDT"（公司 SOL 不变的交易原来会被记成"其他"）
//  · 估值：1 USDT = 1 USDC = 1 美元。计入"公司总资产"的显示，不计入分红（分红只按 SOL）
// ───────────────────────────────────────────────────────────────
import { EventEmitter } from 'node:events';
import type { RpcHttp } from './rpc';

export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const STABLES: Record<string, { symbol: 'USDT' | 'USDC'; decimals: number }> = {
  [USDT_MINT]: { symbol: 'USDT', decimals: 6 },
  [USDC_MINT]: { symbol: 'USDC', decimals: 6 },
};
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export interface StableWallet {
  address: string;
  usdt: number;
  usdc: number;
}

export interface StablesView {
  /** 读到过一次全部钱包的余额 */
  ready: boolean;
  usdt: number;
  usdc: number;
  /** 合计（美元） */
  usd: number;
  wallets: StableWallet[];
  updatedAt: number;
  /** 公司钱包里名字像 USDT / USDC、但合约地址不是官方的币（骗子空投，不计入资产） */
  fakes: { mint: string; symbol: string; amount: number }[];
}

export class Stables extends EventEmitter {
  private bal = new Map<string, StableWallet>();
  private fakes = new Map<string, { mint: string; symbol: string; amount: number }>();
  private updatedAt = 0;
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private o: {
      rpc: RpcHttp;
      wallets: () => { address: string }[];
      symbolOf: (mint: string) => string | undefined;
      warn: (label: string, e: unknown) => void;
    },
  ) {
    super();
  }

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 30_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 公司钱包有新交易时调用：马上刷新一次 */
  touch() {
    setTimeout(() => void this.refresh(), 1500);
  }

  get usd(): number {
    let s = 0;
    for (const w of this.bal.values()) s += w.usdt + w.usdc;
    return s;
  }

  /** 稳定币总量（最小单位，6 位小数）：用于 VK 链上的 cUSDT / cUSDC 凭证 */
  rawOf(symbol: 'USDT' | 'USDC'): number {
    let s = 0;
    for (const w of this.bal.values()) s += Math.round((symbol === 'USDT' ? w.usdt : w.usdc) * 1e6);
    return s;
  }

  get ready() {
    return this.loaded;
  }

  async refresh() {
    if (this.busy) return;
    const wallets = this.o.wallets();
    if (!wallets.length) {
      this.bal.clear();
      this.loaded = true;
      return;
    }
    this.busy = true;
    try {
      const next = new Map<string, StableWallet>();
      const fakes = new Map<string, { mint: string; symbol: string; amount: number }>();
      for (const w of wallets) {
        const res = await this.o.rpc.call<any>('getTokenAccountsByOwner', [w.address, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        const sw: StableWallet = { address: w.address, usdt: 0, usdc: 0 };
        for (const it of res?.value ?? []) {
          const info = it.account?.data?.parsed?.info;
          if (!info) continue;
          const amount = Number(info.tokenAmount?.uiAmountString ?? 0);
          const s = STABLES[info.mint];
          if (s) {
            if (s.symbol === 'USDT') sw.usdt += amount;
            else sw.usdc += amount;
            continue;
          }
          // 冒牌稳定币：符号里带 USDT / USDC，合约地址却不是官方的
          const sym = this.o.symbolOf(info.mint) ?? '';
          if (amount > 0 && /US[DT]T|USDC/i.test(sym)) {
            const f = fakes.get(info.mint) ?? { mint: info.mint, symbol: sym, amount: 0 };
            f.amount += amount;
            fakes.set(info.mint, f);
          }
        }
        next.set(w.address, sw);
      }
      const before = JSON.stringify([...this.bal.values()]);
      this.bal = next;
      this.fakes = fakes;
      this.updatedAt = Date.now();
      const first = !this.loaded;
      this.loaded = true;
      if (first || JSON.stringify([...next.values()]) !== before) this.emit('changed', this.usd);
    } catch (e) {
      this.o.warn('稳定币余额', e);
    } finally {
      this.busy = false;
    }
  }

  view(): StablesView {
    const wallets = [...this.bal.values()];
    const usdt = wallets.reduce((s, w) => s + w.usdt, 0);
    const usdc = wallets.reduce((s, w) => s + w.usdc, 0);
    return { ready: this.loaded, usdt, usdc, usd: usdt + usdc, wallets, updatedAt: this.updatedAt, fakes: [...this.fakes.values()] };
  }
}
