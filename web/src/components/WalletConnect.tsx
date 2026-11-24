import { Link2Off, Wallet } from 'lucide-react';
import { useState } from 'react';
import { connectWallet, disconnectWallet, isUserRejection, useWallets, walletBrowseLinks, type StdWallet, type WalletAccount } from '../lib/wallet';
import { Address } from './ui';

/** 连接钱包（Wallet Standard）：Phantom、Solflare 等；签名都在钱包里完成 */
export function useWalletSession() {
  const wallets = useWallets();
  const [wallet, setWallet] = useState<StdWallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [error, setError] = useState('');
  const connect = async (w: StdWallet) => {
    setError('');
    try {
      const acc = await connectWallet(w);
      setWallet(w);
      setAccount(acc);
    } catch (e) {
      setError(isUserRejection(e) ? '你在钱包里取消了连接' : `连接失败：${(e as Error).message}`);
    }
  };
  const disconnect = async () => {
    if (wallet) await disconnectWallet(wallet);
    setWallet(null);
    setAccount(null);
  };
  return { wallets, wallet, account, connect, disconnect, error };
}

export type WalletSession = ReturnType<typeof useWalletSession>;

export function WalletBar({ s, busy, tag }: { s: WalletSession; busy?: boolean; tag?: string }) {
  if (!s.account) {
    if (!s.wallets.length) {
      const here = location.href;
      return (
        <>
          <div className="addr-preview addr-preview--info">当前浏览器里没有 Solana 钱包。手机上请用钱包 App 打开本页面，电脑上安装 Phantom 插件后刷新。</div>
          <div className="wm__actions">
            {walletBrowseLinks(here).map((l) => (
              <a key={l.name} className="btn" href={l.href}>
                在 {l.name} 中打开
              </a>
            ))}
          </div>
        </>
      );
    }
    return (
      <>
        <div className="wm__actions" style={{ flexWrap: 'wrap' }}>
          {s.wallets.map((w) => (
            <button key={w.name} type="button" className="btn" disabled={busy} onClick={() => s.connect(w)}>
              {w.icon ? <img src={w.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} /> : <Wallet size={15} />} 连接 {w.name}
            </button>
          ))}
        </div>
        {s.error && <div className="error">{s.error}</div>}
      </>
    );
  }
  return (
    <div className="row">
      <span className="row__k">已连接 {s.wallet?.name}</span>
      <span className="row__v" style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {tag && <span className="chip chip--accent">{tag}</span>}
        <Address address={s.account.address} />
        <button type="button" className="addr__btn" aria-label="断开钱包" disabled={busy} onClick={() => void s.disconnect()}>
          <Link2Off size={13} />
        </button>
      </span>
    </div>
  );
}
