// 用户偏好（仅本机生效，存 localStorage；读写失败时退回默认值）
import { useSyncExternalStore } from 'react';
import type { Quote } from '../../../shared/candles';
import type { SolRange } from '../../../shared/types';

export interface Prefs {
  primary: 'cny' | 'usd'; // 主显示货币（另一种同时显示在旁边）
  colors: 'greenUp' | 'redUp';
  chartTf: string;
  chartQuote: Quote;
  chartMode: 'price' | 'mcap';
  chartMA: boolean;
  holdPct: string; // 分红计算器：我的持股比例 %
  historyRange: '24h' | '7d' | 'all';
  solRange: SolRange; // SOL 价格图的时间范围
  solChart: 'line' | 'candle';
  stakeTab: 'company' | 'personal' | 'internal'; // 质押页：公司质押 / 个人质押 / 内部质押
  fx: boolean; // 到账特效（金币雨、解锁动画）
  sound: boolean; // 音效（默认关）
  voice: boolean; // 语音播报（"VectorKeith 到账 xx SOL"，默认关）
  mascot: boolean; // 首页吉祥物
}

const KEY = 'vk.prefs.v1';
const DEFAULTS: Prefs = {
  primary: 'cny',
  colors: 'greenUp',
  chartTf: '1m',
  chartQuote: 'usd',
  chartMode: 'price',
  chartMA: true,
  holdPct: '1',
  historyRange: 'all',
  solRange: '7d',
  solChart: 'line',
  stakeTab: 'company',
  fx: true,
  sound: false,
  voice: false,
  mascot: true,
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

let prefs = load();
const listeners = new Set<() => void>();

function applyDom() {
  document.documentElement.dataset.colors = prefs.colors;
}
applyDom();

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式等情况下不持久化 */
  }
  applyDom();
  listeners.forEach((l) => l());
}

export function getPrefs() {
  return prefs;
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}
