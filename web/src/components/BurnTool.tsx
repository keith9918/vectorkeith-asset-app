import { Flame, Link2Off, Wallet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { postJSON, solscan } from '../lib/api';
import { fmtCompact, fmtMoney, fmtNum, fmtPct, fmtPrice } from '../lib/format';
import { useSolTo, useSymbol } from '../lib/hooks';
import { useStore } from '../lib/store';
import {
  base64ToBytes,
  connectWallet,
  disconnectWallet,
  isUserRejection,
  signAndSend,
  useWallets,
  walletBrowseLinks,
  type StdWallet,
  type WalletAccount,
} from '../lib/wallet';
import { useCur } from './Shell';
import { Address, Card, toast } from './ui';

const TARGETS = [100_000_000, 50_000_000];

type Phase = { kind: 'idle' } | { kind: 'working'; text: string } | { kind: 'sent'; sig: string; amount: number; supplyBefore: number } | { kind: 'error'; text: string };

interface Prepared {
  transaction: string;
  amountRaw: string;
  decimals: number;
}

export function BurnTool() {
  const snap = useStore((s) => s.snap);
  const wallets = useWallets();
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const symbol = useSymbol();
  const [wallet, setWallet] = useState<StdWallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [amount, setAmount] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [presetNote, setPresetNote] = useState('');

  // 已提交：链上总量下降后标记为已确认
  const confirmed = phase.kind === 'sent' && !!snap && snap.supply <= phase.supplyBefore - phase.amount * 0.999;
  useEffect(() => {
    if (confirmed) toast('销毁已在链上确认，总量和市值已更新');
  }, [confirmed]);

  const holder = useMemo(() => (account && snap ? snap.holders.find((h) => h.owner === account.address) : undefined), [account, snap]);
  const companyWallet = account ? snap?.company.find((w) => w.address === account.address) : undefined;
  const balance = companyWallet?.tokens ?? holder?.amount ?? null;
  const n = Number(amount);
  const valid = amount !== '' && Number.isFinite(n) && n > 0 && (balance === null || n <= balance + 1e-6);
  const burnsAll = valid && balance !== null && n >= balance - 1e-6;

  const preview = useMemo(() => {
    if (!snap?.market || !valid || !account) return null;
    const m = snap.market;
    return {
      supplyAfter: snap.supply - n,
      mcapBefore: m.priceSol * snap.supply,
      mcapAfter: m.priceSol * (snap.supply - n),
      poolSol: m.poolSol,
      priceSol: m.priceSol,
    };
  }, [snap, valid, n, account]);

  if (!snap?.market) return null;

  const connect = async (w: StdWallet) => {
    setPhase({ kind: 'working', text: `正在连接 ${w.name}…` });
    try {
      const acc = await connectWallet(w);
      setWallet(w);
      setAccount(acc);
      setPhase({ kind: 'idle' });
    } catch (e) {
      setPhase({ kind: 'error', text: isUserRejection(e) ? '你在钱包里取消了连接' : `连接失败：${(e as Error).message}` });
    }
  };

  const disconnect = async () => {
    if (wallet) await disconnectWallet(wallet);
    setWallet(null);
    setAccount(null);
    setAmount('');
    setAgreed(false);
    setPhase({ kind: 'idle' });
  };

  const presetAmount = (target: number) => Math.max(0, Math.min(snap.supply - target, balance ?? Infinity));
  const applyPreset = (target: number) => {
    const need = snap.supply - target;
    const a = presetAmount(target);
    // 截到 6 位小数，避免浮点尾数
    setAmount(a > 0 ? String(Math.floor(a * 1e6) / 1e6) : '');
    setAgreed(false);
    setPresetNote(
      a < need - 1e-6
        ? `这个钱包只有 ${fmtNum(a, 0)} 枚，最多能把总量降到 ${fmtCompact(snap.supply - a)}。要降到 ${fmtCompact(target, 0)}，还需要换其他公司钱包再销毁 ${fmtNum(need - a, 0)} 枚。`
        : '',
    );
  };

  const burn = async () => {
    if (!wallet || !account || !preview) return;
    if (!confirm(`用 ${wallet.name} 销毁 ${fmtNum(n, 0)} 枚 ${symbol}？\n销毁后总量 ${fmtCompact(preview.supplyAfter)}，市值降到 ${fmtMoney(preview.mcapAfter * solTo[primary], primary, { compact: true })}。\n销毁不可撤销。`)) return;
    const supplyBefore = snap.supply;
    try {
      setPhase({ kind: 'working', text: '正在组装交易并在链上模拟…' });
      const prep = await postJSON<Prepared>('/api/burn/prepare', { owner: account.address, amount }, '');
      setPhase({ kind: 'working', text: `请在 ${wallet.name} 里确认：应显示减少 ${fmtNum(n, 0)} 枚 ${symbol}` });
      const sig = await signAndSend(wallet, account, base64ToBytes(prep.transaction));
      setPhase({ kind: 'sent', sig, amount: n, supplyBefore });
      setAmount('');
      setAgreed(false);
    } catch (e) {
      setPhase({ kind: 'error', text: isUserRejection(e) ? '你在钱包里取消了，没有销毁任何代币' : (e as Error).message });
    }
  };

  const busy = phase.kind === 'working';
  const here = `${location.origin}/#/settings`;

  return (
    <Card kicker="Burn" title={`销毁 ${symbol}`} right={<span className="chip chip--warn">不可撤销</span>}>
      <p className="card__note" style={{ marginTop: 0 }}>
        销毁只减少代币总量，不卖出、不动池子里的 SOL：价格不变，市值按比例下降。公司资产按钱包里的 SOL 计算，销毁代币不影响。签名在你自己的钱包里完成，App 和服务器都接触不到私钥。
      </p>

      {!account ? (
        wallets.length ? (
          <div className="wm__actions" style={{ flexWrap: 'wrap' }}>
            {wallets.map((w) => (
              <button key={w.name} type="button" className="btn" disabled={busy} onClick={() => connect(w)}>
                {w.icon ? <img src={w.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} /> : <Wallet size={15} />} 连接 {w.name}
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="addr-preview addr-preview--info">
              当前浏览器里没有检测到 Solana 钱包。手机上请用钱包 App 打开本页面，电脑上安装 Phantom 浏览器插件后刷新。
            </div>
            <div className="wm__actions">
              {walletBrowseLinks(here).map((l) => (
                <a key={l.name} className="btn" href={l.href}>
                  在 {l.name} 中打开
                </a>
              ))}
            </div>
            <p className="card__note">在钱包 App 里打开后，需要在设置里再输入一次管理员密钥。</p>
          </>
        )
      ) : (
        <>
          <div className="rows">
            <div className="row">
              <span className="row__k">已连接 {wallet?.name}</span>
              <span className="row__v" style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {companyWallet && <span className="chip chip--accent">{companyWallet.label}</span>}
                <Address address={account.address} />
              </span>
            </div>
            <div className="row">
              <span className="row__k">钱包里的 {symbol}</span>
              <span className="row__v mono">{balance === null ? '（不在前 100 名，以链上为准）' : `${fmtNum(balance, 0)} 枚`}</span>
            </div>
          </div>
          {!companyWallet && (
            <div className="addr-preview addr-preview--warn" style={{ marginTop: 8 }}>
              这个钱包不在公司名单里。销毁它的代币同样会减少总量和市值。
            </div>
          )}

          <div className="field" style={{ marginTop: 12, marginBottom: 8 }}>
            <label htmlFor="burn-amount">销毁数量</label>
            <input
              id="burn-amount"
              inputMode="decimal"
              placeholder="输入要销毁的数量"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^\d.]/g, ''));
                setAgreed(false);
                setPresetNote('');
              }}
            />
          </div>
          <div className="wm__actions" style={{ marginTop: 0, flexWrap: 'wrap' }}>
            {TARGETS.map((t) => (
              <button key={t} type="button" className="btn btn--ghost" disabled={busy || presetAmount(t) <= 0} onClick={() => applyPreset(t)}>
                销毁到总量 {fmtCompact(t, 0)}
              </button>
            ))}
          </div>
          {amount !== '' && !valid && <div className="error">数量要大于 0，且不能超过钱包余额</div>}
          {presetNote && (
            <div className="addr-preview addr-preview--info" style={{ marginTop: 8 }}>
              {presetNote}
            </div>
          )}
          {burnsAll && (
            <div className="addr-preview addr-preview--warn" style={{ marginTop: 8 }}>
              注意：这会销毁这个钱包里的全部 {symbol}，销毁后它的余额为 0。
            </div>
          )}

          {preview && (
            <div className="addr-preview addr-preview--ok" style={{ marginTop: 12 }}>
              <div>
                销毁 <b>{fmtNum(n, 0)}</b> 枚（占总量 {fmtPct(n / snap.supply)}）
              </div>
              <div>
                总量 {fmtCompact(snap.supply)} → <b>{fmtCompact(preview.supplyAfter)}</b>
              </div>
              <div>
                市值 {fmtMoney(preview.mcapBefore * solTo[primary], primary, { compact: true })} → <b>{fmtMoney(preview.mcapAfter * solTo[primary], primary, { compact: true })}</b>
                <span className="muted">（{fmtMoney(preview.mcapAfter * solTo[secondary], secondary, { compact: true })}）</span>
              </div>
              <div>
                市值是池子 SOL 的 {fmtNum(preview.mcapBefore / preview.poolSol, 0)} 倍 → <b>{fmtNum(preview.mcapAfter / preview.poolSol, 1)} 倍</b>
              </div>
              <div>价格不变：{fmtPrice(preview.priceSol * solTo[primary], primary)}</div>
              <div>公司总资产（钱包里的 SOL）不变，只花约 0.000005 SOL 网络费</div>
            </div>
          )}

          <label className="checkbox">
            <input type="checkbox" checked={agreed} disabled={!preview} onChange={(e) => setAgreed(e.target.checked)} />
            我知道销毁后无法恢复
          </label>
          <button type="button" className="btn btn--solid" style={{ width: '100%', marginTop: 10 }} disabled={busy || !preview || !agreed} onClick={burn}>
            <Flame size={15} /> 用 {wallet?.name} 签名并销毁
          </button>
          <button type="button" className="btn btn--ghost" style={{ width: '100%', marginTop: 8 }} disabled={busy} onClick={disconnect}>
            <Link2Off size={15} /> 断开钱包
          </button>
        </>
      )}

      {phase.kind === 'working' && (
        <div className="addr-preview addr-preview--info" style={{ marginTop: 10 }} role="status">
          {phase.text}
        </div>
      )}
      {phase.kind === 'error' && <div className="error">{phase.text}</div>}
      {phase.kind === 'sent' && (
        <div className={`addr-preview ${confirmed ? 'addr-preview--ok' : 'addr-preview--info'}`} style={{ marginTop: 10 }} role="status">
          {confirmed ? '✓ 已在链上确认' : '已提交，等待链上确认…'}销毁 {fmtNum(phase.amount, 0)} 枚。
          <a href={solscan.tx(phase.sig)} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>
            在 Solscan 查看 ›
          </a>
          {confirmed && <div className="muted">现在总量 {fmtCompact(snap.supply)}，市值 {fmtMoney(snap.market.priceSol * snap.supply * solTo[primary], primary, { compact: true })}</div>}
        </div>
      )}
    </Card>
  );
}
