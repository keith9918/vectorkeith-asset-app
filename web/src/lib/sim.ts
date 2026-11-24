// USVK 模拟盘：按自己的身份拉取盘口（名字打码因人而异，所以不广播内容，只广播版本号）
import { useEffect, useSyncExternalStore } from 'react';
import type { SimKind, SimTick, SimTrade, SimView } from '../../../shared/types';
import { getJSON, postJSON } from './api';
import { getState, useStore } from './store';

export const KIND_LABEL: Record<SimKind, string> = { admin: '公司', staff: '员工', client: '客户' };

let current: { key: string; view: SimView } | null = null;
let error = '';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let seq = 0;

function idKey() {
  const a = getState().access;
  return `${a?.role ?? 'public'}:${a?.sid ?? ''}`;
}

async function load() {
  const my = ++seq;
  const key = idKey();
  try {
    const view = await getJSON<SimView>('/api/sim');
    if (my !== seq) return; // 已经有更新的请求
    current = { key, view };
    error = '';
  } catch (e) {
    if (my !== seq) return;
    error = (e as Error).message;
  }
  emit();
}

/** 成交后服务器直接返回了最新盘口：先用它（推送来的新版本号还会再拉一次） */
function adopt(view: SimView) {
  if (current && view.rev < current.view.rev) return;
  current = { key: idKey(), view };
  emit();
}

export function useSim(): { view: SimView | null; error: string } {
  const rev = useStore((s) => s.simRev);
  const role = useStore((s) => s.access?.role ?? 'public');
  const sid = useStore((s) => s.access?.sid ?? '');
  const conn = useStore((s) => s.conn);
  const key = `${role}:${sid}`;
  useEffect(() => {
    if (conn === 'login') return;
    void load();
  }, [rev, key, conn]);
  const snap = useSyncExternalStore(subscribe, () => current);
  const err = useSyncExternalStore(subscribe, () => error);
  // 身份变了（登录 / 退出）：旧身份的数据不能再显示
  return { view: snap && snap.key === key ? snap.view : null, error: err };
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

// ─── K 线数据：这一轮的全部成交（增量拉取） ─────────────────────

let ticks: { key: string; startedAt: number; list: SimTick[] } | null = null;
const tickListeners = new Set<() => void>();
let tickSeq = 0;

async function loadTicks() {
  const my = ++tickSeq;
  const key = idKey();
  const have = ticks && ticks.key === key ? ticks : null;
  const after = have?.list[have.list.length - 1]?.id ?? 0;
  try {
    let r = await getJSON<{ startedAt: number; ticks: SimTick[] }>(`/api/sim/trades?after=${after}`);
    if (have && r.startedAt !== have.startedAt) r = await getJSON(`/api/sim/trades?after=0`); // 重新开盘了：整轮重拉
    if (my !== tickSeq) return;
    const list = have && r.startedAt === have.startedAt ? [...have.list, ...r.ticks.filter((t) => t.id > after)] : r.ticks;
    ticks = { key, startedAt: r.startedAt, list };
    tickListeners.forEach((l) => l());
  } catch {
    /* 下次版本号变化时再试 */
  }
}

/** 一轮里的全部成交（旧 → 新）；有新成交时自动补上 */
export function useSimTicks(): SimTick[] | null {
  const rev = useStore((s) => s.simRev);
  const role = useStore((s) => s.access?.role ?? 'public');
  const sid = useStore((s) => s.access?.sid ?? '');
  const conn = useStore((s) => s.conn);
  const key = `${role}:${sid}`;
  useEffect(() => {
    if (conn === 'login') return;
    void loadTicks();
  }, [rev, key, conn]);
  const snap = useSyncExternalStore(
    (l) => {
      tickListeners.add(l);
      return () => void tickListeners.delete(l);
    },
    () => ticks,
  );
  return snap && snap.key === key ? snap.list : null;
}

// ─── 交易密码解锁（管理员）：令牌只放内存，刷新页面后要重新输 ─────────

let unlock: { token: string; exp: number } | null = null;
const unlockListeners = new Set<() => void>();

export function useUnlock(): { token: string; exp: number } | null {
  return useSyncExternalStore(
    (l) => {
      unlockListeners.add(l);
      return () => unlockListeners.delete(l);
    },
    () => (unlock && unlock.exp > Date.now() ? unlock : null),
  );
}

function setUnlock(u: { token: string; exp: number } | null) {
  unlock = u;
  unlockListeners.forEach((l) => l());
}

export async function unlockTrading(password: string) {
  const r = await postJSON<{ unlock: string; expiresAt: number }>('/api/sim/admin', { action: 'unlock', password });
  setUnlock({ token: r.unlock, exp: r.expiresAt });
}

export async function lockTrading() {
  const t = unlock?.token;
  setUnlock(null);
  if (t) await postJSON('/api/sim/admin', { action: 'lock', unlock: t }).catch(() => {});
}

export interface TradeInput {
  side: 'buy' | 'sell';
  sol?: number;
  all?: boolean;
  tokens?: number;
  pct?: number;
  minOut: number;
}

export async function simTrade(input: TradeInput): Promise<SimTrade> {
  try {
    const r = await postJSON<{ trade: SimTrade; view: SimView }>('/api/sim/trade', { ...input, unlock: unlock?.token });
    adopt(r.view);
    return r.trade;
  } catch (e) {
    if ((e as Error).message === '请先输入交易密码') setUnlock(null);
    throw e;
  }
}

export async function simAdmin<T = { ok: true; id?: string; code?: string }>(body: Record<string, unknown>): Promise<T> {
  const r = await postJSON<T>('/api/sim/admin', body);
  void load();
  return r;
}

/** 自己改登录密码；返回的新令牌替换这台设备的登录（其他设备要重新登录） */
export function changeMyPassword(old: string, next: string) {
  return postJSON<{ ok: true; token?: string }>('/api/sim/password', { old, next });
}
