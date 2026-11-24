import { useMemo } from 'react';
import type { Trade } from '../../../shared/types';
import { solscan } from '../lib/api';
import { fmtClock, fmtCompact, fmtMoney, fmtShortDate, fmtSol, shortAddr, type Cur } from '../lib/format';
import { useNow, useSymbol } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useStore } from '../lib/store';

function timeLabel(t: Trade, now: number) {
  const ms = t.chainMs ?? t.recvMs;
  if (ms) return { main: fmtClock(ms), sub: `.${String(new Date(ms).getMilliseconds()).padStart(3, '0')}` };
  const at = t.ts * 1000;
  return now - at < 20 * 3600_000 ? { main: fmtClock(at), sub: '' } : { main: fmtShortDate(at).slice(0, 5), sub: fmtShortDate(at).slice(6) };
}

export function TradeList({ limit = 40 }: { limit?: number }) {
  const trades = useStore((s) => s.trades);
  const companyCfg = useStore((s) => s.snap?.config.companyWallets);
  const lastId = useStore((s) => s.lastTradeId);
  const lastAt = useStore((s) => s.lastTradeAt);
  const solPrice = useStore((s) => s.snap?.solPrice);
  const prefs = usePrefs();
  const symbol = useSymbol();
  const now = useNow(5000);
  const cur: Cur = prefs.primary;

  const company = useMemo(() => new Map((companyCfg ?? []).map((w) => [w.address, w.label])), [companyCfg]);
  const list = useMemo(() => trades.slice(-limit).reverse(), [trades, limit]);
  const toCur = (sol: number, t: Trade) => {
    const usd = sol * (t.solUsd || solPrice?.usd || 0);
    return cur === 'usd' ? usd : usd * (solPrice?.usdCny ?? 0);
  };

  if (!list.length) return <div className="muted" style={{ fontSize: 12, padding: '12px 0' }}>暂无成交记录</div>;

  return (
    <div className="trades" role="table" aria-label="实时成交">
      <div className="trades__head" role="row">
        <span>时间</span>
        <span>方向</span>
        <span>SOL / {cur === 'cny' ? '¥' : '$'}</span>
        <span>{symbol}</span>
        <span>钱包</span>
      </div>
      {list.map((t) => {
        const tl = timeLabel(t, now);
        const label = company.get(t.user);
        const fresh = t.id === lastId && Date.now() - lastAt < 2500;
        return (
          <a
            key={t.id}
            role="row"
            className={`trade ${fresh ? 'trade--new' : ''}`}
            href={solscan.tx(t.sig)}
            target="_blank"
            rel="noreferrer"
            title={`${t.isBuy ? '买入' : '卖出'} ${fmtSol(t.sol)} SOL · slot ${t.slot}${t.status === 'processed' ? ' · 待确认' : ''}`}
          >
            <span className="trade__time">
              {tl.main}
              <span className="muted" style={{ fontSize: 10 }}>
                {tl.sub}
              </span>
            </span>
            <span className={`trade__side ${t.isBuy ? 'up' : 'down'}`}>{t.isBuy ? '买入' : '卖出'}</span>
            <span>
              <div>{fmtSol(t.sol)}</div>
              <div className="muted" style={{ fontSize: 10.5 }}>
                {fmtMoney(toCur(t.sol, t), cur)}
              </div>
            </span>
            <span>{fmtCompact(t.tokens)}</span>
            <span className="trade__who">
              <span>{shortAddr(t.user, 4)}</span>
              {label && <span className="tag-company">{label}</span>}
            </span>
          </a>
        );
      })}
    </div>
  );
}
