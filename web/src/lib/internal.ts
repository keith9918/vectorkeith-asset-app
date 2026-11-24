// 公司内部质押：按身份拉取（管理员全部、员工只看自己），服务器推送版本号时自动刷新
import { useCallback, useEffect, useState } from 'react';
import type { InternalView, PreparedTransfer } from '../../../shared/types';
import { getJSON, postJSON } from './api';
import { useStore } from './store';

export function useInternal(): { view: InternalView | null; at: number; error: string; reload: () => void } {
  const rev = useStore((s) => s.internalRev);
  const role = useStore((s) => s.access?.role ?? 'public');
  const sid = useStore((s) => s.access?.sid ?? '');
  const [v, setV] = useState<{ view: InternalView; at: number } | null>(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getJSON<InternalView>('/api/internal')
      .then((x) => {
        if (cancelled) return;
        setV({ view: x, at: Date.now() });
        setError('');
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [rev, role, sid, nonce]);
  return { view: v?.view ?? null, at: v?.at ?? Date.now(), error, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

export const internalAdmin = (body: Record<string, unknown>) => postJSON<{ ok: boolean; id?: string }>('/api/admin/internal', body);
export const prepareInternal = (body: Record<string, unknown>) => postJSON<PreparedTransfer>('/api/internal/prepare', body);
export const internalSent = (sig: string, items: PreparedTransfer['items']) => postJSON('/api/internal/sent', { sig, items }).catch(() => {});
export const requestRedeem = (body: Record<string, unknown>) => postJSON('/api/internal/redeem', body);

export const LEDGER_LABEL = { deposit: '充值', withdraw: '赎回', interest: '分息' } as const;
