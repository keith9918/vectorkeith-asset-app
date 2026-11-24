import { useState } from 'react';
import type { WindowStats } from '../../../shared/types';
import { SegmentedBar } from '../components/Charts';
import { KlineChart } from '../components/KlineChart';
import { Dual, useCur } from '../components/Shell';
import { TradeList } from '../components/TradeList';
import { Card, ChangeChip, Meter, Seg, Tile } from '../components/ui';
import { tokenImage } from '../lib/api';
import { fmtCompact, fmtDate, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtSol } from '../lib/format';
import { useFlash, useSolTo } from '../lib/hooks';
import { useStore } from '../lib/store';
import { Loading, SyncBanner } from './common';

export function MarketPage() {
  const snap = useStore((s) => s.snap);
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const price = snap?.market?.priceSol ?? 0;
  const flash = useFlash(price);
  const [win, setWin] = useState<WindowStats['window']>('24h');

  if (!snap || !snap.market) return <Loading />;
  const m = snap.market;
  const supply = snap.supply;
  const w24 = snap.stats.windows.find((w) => w.window === '24h');
  const w = snap.stats.windows.find((x) => x.window === win);
  const mcapSol = price * supply;

  return (
    <>
      <SyncBanner />
      {/* ─── 价格 ─── */}
      <Card className="hero-card">
        <div className="glow-orb" />
        <div className="price-head">
          <img className="price-head__logo" src={tokenImage(snap.token)} alt="" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 16 }}>
              {snap.token?.name || '—'} <span className="chip chip--accent">{snap.token?.symbol || '—'}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
              {m.mode === 'curve' ? 'pump.fun 内盘' : `已毕业 · ${m.dex}`} · Solana
            </div>
          </div>
        </div>
        <div className={`price-main num ${flash}`} aria-live="polite">
          {fmtPrice(price * solTo[primary], primary)}
        </div>
        <div className="price-alt">
          <span>{fmtPrice(price * solTo[secondary], secondary)}</span>
          <span>{fmtPrice(price, 'sol')}</span>
          {w24 && (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <ChangeChip v={w24.priceChange} />
              <span className="muted">24h</span>
            </span>
          )}
        </div>
      </Card>

      <div className="grid-2">
        <Tile label="市值" value={fmtMoney(mcapSol * solTo[primary], primary, { compact: true })} sub={`${fmtMoney(mcapSol * solTo[secondary], secondary, { compact: true })} · ${fmtCompact(mcapSol)} SOL`} />
        <Tile label="池子 SOL" value={`${fmtSol(m.poolSol)} SOL`} sub={<Dual sol={m.poolSol} compact />} />
        <Tile label="24h 成交额" value={w24 ? fmtMoney(w24.volumeSol * solTo[primary], primary, { compact: true }) : '—'} sub={w24 ? `${fmtSol(w24.volumeSol)} SOL · ${w24.buys + w24.sells} 笔` : ''} />
        <Tile label="持有人" value={fmtNum(snap.holderCount, 0)} sub={`公司钱包 ${snap.company.length} 个`} />
      </div>

      {/* ─── K 线 ─── */}
      <Card kicker="Realtime K-Line" title="K 线 · 毫秒级实时">
        <KlineChart />
      </Card>

      {/* ─── Bonding curve ─── */}
      {m.mode === 'curve' && snap.curve && (
        <Card kicker="Bonding Curve" title="池子与毕业进度" right={<span className="chip chip--accent num">{fmtPct(m.progress)}</span>}>
          <Meter value={m.progress} label="毕业进度" />
          <div className="rows" style={{ marginTop: 10 }}>
            <div className="row">
              <span className="row__k">池内真实 SOL</span>
              <span className="row__v mono">
                {fmtSol(m.poolSol)} SOL
                <div className="dim" style={{ fontSize: 11.5 }}>
                  <Dual sol={m.poolSol} />
                </div>
              </span>
            </div>
            <div className="row">
              <span className="row__k">距毕业还需买入</span>
              <span className="row__v mono">
                ≈ {fmtSol(m.solToGraduate)} SOL <span className="dim">· {fmtMoney(m.solToGraduate * solTo[primary], primary, { compact: true })}</span>
              </span>
            </div>
            <div className="row">
              <span className="row__k">池内剩余可售</span>
              <span className="row__v mono">{fmtNum(snap.curve.realTokenReserves, 0)} {snap.token?.symbol}</span>
            </div>
            <div className="row">
              <span className="row__k">历史最高价 (ATH)</span>
              <span className="row__v mono">
                {fmtPrice(primary === 'usd' ? snap.stats.athPriceUsd : snap.stats.athPriceUsd * snap.solPrice.usdCny, primary)}
                <span className="dim"> · {fmtPrice(secondary === 'usd' ? snap.stats.athPriceUsd : snap.stats.athPriceUsd * snap.solPrice.usdCny, secondary)}</span>
                {snap.stats.athTs ? (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {fmtDate(snap.stats.athTs * 1000).slice(0, 16)}
                  </div>
                ) : null}
              </span>
            </div>
          </div>
          <p className="card__note">pump.fun 内盘：价格由 bonding curve 公式决定，可售代币全部卖出（约 85 SOL 进池）后自动毕业迁移到 PumpSwap。</p>
        </Card>
      )}

      {/* ─── PumpSwap 池子（已毕业） ─── */}
      {m.mode === 'amm' && (
        <Card
          kicker="PumpSwap Pool"
          title="交易池"
          right={<span className={`chip ${m.lpSupply === 0 ? 'chip--up' : ''}`}>{m.lpSupply === 0 ? '流动性永久锁定' : 'LP 未销毁'}</span>}
        >
          <div className="rows">
            <div className="row">
              <span className="row__k">池内 SOL</span>
              <span className="row__v mono">
                {fmtSol(m.poolSol)} SOL
                <div className="dim" style={{ fontSize: 11.5 }}>
                  <Dual sol={m.poolSol} />
                </div>
              </span>
            </div>
            <div className="row">
              <span className="row__k">池内代币</span>
              <span className="row__v mono">
                {fmtNum(m.poolTokens, 0)} {snap.token?.symbol}
              </span>
            </div>
            <div className="row">
              <span className="row__k">流动性（LP）</span>
              <span className="row__v">{m.lpSupply === 0 ? '已全部销毁，谁都撤不走' : m.lpSupply ? `流通 ${fmtNum(m.lpSupply, 2)}` : '—'}</span>
            </div>
            <div className="row">
              <span className="row__k">历史最高价 (ATH)</span>
              <span className="row__v mono">
                {fmtPrice(primary === 'usd' ? snap.stats.athPriceUsd : snap.stats.athPriceUsd * snap.solPrice.usdCny, primary)}
                <span className="dim"> · {fmtPrice(secondary === 'usd' ? snap.stats.athPriceUsd : snap.stats.athPriceUsd * snap.solPrice.usdCny, secondary)}</span>
                {snap.stats.athTs ? (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {fmtDate(snap.stats.athTs * 1000).slice(0, 16)}
                  </div>
                ) : null}
              </span>
            </div>
          </div>
          <p className="card__note">
            已从 pump.fun 内盘毕业，现在在 {m.dex} 交易池里买卖：价格 = 池内 SOL ÷ 池内代币，每笔成交都会改变价格。池子越小，同样金额的买卖对价格的影响越大。
          </p>
        </Card>
      )}

      {/* ─── 交易统计 ─── */}
      <Card
        kicker="Order Flow"
        title="买卖力量"
        right={
          <Seg<WindowStats['window']>
            label="统计周期"
            value={win}
            onChange={setWin}
            options={[
              { value: '5m', label: '5m' },
              { value: '1h', label: '1h' },
              { value: '6h', label: '6h' },
              { value: '24h', label: '24h' },
            ]}
          />
        }
      >
        {w && (
          <>
            <SegmentedBar
              thin
              parts={[
                { key: 'buy', label: `买入 ${fmtSol(w.buySol)} SOL`, value: w.buySol, color: 'var(--up)' },
                { key: 'sell', label: `卖出 ${fmtSol(w.sellSol)} SOL`, value: w.sellSol, color: 'var(--down)' },
              ]}
            />
            <div className="flow">
              <div>
                <div className="flow__k">涨跌幅</div>
                <div className={`flow__v ${w.priceChange > 0 ? 'up' : w.priceChange < 0 ? 'down' : ''}`}>{fmtPct(w.priceChange, 2, true)}</div>
              </div>
              <div>
                <div className="flow__k">成交额</div>
                <div className="flow__v">{fmtMoney(w.volumeSol * solTo[primary], primary)}</div>
              </div>
              <div>
                <div className="flow__k">买 / 卖笔数</div>
                <div className="flow__v">
                  <span className="up">{w.buys}</span> / <span className="down">{w.sells}</span>
                </div>
              </div>
              <div>
                <div className="flow__k">交易地址数</div>
                <div className="flow__v">{w.traders}</div>
              </div>
              <div>
                <div className="flow__k">净流入</div>
                <div className={`flow__v ${w.buySol - w.sellSol >= 0 ? 'up' : 'down'}`}>
                  {w.buySol - w.sellSol >= 0 ? '+' : ''}
                  {fmtSol(w.buySol - w.sellSol)} SOL
                </div>
              </div>
              <div>
                <div className="flow__k">公司净买入</div>
                <div className={`flow__v ${w.companyNetSol > 0 ? 'up' : w.companyNetSol < 0 ? 'down' : ''}`}>
                  {w.companyNetSol > 0 ? '+' : ''}
                  {fmtSol(w.companyNetSol)} SOL
                </div>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* ─── 实时成交 ─── */}
      <Card kicker="Live Trades" title="实时成交" right={<span className="chip">点击查看链上交易</span>}>
        <TradeList limit={50} />
      </Card>
    </>
  );
}
