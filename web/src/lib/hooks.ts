import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { valueCompany, type CompanyValuation } from '../../../shared/company';
import type { Cur } from './format';
import { useStore } from './store';

/** 公司资产估值（价格/持仓/汇率任一变化都会实时重算） */
export function useValuation(): CompanyValuation | null {
  const company = useStore((s) => s.snap?.company);
  const market = useStore((s) => s.snap?.market);
  const solPrice = useStore((s) => s.snap?.solPrice);
  const supply = useStore((s) => s.snap?.supply ?? 1e9);
  const ratio = useStore((s) => s.snap?.config.dividendRatio ?? 0.1);
  const fees = useStore((s) => s.snap?.fees);
  return useMemo(() => {
    if (!company || !market || !solPrice || !fees) return null;
    return valueCompany(company, market, solPrice, supply, ratio, fees.protocolBps + fees.creatorBps);
  }, [company, market, solPrice, supply, ratio, fees]);
}

/** 1 SOL 折合多少某货币 */
export function useSolTo(): Record<Cur, number> {
  const p = useStore((s) => s.snap?.solPrice);
  return useMemo(() => ({ sol: 1, usd: p?.usd ?? 0, cny: (p?.usd ?? 0) * (p?.usdCny ?? 0) }), [p]);
}

/** 当前跟踪代币的符号（元数据还没加载时显示"代币"） */
export function useSymbol(): string {
  return useStore((s) => s.snap?.token?.symbol || '代币');
}

/** 当前代币价格（SOL） */
export function usePriceSol(): number {
  return useStore((s) => s.snap?.market?.priceSol ?? 0);
}

/** 每 interval 毫秒刷新一次的当前时间 */
export function useNow(interval = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

/** 数值变化时返回 flash-up / flash-down 动画类名 */
export function useFlash(value: number | undefined | null): string {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  useEffect(() => {
    if (value == null || prev.current == null || value === prev.current) {
      prev.current = value;
      return;
    }
    const next = value > prev.current ? 'flash-up' : 'flash-down';
    prev.current = value;
    setCls('');
    const raf = requestAnimationFrame(() => setCls(next)); // 先移除再加上，连续变化也能重播动画
    const t = setTimeout(() => setCls(''), 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [value]);
  return cls;
}

// ─── 简单 hash 路由 ───────────────────────────────────────────

export type Route = 'assets' | 'shareholders' | 'staking' | 'sim' | 'chain' | 'explore' | 'info' | 'settings' | 'screen' | 'report';
// 行情（market）、持仓（holders）页面暂时下线，旧链接会回到资产页；恢复时加回这里和 Shell.tsx 的 TABS、App.tsx 的 PAGES
const ROUTES: Route[] = ['assets', 'shareholders', 'staking', 'sim', 'chain', 'explore', 'info', 'settings', 'screen', 'report'];
/** 全屏页面：没有顶部栏和底部导航 */
export const FULLSCREEN: Route[] = ['screen', 'report'];

function readRoute(): Route {
  const r = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] as Route;
  return ROUTES.includes(r) ? r : 'assets';
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('hashchange', l);
      return () => window.removeEventListener('hashchange', l);
    },
    readRoute,
  );
}

/** 读取 hash 里的查询参数，例如 #/settings?add=地址 */
export function useHashParam(name: string): string {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('hashchange', l);
      return () => window.removeEventListener('hashchange', l);
    },
    () => new URLSearchParams(location.hash.split('?')[1] ?? '').get(name) ?? '',
  );
}

export const go = (r: Route) => {
  location.hash = `#/${r}`;
};
