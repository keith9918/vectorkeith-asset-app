import { Blocks, ChartCandlestick, Info, Landmark, PiggyBank, Settings, Sparkles, Users, X } from 'lucide-react';
import { tokenImage } from '../lib/api';
import { fmtMoney, type Cur } from '../lib/format';
import { go, useRoute, useSolTo, type Route } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { reconnectNow, useStore } from '../lib/store';

/** 当前主货币 / 副货币（人民币与美元始终同时显示） */
export function useCur(): { primary: Cur; secondary: Cur } {
  const p = usePrefs().primary;
  return { primary: p, secondary: p === 'cny' ? 'usd' : 'cny' };
}

/** 双币种金额：主货币 + 副货币（可选再加 SOL） */
export function Dual({ sol, compact, withSol, sep = ' · ' }: { sol: number; compact?: boolean; withSol?: boolean; sep?: string }) {
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  return (
    <>
      {fmtMoney(sol * solTo[primary], primary, { compact })}
      <span className="dim">
        {sep}
        {fmtMoney(sol * solTo[secondary], secondary, { compact })}
      </span>
      {withSol && (
        <span className="muted">
          {sep}
          {fmtMoney(sol, 'sol', { compact })}
        </span>
      )}
    </>
  );
}

export function LivePill() {
  const conn = useStore((s) => s.conn);
  const rtt = useStore((s) => s.rtt);
  if (conn === 'live')
    return (
      <span className="live-pill live-pill--live" title="与服务器的往返延迟">
        <i className="live-dot" />
        实时{rtt !== null ? ` ${rtt}ms` : ''}
      </span>
    );
  return (
    <button type="button" className={`live-pill ${conn === 'offline' ? 'live-pill--offline' : ''}`} onClick={reconnectNow}>
      <i className="live-dot" />
      {conn === 'offline' ? '离线 · 重连' : '连接中'}
    </button>
  );
}

export function Header() {
  const token = useStore((s) => s.snap?.token);
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const route = useRoute();
  return (
    <header className="header">
      <img className="header__logo" src={tokenImage(token)} alt="VectorKeith" />
      <div className="header__brand">
        <div className="header__name">VECTORKEITH</div>
        <div className="header__sub num">
          {solTo.usd > 0 ? `SOL ${fmtMoney(solTo[primary], primary)} · ${fmtMoney(solTo[secondary], secondary)}` : '链上数据加载中'}
        </div>
      </div>
      <LivePill />
      <button
        type="button"
        className={`icon-btn ${route === 'settings' ? 'icon-btn--on' : ''}`}
        aria-label={route === 'settings' ? '关闭设置' : '设置'}
        onClick={() => go(route === 'settings' ? 'assets' : 'settings')}
      >
        {route === 'settings' ? <X size={18} /> : <Settings size={18} />}
      </button>
    </header>
  );
}

const TABS: { route: Route; label: string; Icon: typeof Landmark }[] = [
  { route: 'assets', label: '资产', Icon: Landmark },
  { route: 'shareholders', label: '股东', Icon: Users },
  { route: 'staking', label: '质押', Icon: PiggyBank },
  { route: 'sim', label: '模拟盘', Icon: ChartCandlestick },
  { route: 'chain', label: 'VK链', Icon: Blocks },
  { route: 'explore', label: '探索', Icon: Sparkles },
  { route: 'info', label: '信息', Icon: Info },
];

export function TabBar() {
  const route = useRoute();
  return (
    <nav className="tabbar" aria-label="主导航" style={{ gridTemplateColumns: `repeat(${TABS.length}, 1fr)` }}>
      {TABS.map(({ route: r, label, Icon }) => (
        <a key={r} href={`#/${r}`} className={`tab ${route === r ? 'tab--active' : ''}`} aria-current={route === r ? 'page' : undefined}>
          <Icon strokeWidth={1.8} />
          {label}
        </a>
      ))}
    </nav>
  );
}
