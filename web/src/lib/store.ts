// 实时状态仓库：WebSocket 接收服务器推送（自动重连、心跳测延迟），组件按需订阅
import { useSyncExternalStore } from 'react';
import { compareTrades } from '../../../shared/candles';
import type { AccessInfo, ServerMessage, Snapshot, Trade } from '../../../shared/types';
import { clearToken, getJSON, onNeedLogin, postJSON, saveToken, wsUrl } from './api';

/** login = 需要输入访问码（"需要访问码"模式下还没登录，或登录已失效） */
export type Conn = 'connecting' | 'live' | 'offline' | 'login';

export interface State {
  conn: Conn;
  access: AccessInfo | null; // 当前身份（公开 / 访客 / 股东 / 管理员）
  holdersRev: number; // 股东名册版本：变化时重新拉取 /api/shareholders
  achRev: number; // 成就墙版本：变化时重新拉取 /api/achievements
  internalRev: number; // 内部质押版本：变化时重新拉取 /api/internal
  simRev: number; // USVK 模拟盘版本：有新成交 / 账号变化时重新拉取 /api/sim
  goalReached: number; // 刚达成目标的时刻（放烟花）
  unlocks: { keys: string[]; at: number } | null; // 刚解锁的成就（播放解锁动画）
  rtt: number | null; // App ↔ 服务器往返延迟（毫秒）
  snap: Snapshot | null;
  trades: Trade[]; // 最近成交（升序）
  slot: number;
  slotMs: number;
  lastTradeId: string | null;
  lastTradeAt: number; // 本地收到最新成交的时刻
}

const MAX_TRADES = 600;

let state: State = {
  conn: 'connecting',
  access: null,
  holdersRev: 0,
  achRev: 0,
  internalRev: 0,
  simRev: 0,
  goalReached: 0,
  unlocks: null,
  rtt: null,
  snap: null,
  trades: [],
  slot: 0,
  slotMs: 0,
  lastTradeId: null,
  lastTradeAt: 0,
};

const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const getState = () => state;

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
  );
}

// ─── 给图表用的事件总线（增量更新，不触发 React 重渲染） ─────────

type TradeListener = (t: Trade) => void;
const tradeListeners = new Set<TradeListener>();
const resetListeners = new Set<() => void>();

export function onTrade(cb: TradeListener) {
  tradeListeners.add(cb);
  return () => void tradeListeners.delete(cb);
}
/** 全量数据变化（快照重载、成交被剔除等）：图表应重新拉取 */
export function onReset(cb: () => void) {
  resetListeners.add(cb);
  return () => void resetListeners.delete(cb);
}

// ─── 消息处理 ─────────────────────────────────────────────────

function patchSnap(patch: Partial<Snapshot>) {
  if (!state.snap) return;
  set({ snap: { ...state.snap, ...patch } });
}

function handle(msg: ServerMessage) {
  switch (msg.t) {
    case 'snapshot': {
      const hadSnap = !!state.snap;
      set({ snap: msg.data, trades: msg.data.trades.slice(-MAX_TRADES), slot: msg.data.status.slot, slotMs: msg.data.status.slotMs });
      if (hadSnap) resetListeners.forEach((l) => l());
      break;
    }
    case 'trade': {
      if (state.trades.some((t) => t.id === msg.trade.id)) break;
      let trades = [...state.trades, msg.trade];
      const prev = state.trades[state.trades.length - 1];
      if (prev && compareTrades(prev, msg.trade) > 0) trades.sort(compareTrades);
      if (trades.length > MAX_TRADES) trades = trades.slice(-MAX_TRADES);
      set({
        trades,
        lastTradeId: msg.trade.id,
        lastTradeAt: Date.now(),
        snap: state.snap
          ? { ...state.snap, curve: msg.curve ?? state.snap.curve, market: msg.market ?? state.snap.market, stats: msg.stats }
          : null,
      });
      tradeListeners.forEach((l) => l(msg.trade));
      break;
    }
    case 'trade_update':
      set({ trades: state.trades.map((t) => (t.id === msg.trade.id ? msg.trade : t)) });
      break;
    case 'trade_remove':
      set({ trades: state.trades.filter((t) => t.id !== msg.id) });
      resetListeners.forEach((l) => l());
      break;
    case 'curve':
      patchSnap({ curve: msg.curve, market: msg.market ?? state.snap?.market ?? null });
      break;
    case 'holders':
      patchSnap({ holders: msg.holders, holderCount: msg.holderCount, company: msg.company, creatorVault: msg.creatorVault, supply: msg.supply ?? state.snap?.supply });
      break;
    case 'sol':
      patchSnap({ solPrice: msg.solPrice });
      break;
    case 'treasury':
      patchSnap({ treasury: msg.treasury });
      break;
    case 'stats':
      patchSnap({ stats: msg.stats });
      break;
    case 'status':
      patchSnap({ status: msg.status });
      break;
    case 'config':
      patchSnap({ config: msg.config });
      break;
    case 'token':
      patchSnap({ token: msg.token });
      break;
    case 'slot':
      set({ slot: msg.slot, slotMs: msg.ms });
      break;
    case 'shareholders':
      set({ holdersRev: msg.rev });
      break;
    case 'internal':
      set({ internalRev: msg.rev });
      break;
    case 'sim':
      set({ simRev: msg.rev });
      break;
    case 'goal':
      patchSnap({ goal: msg.goal });
      if (msg.reached) set({ goalReached: Date.now() });
      break;
    case 'achievements':
      set({ achRev: msg.rev, unlocks: msg.unlocked.length ? { keys: msg.unlocked, at: Date.now() } : state.unlocks });
      break;
    case 'access':
      // 访问设置变了：重新确认自己的身份（可能需要重新输入访问码）
      void checkAccess().then((info) => info?.needLogin && lockOut());
      break;
    case 'pong':
      if (pingSent.has(msg.id)) {
        set({ rtt: Math.round(performance.now() - pingSent.get(msg.id)!) });
        pingSent.delete(msg.id);
      }
      break;
  }
}

