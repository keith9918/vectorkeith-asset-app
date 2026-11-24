// 钱包连接：Wallet Standard 协议（Phantom / Solflare / Backpack / OKX 等都支持）。
// App 只负责发现钱包、请求连接、把服务器组装好的未签名交易交给钱包；签名和发送都在钱包里完成，私钥从不离开钱包。
import { useSyncExternalStore } from 'react';

export interface WalletAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
}

export interface StdWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly WalletAccount[];
  features: Record<string, any>;
}

const CHAIN = 'solana:mainnet';
let wallets: StdWallet[] = [];
const listeners = new Set<() => void>();
let started = false;

function usable(w: StdWallet) {
  return (
    w.chains?.some((c) => c.startsWith('solana:')) &&
    !!w.features?.['standard:connect'] &&
    !!w.features?.['solana:signAndSendTransaction']
  );
}

/** 按 Wallet Standard 的约定：App 广播 app-ready，钱包回调 register；先加载的钱包会响应 app-ready，后加载的发 register-wallet */
export function startWalletDiscovery() {
  if (started) return;
  started = true;
  const api = Object.freeze({
    register: (...ws: StdWallet[]) => {
      const added = ws.filter((w) => usable(w) && !wallets.includes(w));
      if (added.length) {
        wallets = [...wallets, ...added];
        listeners.forEach((l) => l());
      }
      return () => {
        wallets = wallets.filter((w) => !ws.includes(w));
        listeners.forEach((l) => l());
      };
    },
  });
  window.addEventListener('wallet-standard:register-wallet', (e: Event) => {
    const callback = (e as CustomEvent).detail;
    if (typeof callback === 'function') callback(api);
  });
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
}

export function useWallets(): StdWallet[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => wallets,
  );
}

export async function connectWallet(w: StdWallet): Promise<WalletAccount> {
  const { accounts } = await w.features['standard:connect'].connect();
  const acc = (accounts as WalletAccount[]).find((a) => !a.chains?.length || a.chains.includes(CHAIN)) ?? accounts[0];
  if (!acc) throw new Error('钱包没有返回账户');
  return acc;
}

export async function disconnectWallet(w: StdWallet) {
  try {
    await w.features['standard:disconnect']?.disconnect();
  } catch {
    /* 有的钱包不支持断开，忽略 */
  }
}

/** 交给钱包签名并发送；返回交易签名（base58） */
export async function signAndSend(w: StdWallet, account: WalletAccount, tx: Uint8Array): Promise<string> {
  const [out] = await w.features['solana:signAndSendTransaction'].signAndSendTransaction({ account, chain: CHAIN, transaction: tx });
  return bs58encode(out.signature);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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

/** 用户在钱包里点了"取消" */
export function isUserRejection(e: unknown) {
  const msg = String((e as Error)?.message ?? e);
  return (e as any)?.code === 4001 || /reject|denied|cancel|declin/i.test(msg);
}

/** 手机浏览器里没有钱包：用钱包 App 的内置浏览器打开本页面 */
export function walletBrowseLinks(url: string) {
  const ref = encodeURIComponent(new URL(url).origin);
  return [
    { name: 'Phantom', href: `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${ref}` },
    { name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${ref}` },
  ];
}
