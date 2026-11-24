// 公司资产走势：公司钱包 SOL 合计的历史曲线。首次拉取，之后在资金流水变化时（防抖）自动刷新
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { TreasuryHistoryPoint } from '../../../shared/types';
import { getJSON } from './api';
import { getState, useStore } from './store';

let points: TreasuryHistoryPoint[] = [];
let timer: number | undefined;
let users = 0;
let poll: number | undefined;
let lastKey = '';
const listeners = new Set<() => void>();

async function refresh() {
  try {
    points = await getJSON<TreasuryHistoryPoint[]>('/api/treasury/history');
    listeners.forEach((l) => l());
  } catch {
    /* 保留旧数据 */
  }
}

function refreshSoon(ms = 800) {
  clearTimeout(timer);
  timer = window.setTimeout(refresh, ms);
}

/** 流水条数、钱包名单、回填进度变化时重新拉取曲线 */
function watchKey() {
  const t = getState().snap?.treasury;
  return t ? `${t.activityCount}|${t.wallets.map((w) => w.address).join(',')}|${t.status.backfillDone}` : '';
}

export function useTreasuryHistory(): TreasuryHistoryPoint[] {
  useEffect(() => {
    if (users++ === 0) {
      void refresh();
      lastKey = watchKey();
      poll = window.setInterval(() => {
        const k = watchKey();
        if (k !== lastKey) {
          lastKey = k;
          refreshSoon();
        }
      }, 1000);
    }
    return () => {
      if (--users === 0) clearInterval(poll);
    };
  }, []);
  const p = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => points,
  );
  // 曲线最后一个点用实时总余额（余额变化比流水先到）
  const totalSol = useStore((s) => s.snap?.treasury.totalSol);
  const solUsd = useStore((s) => s.snap?.solPrice.usd);
  return useMemo(() => {
    if (!p.length || totalSol === undefined || !Number.isFinite(totalSol)) return p;
    const last = p[p.length - 1];
    const now = Math.floor(Date.now() / 1000);
    return [...p.slice(0, -1), { t: Math.max(last.t, now), sol: totalSol, solUsd: solUsd || last.solUsd }];
  }, [p, totalSol, solUsd]);
}