// ─── 连接管理 ─────────────────────────────────────────────────

let ws: WebSocket | null = null;
let retry = 0;
let pingTimer: number | undefined;
let reconnectTimer: number | undefined;
let pingId = 0;
const pingSent = new Map<number, number>();

function ping() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const id = ++pingId;
  pingSent.set(id, performance.now());
  if (pingSent.size > 20) pingSent.delete(pingSent.keys().next().value!);
  ws.send(JSON.stringify({ t: 'ping', id, clientTime: Date.now() }));
}

// ─── 身份 ─────────────────────────────────────────────────────

let accessSeq = 0;
async function checkAccess(): Promise<AccessInfo | null> {
  const seq = ++accessSeq;
  try {
    const info = await getJSON<AccessInfo>('/api/access');
    if (seq !== accessSeq) return null; // 已经有更新的检查（例如刚刚登录），以它为准
    set({ access: info, holdersRev: state.holdersRev + 1 });
    return info;
  } catch {
    return null; // 网络问题：先按原状态继续
  }
}

/** 没有查看权限了：断开连接、清掉已加载的数据，显示输入访问码的页面 */
function lockOut() {
  const sock = ws;
  ws = null;
  sock?.close();
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);
  set({ conn: 'login', snap: null, trades: [], rtt: null });
}
onNeedLogin(() => {
  if (state.conn !== 'login') void checkAccess().then((info) => info?.needLogin && lockOut());
});

/** 输入访问码登录（股东查看码 / 访问密码 / 管理员密钥） */
export async function loginWithCode(code: string, persist = true): Promise<AccessInfo> {
  const r = await postJSON<{ token: string; info: AccessInfo }>('/api/auth/login', { code: code.trim() });
  saveToken(r.token, persist);
  set({ access: r.info, holdersRev: state.holdersRev + 1 });
  reconnectNow();
  return r.info;
}

/** 账号 + 密码登录（模拟盘：admin / VK1–VK12 / 管理员开的账号） */
export async function loginWithPassword(user: string, password: string, persist = true): Promise<AccessInfo> {
  const r = await postJSON<{ token: string; info: AccessInfo }>('/api/auth/login', { user: user.trim(), password });
  saveToken(r.token, persist);
  set({ access: r.info, holdersRev: state.holdersRev + 1 });
  reconnectNow();
  return r.info;
}

/** 管理员在「设置」里验证密钥后，服务器同时发了管理员令牌 */
export function adoptToken(token: string, persist: boolean) {
  saveToken(token, persist);
  void checkAccess();
  reconnectNow();
}

/** 退出登录（回到公开身份；"需要访问码"模式下会回到输入访问码的页面） */
export async function logout() {
  clearToken();
  await checkAccess();
  reconnectNow();
}

let checking = false;
let connectSeq = 0;

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (checking) return;
  clearTimeout(reconnectTimer);
  set({ conn: 'connecting' });
  // 先确认身份：需要访问码却没登录时，直接显示登录页，不去连 WebSocket
  checking = true;
  const seq = ++connectSeq;
  void checkAccess().then((info) => {
    if (seq !== connectSeq) return;
    checking = false;
    if (info?.needLogin) lockOut();
    else openSocket();
  });
}

function openSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const sock = new WebSocket(wsUrl());
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    set({ conn: 'live' });
    ping();
    clearInterval(pingTimer);
    pingTimer = window.setInterval(ping, 5_000);
  };
  sock.onmessage = (e) => {
    try {
      handle(JSON.parse(e.data));
    } catch (err) {
      console.error('消息处理失败', err);
    }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    clearInterval(pingTimer);
    if (e.code === 4401) {
      // 服务器拒绝：需要访问码，或登录已失效（改了密码 / 查看码）
      void checkAccess();
      lockOut();
      return;
    }
    set({ conn: 'offline', rtt: null });
    const delay = Math.min(10_000, 800 * 2 ** retry++);
    reconnectTimer = window.setTimeout(connect, delay);
  };
  sock.onerror = () => sock.close();
}

export function reconnectNow() {
  retry = 0;
  const old = ws;
  ws = null;
  old?.close();
  checking = false; // 放弃进行中的身份检查，用最新的令牌重新来
  connect();
}

// 回到前台时立即恢复连接（手机切后台常被系统断开）；等待输入访问码时不自动连
document.addEventListener('visibilitychange', () => {
  if (state.conn === 'login') return;
  if (document.visibilityState === 'visible' && (!ws || ws.readyState > WebSocket.OPEN)) {
    retry = 0;
    connect();
  }
});
window.addEventListener('online', () => {
  if (state.conn === 'login') return;
  retry = 0;
  connect();
});
