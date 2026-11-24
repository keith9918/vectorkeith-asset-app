// VK 链页面的公共小组件：子路由、资产图标、交易行、地址链接、签名确认
import {
  ArrowLeftRight,
  CirclePlus,
  Copy,
  Droplets,
  FileCode2,
  Flame,
  Gift,
  Hash,
  KeyRound,
  Send,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ChainPrepared, ChainSendResult, ChainTx, ChainTxKind } from '../../../shared/chain';
import { apiUrl } from '../lib/api';
import { chainApi, chainLink, fmtAmount, fmtVk, signAndSend, useWallet } from '../lib/chain';
import { fmtAgo, shortAddr } from '../lib/format';
import { copyText, toast } from './ui';

// ─── 子路由：#/chain/<view>/<id> ─────────────────────────────

export function useChainPath(): string[] {
  const hash = useSyncExternalStore(
    (l) => {
      window.addEventListener('hashchange', l);
      return () => window.removeEventListener('hashchange', l);
    },
    () => location.hash,
  );
  return hash.replace(/^#\/?/, '').split('?')[0].split('/').slice(1).filter(Boolean);
}

export const chainGo = (path = '') => {
  location.hash = `#/chain${path ? `/${path}` : ''}`;
};

// ─── 图标 ────────────────────────────────────────────────────

export function TokenIcon({ mint, size = 30 }: { mint: string; size?: number }) {
  return <img className="ch-tokic" src={apiUrl(`/chain/icon/${mint}`)} width={size} height={size} alt="" loading="lazy" />;
}

export function VkCoin({ size = 30 }: { size?: number }) {
  return (
    <span className="ch-vkcoin" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      VK
    </span>
  );
}

const KIND_ICON: Record<ChainTxKind, typeof Send> = {
  transfer: ArrowLeftRight,
  faucet: Droplets,
  airdrop: Gift,
  'token-create': Sparkles,
  'token-mint': CirclePlus,
  'token-transfer': Send,
  'token-burn': Flame,
  'token-authority': KeyRound,
  account: UserPlus,
  program: FileCode2,
  other: Hash,
};

export function KindIcon({ kind, ok = true }: { kind: ChainTxKind; ok?: boolean }) {
  const Icon = KIND_ICON[kind] ?? Hash;
  return (
    <span className={`ch-kind ch-kind--${ok ? kind : 'fail'}`} aria-hidden>
      <Icon size={16} strokeWidth={2} />
    </span>
  );
}

// ─── 地址 / 复制 ─────────────────────────────────────────────

export function AddrLink({ a, label, n = 4 }: { a: string; label?: string; n?: number }) {
  return (
    <a className="ch-addr" href={chainLink.address(a)} title={a} onClick={(e) => e.stopPropagation()}>
      {label ?? shortAddr(a, n)}
    </a>
  );
}

export function CopyBtn({ text, label = '已复制' }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      className="addr__btn"
      aria-label="复制"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copyText(text, label);
      }}
    >
      <Copy size={13} />
    </button>
  );
}

// ─── 交易行 ──────────────────────────────────────────────────

/** me：从这个钱包的角度显示收支（+ 收到 / − 付出） */
export function TxRow({ tx, me }: { tx: ChainTx; me?: string }) {
  let amount: ReactNode = null;
  if (me) {
    const vk = tx.vk.find((x) => x.a === me)?.d ?? 0;
    const tok = tx.tok.filter((x) => x.o === me);
    const parts: ReactNode[] = [];
    for (const t of tok)
      parts.push(
        <span key={t.m} className={t.d > 0 ? 'up' : 'down'}>
          {t.d > 0 ? '+' : '−'}
          {fmtAmount(Math.abs(t.d), t.dec)} {tx.mint === t.m && tx.amount ? tx.amount.symbol : ''}
        </span>,
      );
    const vkNet = tx.payer === me ? vk + tx.fee : vk; // 自己付的 gas 单独显示
    if (Math.abs(vkNet) >= 1)
      parts.push(
        <span key="vk" className={vkNet > 0 ? 'up' : 'down'}>
          {vkNet > 0 ? '+' : '−'}
          {fmtVk(Math.abs(vkNet) / 1e9)} VK
        </span>,
      );
    amount = parts.length ? parts : tx.payer === me ? <span className="muted">gas {fmtVk(tx.fee / 1e9)}</span> : null;
  } else if (tx.amount) {
    amount = (
      <span className="num">
        {fmtAmount(tx.amount.value)} {tx.amount.symbol}
      </span>
    );
  }
  const counter = tx.to && tx.from ? `${shortAddr(tx.from, 4)} → ${shortAddr(tx.to, 4)}` : shortAddr(tx.payer, 4);
  return (
    <a className="ch-tx" href={chainLink.tx(tx.sig)}>
      <KindIcon kind={tx.kind} ok={tx.ok} />
      <span className="ch-tx__main">
        <span className="ch-tx__title">{tx.title}</span>
        <span className="ch-tx__sub">
          {tx.time ? fmtAgo(tx.time * 1000) : `slot ${tx.slot}`} · {counter}
          {tx.memo ? ` · “${tx.memo}”` : ''}
        </span>
      </span>
      <span className="ch-tx__amt">{amount}</span>
    </a>
  );
}

