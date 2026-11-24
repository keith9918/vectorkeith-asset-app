// 质押页面的数据：公司质押总览（每分钟刷新）、股东个人质押、任意钱包查询、交易组装
import { useCallback, useEffect, useState } from 'react';
import type { HolderStaking, PreparedStakeTx, StakePositions, StakingView } from '../../../shared/types';
import { getJSON, postJSON } from './api';
import { useStore } from './store';

let viewCache: StakingView | null = null;

export function useStaking(): { view: StakingView | null; reload: () => void } {
  const [v, setV] = useState(viewCache);
  const [nonce, setNonce] = useState(0);
  const staked = useStore((s) => s.snap?.treasury.stakedSol);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getJSON<StakingView>('/api/staking')
        .then((x) => {
          viewCache = x;
          if (!cancelled) setV(x);
        })
        .catch(() => {});
    void load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [nonce, staked]);
  return { view: v, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

export function useHolderStaking(enabled: boolean): { list: HolderStaking[] | null; error: string } {
  const [list, setList] = useState<HolderStaking[] | null>(null);
  const [error, setError] = useState('');
  const rev = useStore((s) => s.holdersRev);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getJSON<HolderStaking[]>('/api/stake/holders')
      .then((x) => !cancelled && setList(x))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [enabled, rev]);
  return { list, error };
}

export const lookupStake = (address: string, fresh = false) => getJSON<StakePositions>(`/api/stake/wallet?address=${encodeURIComponent(address.trim())}${fresh ? '&fresh=1' : ''}`);

export const prepareStake = (body: Record<string, unknown>) => postJSON<PreparedStakeTx>('/api/stake/prepare', body);

export const stakeSent = (owner: string) => postJSON('/api/stake/sent', { owner }).catch(() => {});

/** 年化 apy%、每期 epochSec 秒复投，days 天后的收益（SOL） */
export function projectedEarnings(sol: number, apyPct: number, days: number, epochSec: number) {
  const epochsPerYear = (365.25 * 86400) / epochSec;
  const perEpoch = (1 + apyPct / 100) ** (1 / epochsPerYear) - 1;
  const n = (days * 86400) / epochSec;
  return sol * ((1 + perEpoch) ** n - 1);
}

export function fmtDuration(sec: number) {
  if (!(sec > 0)) return '马上';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${Math.max(1, m)} 分钟`;
}

export const STATUS_LABEL = { activating: '生效中（下一期开始赚收益）', active: '质押中', deactivating: '解除中（冷却）', inactive: '可提取' } as const;
export const STATUS_SHORT = { activating: '生效中', active: '质押中', deactivating: '冷却中', inactive: '可提取' } as const;
