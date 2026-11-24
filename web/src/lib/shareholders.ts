// 股东名册：按自己的身份从服务器拉取（管理员看全部、股东只看自己、访客只看合计）
import { useEffect, useState } from 'react';
import type { Payout, ShareholderView } from '../../../shared/types';
import { loadAdminKey } from './admin';
import { getJSON, postJSON } from './api';
import { useStore } from './store';

let cache: { key: string; view: ShareholderView } | null = null;

/** 名册或发放记录有变化（服务器推送 rev）、身份变化时自动重新拉取 */
export function useShareholders(): { view: ShareholderView | null; error: string; reload: () => void } {
  const rev = useStore((s) => s.holdersRev);
  const role = useStore((s) => s.access?.role ?? 'public');
  const sid = useStore((s) => s.access?.sid ?? '');
  const conn = useStore((s) => s.conn);
  const key = `${role}:${sid}`;
  const [view, setView] = useState<ShareholderView | null>(cache?.key === key ? cache.view : null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (conn === 'login') return;
    let cancelled = false;
    getJSON<ShareholderView>('/api/shareholders')
      .then((v) => {
        if (cancelled) return;
        cache = { key, view: v };
        setView(v);
        setError('');
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [rev, key, nonce, conn]);
  return { view: view && view.role === role ? view : cache?.key === key ? cache.view : null, error, reload: () => setNonce((n) => n + 1) };
}

/** 收款钱包 → 股东名字（资金流水里显示"转给 张三"） */
export function holderLabels(view: ShareholderView | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of view?.holders ?? []) for (const w of h.wallets) m.set(w, h.name);
  return m;
}

/** 链上交易签名 → 分红发放记录（资金流水里把这笔"转出"标成"分红发放"） */
export function payoutsBySig(view: ShareholderView | null): Map<string, Payout[]> {
  const m = new Map<string, Payout[]>();
  for (const p of view?.payouts ?? []) if (p.sig && !p.excluded) m.set(p.sig, [...(m.get(p.sig) ?? []), p]);
  return m;
}

export const fmtCode = (c?: string) => (c ? `${c.slice(0, 4)}-${c.slice(4)}` : '');

export function holderAdmin(body: Record<string, unknown>) {
  return postJSON<{ ok: boolean; id?: string }>('/api/admin/shareholder', body, loadAdminKey());
}

export function payoutAdmin(body: Record<string, unknown>) {
  return postJSON<{ ok: boolean; id?: string }>('/api/admin/payout', body, loadAdminKey());
}
