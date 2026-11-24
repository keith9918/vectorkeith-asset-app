// VK 链：数据接口 + App 内钱包（私钥只保存在这台设备的浏览器里，签名在本地完成，服务器拿不到私钥）
import { ed25519 } from '@noble/curves/ed25519.js';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  ChainAddressView,
  ChainAdminView,
  ChainBlockView,
  ChainFaucetResult,
  ChainOverview,
  ChainPrepared,
  ChainSendResult,
  ChainToken,
  ChainTxView,
} from '../../../shared/chain';
import { getJSON, postJSON } from './api';

// ─── Base58 / Base64 ─────────────────────────────────────────

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
    if (v === undefined) throw new Error('含有非法字符');
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

export function isAddress(s: string): boolean {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && bs58decode(s).length === 32;
  } catch {
    return false;
  }
}

const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function b64encode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

// ─── App 内钱包 ──────────────────────────────────────────────

export interface LocalWallet {
  address: string;
  /** 64 字节私钥（种子 32 + 公钥 32）的 Base58，与 Phantom / Solflare 导出的格式相同 */
  secret: string;
  createdAt: number;
  backedUp?: boolean;
}

const WALLET_KEY = 'vk.chain.wallet.v1';
const listeners = new Set<() => void>();
let walletCache: LocalWallet | null | undefined;

function readWallet(): LocalWallet | null {
  if (walletCache !== undefined) return walletCache;
  try {
    const w = JSON.parse(localStorage.getItem(WALLET_KEY) ?? 'null');
    walletCache = w && isAddress(w.address) && typeof w.secret === 'string' ? (w as LocalWallet) : null;
  } catch {
    walletCache = null;
  }
  return walletCache;
}

function writeWallet(w: LocalWallet | null) {
  walletCache = w;
  try {
    if (w) localStorage.setItem(WALLET_KEY, JSON.stringify(w));
    else localStorage.removeItem(WALLET_KEY);
  } catch {
    /* 隐私模式：只在本次打开期间有效 */
  }
  for (const l of listeners) l();
}

export function useWallet(): LocalWallet | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      const onStorage = (e: StorageEvent) => {
        if (e.key === WALLET_KEY) {
          walletCache = undefined;
          l();
        }
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(l);
        window.removeEventListener('storage', onStorage);
      };
    },
    readWallet,
  );
}

function walletFromSeed(seed: Uint8Array, backedUp = false): LocalWallet {
  const pub = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pub, 32);
  return { address: bs58encode(pub), secret: bs58encode(full), createdAt: Date.now(), backedUp };
}

export function createWallet(): LocalWallet {
  const w = walletFromSeed(ed25519.utils.randomSecretKey());
  writeWallet(w);
  return w;
}

/** 导入：Base58 私钥（64 或 32 字节），或 solana-keygen 的 JSON 数组 */
export function importWallet(text: string): LocalWallet {
  const s = text.trim();
  let bytes: Uint8Array;
  if (s.startsWith('[')) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error('格式不对');
    bytes = Uint8Array.from(arr);
  } else bytes = bs58decode(s);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error('私钥长度不对（应为 64 字节的 Base58 私钥或密钥文件内容）');
  const seed = bytes.slice(0, 32);
  const w = walletFromSeed(seed, true);
  if (bytes.length === 64 && bs58encode(bytes.slice(32)) !== w.address) throw new Error('私钥和公钥对不上，请检查是否复制完整');
  writeWallet(w);
  return w;
}

export function markBackedUp() {
  const w = readWallet();
  if (w && !w.backedUp) writeWallet({ ...w, backedUp: true });
}

export function forgetWallet() {
  writeWallet(null);
}

