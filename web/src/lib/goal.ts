// 公司目标：按最近 30 天的平均增长速度估算达成日期
import type { TreasuryHistoryPoint } from '../../../shared/types';
import { postJSON } from './api';

export interface GoalEta {
  remaining: number; // 还差多少 SOL
  pct: number; // 进度 0–1
  ratePerDay: number; // 最近平均每天增加多少 SOL
  windowDays: number;
  eta?: number; // 预计达成时间（毫秒）
}

export function goalEta(points: TreasuryHistoryPoint[], total: number, target: number, startSol = 0): GoalEta {
  const remaining = Math.max(0, target - total);
  // 进度：从 0 算起（直观），设定时已有的部分也算
  const pct = target > 0 ? Math.max(0, Math.min(1, total / target)) : 0;
  const now = Date.now() / 1000;
  const win = 30 * 86400;
  let base = startSol;
  let from = now - win;
  if (points.length) {
    const first = points[0];
    if (first.t > from) {
      from = first.t;
      base = first.sol;
    } else {
      let b = first.sol;
      for (const p of points) {
        if (p.t > from) break;
        b = p.sol;
      }
      base = b;
    }
  }
  const windowDays = Math.max(1, (now - from) / 86400);
  const ratePerDay = (total - base) / windowDays;
  const days = ratePerDay > 0.0001 ? remaining / ratePerDay : Infinity;
  return { remaining, pct, ratePerDay, windowDays, eta: remaining > 0 && days < 5 * 365 ? Date.now() + days * 86400_000 : undefined };
}

export const saveGoal = (target: number | null, label?: string) => postJSON('/api/admin/goal', { target, label });