export function TxList({ txs, me, empty = '还没有交易' }: { txs: ChainTx[]; me?: string; empty?: string }) {
  if (!txs.length) return <div className="empty">{empty}</div>;
  return (
    <div className="ch-txlist">
      {txs.map((t) => (
        <TxRow key={t.sig} tx={t} me={me} />
      ))}
    </div>
  );
}

// ─── 签名流程：组装 → 确认 → 本地签名 → 广播 ────────────────

export function useSigner() {
  const w = useWallet();
  const [prep, setPrep] = useState<ChainPrepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<ChainSendResult | null>(null);
  const prepare = async (body: Record<string, unknown>) => {
    if (!w) return setErr('请先创建或导入钱包');
    setErr('');
    setDone(null);
    setBusy(true);
    try {
      setPrep(await chainApi.prepare({ ...body, owner: w.address }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (): Promise<ChainSendResult | null> => {
    if (!w || !prep) return null;
    setBusy(true);
    setErr('');
    try {
      const r = await signAndSend(prep, w);
      setDone(r);
      setPrep(null);
      toast('交易已上链');
      return r;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setPrep(null);
    setDone(null);
    setErr('');
  };
  return { w, prep, busy, err, done, prepare, confirm, reset, setErr };
}

export function ConfirmPanel({ s, title = '确认交易' }: { s: ReturnType<typeof useSigner>; title?: string }) {
  if (!s.prep) return null;
  const p = s.prep;
  return (
    <div className="ch-confirm" role="dialog" aria-label={title}>
      <div className="kicker">{title}</div>
      <div className="ch-confirm__sum">{p.summary}</div>
      <div className="rows">
        <div className="row">
          <span className="row__k">Gas（用 VK 支付）</span>
          <span className="row__v num">{fmtVk(p.fee)} VK</span>
        </div>
        {p.rent > 0 && (
          <div className="row">
            <span className="row__k">新账户押金（可退回）</span>
            <span className="row__v num">{fmtVk(p.rent)} VK</span>
          </div>
        )}
        <div className="row">
          <span className="row__k">签名钱包</span>
          <span className="row__v ch-mono">{s.w ? shortAddr(s.w.address, 6) : '—'}</span>
        </div>
      </div>
      {p.warnings?.map((x) => (
        <div key={x} className="addr-preview addr-preview--warn" style={{ marginTop: 8 }}>
          {x}
        </div>
      ))}
      <div className="ch-actions">
        <button type="button" className="btn btn--ghost" disabled={s.busy} onClick={s.reset}>
          取消
        </button>
        <button type="button" className="btn btn--solid" disabled={s.busy} onClick={() => void s.confirm()}>
          {s.busy ? '签名并广播中…' : '确认签名'}
        </button>
      </div>
      <p className="card__note" style={{ marginTop: 8 }}>
        交易由服务器在链上模拟通过后，用这台设备上的私钥签名；私钥不会离开这台设备。
      </p>
    </div>
  );
}

export function SignerStatus({ s }: { s: ReturnType<typeof useSigner> }) {
  return (
    <>
      {s.err && (
        <div className="addr-preview addr-preview--warn" role="alert" style={{ marginTop: 10 }}>
          {s.err}
        </div>
      )}
      {s.done && (
        <div className="addr-preview addr-preview--ok" style={{ marginTop: 10 }}>
          ✓ 已上链（区块 {s.done.slot ?? '—'}）·{' '}
          <a className="ch-link" href={chainLink.tx(s.done.sig)}>
            查看交易 {shortAddr(s.done.sig, 6)}
          </a>
        </div>
      )}
    </>
  );
}