function readShortvec(b: Uint8Array, o: number): [number, number] {
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

/** 用本地私钥给服务器组装的交易签名（只签自己那一位） */
export function signTx(txB64: string, w: LocalWallet): string {
  const tx = b64decode(txB64);
  const [n, o] = readShortvec(tx, 0);
  const message = tx.subarray(o + 64 * n);
  const m = message[0] & 0x80 ? 1 : 0;
  const numRequired = message[m];
  const [, ko] = readShortvec(message, m + 3);
  const me = bs58decode(w.address);
  let idx = -1;
  for (let i = 0; i < numRequired; i++) {
    const k = message.subarray(ko + i * 32, ko + i * 32 + 32);
    if (k.every((x, j) => x === me[j])) idx = i;
  }
  if (idx < 0) throw new Error('这笔交易不是给这个钱包签的');
  const seed = bs58decode(w.secret).slice(0, 32);
  const sig = ed25519.sign(message, seed);
  const out = new Uint8Array(tx);
  out.set(sig, o + idx * 64);
  return b64encode(out);
}

// ─── 接口 ────────────────────────────────────────────────────

export const chainApi = {
  overview: () => getJSON<ChainOverview>('/api/chain/overview'),
  address: (a: string) => getJSON<ChainAddressView>(`/api/chain/address?a=${encodeURIComponent(a)}`),
  tx: (sig: string) => getJSON<ChainTxView>(`/api/chain/tx?sig=${encodeURIComponent(sig)}`),
  block: (slot: number) => getJSON<ChainBlockView>(`/api/chain/block?slot=${slot}`),
  tokens: () => getJSON<ChainToken[]>('/api/chain/tokens'),
  search: (q: string) => getJSON<{ type: 'block' | 'tx' | 'address' | 'tokens'; id: string; matches?: ChainToken[] }>(`/api/chain/search?q=${encodeURIComponent(q)}`),
  prepare: (body: Record<string, unknown>) => postJSON<ChainPrepared>('/api/chain/prepare', body),
  send: (tx: string) => postJSON<ChainSendResult>('/api/chain/send', { tx }),
  faucet: (address: string) => postJSON<ChainFaucetResult>('/api/chain/faucet', { address }),
  adminView: () => postJSON<ChainAdminView>('/api/admin/chain', { action: 'view' }),
  admin: (body: Record<string, unknown>) => postJSON<{ ok: boolean; sig?: string }>('/api/admin/chain', body),
};

/** 组装 → 本地签名 → 广播；返回签名结果（失败时抛出中文原因） */
export async function signAndSend(prepared: ChainPrepared, w: LocalWallet): Promise<ChainSendResult> {
  const signed = signTx(prepared.tx, w);
  const r = await chainApi.send(signed);
  if (!r.ok) throw new Error(r.err ?? '交易失败');
  bumpChain();
  return r;
}

// 交易成功后让各个视图立即刷新
let chainRev = 0;
const revListeners = new Set<() => void>();
function emitRev() {
  chainRev++;
  for (const l of revListeners) l();
}
/** 交易成功后刷新各个视图：马上一次，1.5 秒后再一次（服务器索引新区块需要一点时间） */
export function bumpChain() {
  emitRev();
  setTimeout(emitRev, 1500);
}
function useChainRev() {
  return useSyncExternalStore(
    (l) => {
      revListeners.add(l);
      return () => revListeners.delete(l);
    },
    () => chainRev,
  );
}

/** 页面可见时每 interval 毫秒刷新一次 */
function usePolling<T>(fetcher: (() => Promise<T>) | null, interval: number, deps: unknown[]): { data: T | null; error: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const rev = useChainRev();
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  useEffect(() => {
    if (!fetchRef.current) {
      setData(null);
      return;
    }
    let cancelled = false;
    let timer = 0;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      const f = fetchRef.current;
      if (!f) return;
      setLoading(true);
      try {
        const x = await f();
        if (!cancelled) {
          setData(x);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    if (interval > 0) timer = window.setInterval(load, interval);
    const onVis = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, rev, interval]);
  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

let overviewCache: ChainOverview | null = null;
export function useChainOverview(interval = 2000) {
  const r = usePolling(() => chainApi.overview().then((x) => (overviewCache = x)), interval, []);
  return { ...r, data: r.data ?? overviewCache };
}
export const useChainAddress = (a: string | null, interval = 6000) => usePolling(a ? () => chainApi.address(a) : null, interval, [a]);
export const useChainTx = (sig: string | null) => usePolling(sig ? () => chainApi.tx(sig) : null, 0, [sig]);
export const useChainBlock = (slot: number | null) => usePolling(slot != null ? () => chainApi.block(slot) : null, 0, [slot]);

// ─── 格式化 ──────────────────────────────────────────────────

/** VK 数量：大数用千分位，小数最多显示到有效位 */
export function fmtVk(v: number, maxFrac = 6): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: Math.min(maxFrac, 4) });
  if (abs === 0) return '0';
  return v.toLocaleString('en-US', { maximumSignificantDigits: 4, maximumFractionDigits: 9 });
}

export function fmtAmount(v: number, decimals = 9): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: Math.min(decimals, 6) });
}

export const chainLink = {
  tx: (sig: string) => `#/chain/tx/${sig}`,
  address: (a: string) => `#/chain/address/${a}`,
  block: (slot: number) => `#/chain/block/${slot}`,
};
