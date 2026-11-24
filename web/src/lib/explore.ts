// 「探索」页的数据：成就墙（服务器推送版本号时重新拉取）、SOL 参考价位（10 分钟缓存）
import { useEffect, useState } from 'react';
import type { AchievementsView, SolLevels } from '../../../shared/types';
import { getJSON } from './api';
import { useStore } from './store';

let achCache: AchievementsView | null = null;

export function useAchievements(): AchievementsView | null {
  const rev = useStore((s) => s.achRev);
  const [v, setV] = useState(achCache);
  useEffect(() => {
    let cancelled = false;
    getJSON<AchievementsView>('/api/achievements')
      .then((x) => {
        achCache = x;
        if (!cancelled) setV(x);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rev]);
  return v;
}

let lvCache: { at: number; v: SolLevels } | null = null;

export function useSolLevels(): SolLevels | null {
  const [v, setV] = useState(lvCache?.v ?? null);
  useEffect(() => {
    if (lvCache && Date.now() - lvCache.at < 600_000) return;
    let cancelled = false;
    getJSON<SolLevels>('/api/sol/levels')
      .then((x) => {
        lvCache = { at: Date.now(), v: x };
        if (!cancelled) setV(x);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return v;
}
