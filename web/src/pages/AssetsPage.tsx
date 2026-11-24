import { AlertTriangle, ArrowDownLeft, ArrowUpRight, ChevronRight, Coins, Gift, RefreshCw, Wallet } from 'lucide-react';
import { useState } from 'react';
import type { Payout, TreasuryActivity } from '../../../shared/types';
import { AssetHistoryChart } from '../components/Charts';
import { MascotCard } from '../components/Mascot';
import { SolPriceCard } from '../components/SolPriceCard';
import { Dual, useCur } from '../components/Shell';
import { Address, Card, Seg, Tile } from '../components/ui';
import { solscan } from '../lib/api';
import { CUR_SYMBOL, fmtAgo, fmtClock, fmtCompact, fmtMoney, fmtNum, fmtPct, fmtShortDate, fmtSol, shortAddr, type Cur } from '../lib/format';
import { useTreasuryHistory } from '../lib/history';
import { useFlash, useNow, useSolTo } from '../lib/hooks';
import { setPrefs, usePrefs } from '../lib/prefs';
import { holderLabels, payoutsBySig, useShareholders } from '../lib/shareholders';
import { useStore } from '../lib/store';
import { Loading } from './common';

const KIND: Record<TreasuryActivity['kind'], string> = {
  in: '转入',
  out: '转出',
  buy: '买入代币',
  sell: '卖出代币',
  fee: '手续费',
  other: '其他',
  stake: '质押',
  unstake: '取回质押',
  stableIn: '稳定币转入',
  stableOut: '稳定币转出',
};

const signed = (v: number, digits = 4) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v), digits)}`;

function ActivityRow({ a, labels, cur, usdCny, multi, payouts }: { a: TreasuryActivity; labels: Map<string, string>; cur: Cur; usdCny: number; multi: boolean; payouts?: Payout[] }) {
  const up = a.deltaSol > 0;
  const isDust = !!a.dust && !a.failed;
  const value = Math.abs(a.deltaSol) * (cur === 'usd' ? a.solUsd : a.solUsd * usdCny);
  if (a.poisonOf) {
    const target = labels.get(a.poisonOf) ?? shortAddr(a.poisonOf);
    return (
      <a className="flow-row flow-row--warn" href={solscan.tx(a.sig)} target="_blank" rel="noreferrer">
        <span className="flow-row__icon warn">
          <AlertTriangle size={15} />
        </span>
        <span className="flow-row__main">
          <span className="flow-row__title">疑似地址投毒</span>
          <span className="flow-row__sub" style={{ whiteSpace: 'normal' }}>
            {fmtShortDate(a.ts * 1000)} · {a.counterparty ? shortAddr(a.counterparty, 5) : ''} 冒充 {target}。转账时不要从交易记录里复制地址
          </span>
        </span>
        <span className="flow-row__amt">
          <span className="muted">{signed(a.deltaSol)} SOL</span>
        </span>
      </a>
    );
  }
  if (a.stable && !a.failed) {
    const sIn = a.kind === 'stableIn';
    const usdV = a.stable.amount;
    const sv = cur === 'usd' ? usdV : usdV * usdCny;
    return (
      <a className="flow-row" href={solscan.tx(a.sig)} target="_blank" rel="noreferrer">
        <span className={`flow-row__icon ${sIn ? 'up' : 'down'}`}>{sIn ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}</span>
        <span className="flow-row__main">
          <span className="flow-row__title">
            {sIn ? '转入' : '转出'} {a.stable.symbol}
            {multi && <span className="chip" style={{ height: 18, fontSize: 10, padding: '0 5px' }}>{labels.get(a.wallet) ?? shortAddr(a.wallet)}</span>}
          </span>
          <span className="flow-row__sub">
            {fmtShortDate(a.ts * 1000)}
            {a.counterparty ? ` · ${sIn ? '来自' : '转给'} ${labels.get(a.counterparty) ?? shortAddr(a.counterparty)}` : ''}
            {a.fee > 0 ? ` · 网络费 ${fmtNum(a.fee, 6)} SOL` : ''}
          </span>
        </span>
        <span className="flow-row__amt">
          <span className={sIn ? 'up' : 'down'}>
            {sIn ? '+' : '−'}
            {fmtNum(a.stable.amount, 2)} {a.stable.symbol}
          </span>
          <span className="muted">{fmtMoney(sv, cur)}</span>
        </span>
      </a>
    );
  }
  const parts: string[] = [];
  if (a.failed) parts.push('交易失败，只扣了网络费');
  else {
    if (a.note) parts.push(a.note);
    if (payouts?.length) {
      parts.push(`发给 ${payouts.map((p) => `${labels.get(p.to ?? '') ?? shortAddr(p.to)} ${fmtNum(p.sol, 4)}`).join('、')}`);
    } else if (a.counterparty && (a.kind === 'in' || a.kind === 'out' || a.kind === 'other')) {
      parts.push(`${up || a.kind === 'in' ? '来自' : '转给'} ${labels.get(a.counterparty) ?? shortAddr(a.counterparty)}`);
    }
    if (isDust) parts.push('可能是广告或骚扰转账，可忽略');
    if (a.tokens.length) parts.push(a.tokens.map((t) => `${t.delta > 0 ? '+' : '−'}${fmtCompact(Math.abs(t.delta))} ${t.symbol ?? shortAddr(t.mint, 3)}`).join(' · '));
  }
  const detail = parts.join(' · ');
  return (
    <a className={`flow-row ${isDust ? 'flow-row--dim' : ''}`} href={solscan.tx(a.sig)} target="_blank" rel="noreferrer">
      <span className={`flow-row__icon ${up ? 'up' : 'down'}`}>{up ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}</span>
      <span className="flow-row__main">
        <span className="flow-row__title">
          {a.failed ? '失败交易' : isDust ? '零额转账' : payouts?.length ? '分红发放' : KIND[a.kind]}
          {multi && <span className="chip" style={{ height: 18, fontSize: 10, padding: '0 5px' }}>{labels.get(a.wallet) ?? shortAddr(a.wallet)}</span>}
        </span>
        <span className="flow-row__sub">
          {fmtShortDate(a.ts * 1000)}
          {detail ? ` · ${detail}` : ''}
        </span>
      </span>
      <span className="flow-row__amt">
        <span className={up ? 'up' : 'down'}>{signed(a.deltaSol)} SOL</span>
        <span className="muted">{fmtMoney(value, cur)}</span>
      </span>
    </a>
  );
}

export function AssetsPage() {
  const snap = useStore((s) => s.snap);
  const slotMs = useStore((s) => s.slotMs);
  const solTo = useSolTo();
  const prefs = usePrefs();
  const { primary, secondary } = useCur();
  const points = useTreasuryHistory();
  const { view: holders } = useShareholders();
  const t = snap?.treasury;
  const flash = useFlash(t?.totalSol);
  const now = useNow(1000);
  const [showAll, setShowAll] = useState(false);

  if (!snap || !t) return <Loading />;

  const usdCny = snap.solPrice.usdCny;
  const total = t.totalSol;
  const loaded = t.wallets.some((w) => Number.isFinite(w.sol));
  // 稳定币（官方 USDT / USDC）：1 枚 = 1 美元，计入总资产的显示，不计入分红
  const st = t.stables;
  const stableUsd = st?.usd ?? 0;
  const usdTo: Record<Cur, number> = { usd: 1, cny: usdCny, sol: snap.solPrice.usd > 0 ? 1 / snap.solPrice.usd : 0 };
  const valueNow = total * solTo[primary] + stableUsd * usdTo[primary];
  const div = total * t.dividendRatio;
  const labels = new Map([...holderLabels(holders), ...t.wallets.map((w) => [w.address, w.label] as const)]);
  const paidBySig = payoutsBySig(holders);
  const multi = t.wallets.length > 1;

  // 24 小时变化：SOL 数量变化（转入转出）+ SOL 价格变化，合起来就是资产价值变化
  const sol24 = t.totalSol24hAgo;
  const usd24 = t.solUsd24hAgo;
  const solChange = sol24 !== null ? total - sol24 : null;
  const priceChange = usd24 ? snap.solPrice.usd / usd24 - 1 : null;
  const value24 = sol24 !== null && usd24 ? sol24 * (primary === 'usd' ? usd24 : usd24 * usdCny) + stableUsd * usdTo[primary] : null;
  const valueDiff = value24 !== null ? valueNow - value24 : null;
  const valueChange = value24 !== null && value24 > 0 ? valueNow / value24 - 1 : null;
  // 24 小时前钱包几乎是空的时候，百分比会大到没有意义（例如 +250000%）：只显示金额变化
  const pctText = valueChange !== null && Math.abs(valueChange) < 10 ? ` (${fmtPct(valueChange, 1, true)})` : '';

  const activity = showAll ? t.activity : t.activity.slice(0, 15);
  const syncing = !t.status.backfillDone;

  return (
    <>
      {t.wallets.length === 0 && (
        <a className="banner" href="#/settings" style={{ textDecoration: 'none' }}>
          <AlertTriangle size={16} style={{ flex: 'none', marginTop: 1 }} />
          <span>
            还没有设置公司钱包，所以总资产显示为 0。<b style={{ color: 'var(--accent)' }}>点这里去「设置」添加 ›</b>
          </span>
        </a>
      )}
      {syncing && t.wallets.length > 0 && (
        <div className="banner banner--info" role="status">
          <RefreshCw size={15} style={{ flex: 'none', marginTop: 2, animation: 'spin 1.2s linear infinite' }} />
          <span>
            正在同步公司钱包的历史流水 {t.status.total ? `${t.status.fetched}/${t.status.total}` : '…'}
            <span className="muted">（总资产和余额已经是实时数据；走势图和资金流水会随同步逐步补全）</span>
          </span>
          <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
        </div>
      )}

      {/* ─── 总资产 ─── */}
      <Card
        className="hero-card"
        kicker="Company Assets"
        title={
          <>
            公司总资产 <span className="chip chip--accent" style={{ marginLeft: 4, verticalAlign: 2 }}>实时</span>
          </>
        }
        right={
          <Seg<'cny' | 'usd'>
            label="主显示货币"
            value={prefs.primary}
            onChange={(v) => setPrefs({ primary: v })}
            options={[
              { value: 'cny', label: '人民币' },
              { value: 'usd', label: '美元' },
            ]}
          />
        }
      >
        <div className="glow-orb" />
        <div className={`hero-value ${flash}`} aria-live="polite">
          <small>{CUR_SYMBOL[primary]}</small>
          {loaded ? fmtNum(valueNow, 2) : '—'}
        </div>
        <div className="hero-sub">
          <span>
            <b>{loaded ? fmtMoney(total * solTo[secondary] + stableUsd * usdTo[secondary], secondary) : '—'}</b>
          </span>
          <span>
            <b>{loaded ? fmtNum(total, 4) : '—'}</b> SOL
          </span>
          {stableUsd > 0 && (
            <span>
              + <b>{fmtNum(stableUsd, 2)}</b> 美元稳定币
            </span>
          )}
        </div>
        <div className="hero-sub" style={{ marginTop: 8, alignItems: 'center' }}>
          {valueDiff !== null && Math.abs(valueDiff) >= 0.01 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className={`chip ${valueDiff > 0 ? 'chip--up' : 'chip--down'} num`}>
                {valueDiff > 0 ? '▲ ' : '▼ '}
                {fmtMoney(Math.abs(valueDiff), primary)}
                {pctText}
              </span>
              <span className="muted">资产 24h</span>
            </span>
          )}
          {solChange !== null && Math.abs(solChange) >= 0.0001 && (
            <span>
              SOL 数量 <b className={solChange > 0 ? 'up' : 'down'}>{signed(solChange)}</b>
            </span>
          )}
          {priceChange !== null && (
            <span>
              SOL 价格 <b className={priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : ''}>{fmtPct(priceChange, 2, true)}</b>
            </span>
          )}
        </div>
        <div className="hero-sub" style={{ marginTop: 10 }}>
          <span>
            {t.stakedSol > 0 ? (
              <>
                钱包 {fmtSol(total - t.stakedSol)} SOL + <a href="#/staking">质押 {fmtSol(t.stakedSol)} SOL</a>
              </>
            ) : (
              `${t.wallets.length} 个公司钱包里的 SOL`
            )}
            {stableUsd > 0 ? ` + ${[st && st.usdt > 0 ? `${fmtNum(st.usdt, 2)} USDT` : '', st && st.usdc > 0 ? `${fmtNum(st.usdc, 2)} USDC` : ''].filter(Boolean).join(' + ')}` : ''}{' '}
            · SOL 现价 <b>{fmtMoney(solTo[primary], primary)}</b>
          </span>
        </div>
      </Card>

      {/* ─── 吉祥物 + 公司目标 ─── */}
      <MascotCard />

      {/* ─── 关键指标 ─── */}
      <div className="grid-2">
        <Tile
          label={
            <>
              <Wallet size={13} /> 钱包 SOL
            </>
          }
          value={loaded ? `${fmtSol(total)} SOL` : '—'}
          sub={<Dual sol={total} />}
        />
        <a href="#/shareholders" className="tile-link" aria-label="查看股东分红">
          <Tile
            label={
              <>
                <Gift size={13} /> 股东分红 ({fmtPct(t.dividendRatio, 0)}) <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
              </>
            }
            value={fmtMoney(div * solTo[primary], primary)}
            sub={`${fmtMoney(div * solTo[secondary], secondary)} · ${fmtSol(div)} SOL${stableUsd > 0 ? ' · 只按 SOL 计' : ''}`}
          />
        </a>
        <button type="button" className="tile-link" aria-label="查看 SOL 价格图" onClick={() => document.getElementById('sol-price')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          <Tile
            label={
              <>
                <Coins size={13} /> SOL 价格 <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
              </>
            }
            value={fmtMoney(solTo[primary], primary)}
            sub={`${fmtMoney(solTo[secondary], secondary)}${priceChange !== null ? ` · 24h ${fmtPct(priceChange, 2, true)}` : ''}`}
          />
        </button>
        <Tile
          label={
            <>
              <RefreshCw size={13} /> 最近一笔
            </>
          }
          value={t.activity[0] ? (t.activity[0].stable ? `${t.activity[0].kind === 'stableIn' ? '+' : '−'}${fmtNum(t.activity[0].stable.amount, 2)} ${t.activity[0].stable.symbol}` : `${signed(t.activity[0].deltaSol)} SOL`) : '—'}
          valueClass={t.activity[0] ? ((t.activity[0].stable ? t.activity[0].kind === 'stableIn' : t.activity[0].deltaSol > 0) ? 'up' : 'down') : ''}
          sub={t.activity[0] ? `${t.activity[0].failed ? '失败交易' : KIND[t.activity[0].kind]} · ${fmtAgo(t.activity[0].ts * 1000, now)}` : syncing ? '同步中…' : '暂无'}
        />
      </div>

      {/* ─── 稳定币 ─── */}
      {st && (st.usd > 0 || t.activity.some((a) => a.stable)) && (
        <Card kicker="Stablecoins" title="美元稳定币" right={<span className="chip">计入总资产 · 不计入分红</span>}>
          <div className="grid-2">
            <Tile label="USDT（Solana）" value={`${fmtNum(st.usdt, 2)}`} sub={`${fmtMoney(st.usdt * usdTo.cny, 'cny')} · $${fmtNum(st.usdt, 2)}`} />
            <Tile label="USDC（Solana）" value={`${fmtNum(st.usdc, 2)}`} sub={`${fmtMoney(st.usdc * usdTo.cny, 'cny')} · $${fmtNum(st.usdc, 2)}`} />
          </div>
          <p className="card__note">
            只统计官方合约：USDT <span className="mono">Es9v…wNYB</span>、USDC <span className="mono">EPjF…Dt1v</span>，按 1 枚 = 1 美元折算。收款时请让对方选择 Solana 网络；从交易所提币到公司钱包时同样选 Solana（SPL）。
          </p>
        </Card>
      )}

      {/* ─── 资产走势 ─── */}
      <Card
        kicker="Asset Trend"
        title="公司资产走势"
        right={
          <Seg<'24h' | '7d' | 'all'>
            label="时间范围"
            value={prefs.historyRange}
            onChange={(v) => setPrefs({ historyRange: v })}
            options={[
              { value: '24h', label: '24H' },
              { value: '7d', label: '7D' },
              { value: 'all', label: '全部' },
            ]}
          />
        }
      >
        <AssetHistoryChart points={points} cur={primary} usdCny={usdCny} range={prefs.historyRange} />
        <p className="card__note">按公司钱包的每一笔交易还原当时的 SOL 余额，再按当时的 SOL 价格换算成{primary === 'cny' ? '人民币' : '美元'}。</p>
      </Card>

      {/* ─── SOL 价格 ─── */}
      <SolPriceCard />

      {/* ─── 公司钱包 ─── */}
      <Card kicker="Company Wallets" title={`公司钱包（${t.wallets.length} 个）`} right={<a className="chip" href="#/settings">管理 ›</a>}>
        {t.wallets.map((w) => {
          const fresh = w.lastChangeMs && now - w.lastChangeMs < 3000;
          const recent = w.lastChangeMs && now - w.lastChangeMs < 24 * 3600_000;
          const share = total > 0 && Number.isFinite(w.sol) ? w.sol / total : 0;
          return (
            <div key={w.address + (fresh ? w.lastChangeMs : '')} className={`wallet ${fresh ? 'wallet--changed' : ''}`}>
              <div className="wallet__top">
                <div className="wallet__name">
                  <i className="swatch" style={{ background: 'var(--viz-company)' }} />
                  {w.label}
                </div>
                <div className="wallet__val">
                  {Number.isFinite(w.sol) ? `${fmtNum(w.sol, 4)} SOL` : '读取中…'}
                  {(() => {
                    const sw = st?.wallets.find((x) => x.address === w.address);
                    const parts = [sw && sw.usdt > 0 ? `${fmtNum(sw.usdt, 2)} USDT` : '', sw && sw.usdc > 0 ? `${fmtNum(sw.usdc, 2)} USDC` : ''].filter(Boolean);
                    return parts.length ? <div style={{ fontSize: 12 }}>+ {parts.join(' + ')}</div> : null;
                  })()}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {Number.isFinite(w.sol) ? `${fmtMoney(w.sol * solTo[primary], primary)} · ${fmtMoney(w.sol * solTo[secondary], secondary)}` : ''}
                  </div>
                </div>
              </div>
              <div className="wallet__meta">
                <Address address={w.address} />
                {recent ? (
                  <span className={`delta-badge ${w.lastDelta > 0 ? 'chip--up' : 'chip--down'}`}>
                    {signed(w.lastDelta)} SOL · {fmtAgo(w.lastChangeMs, now)}
                  </span>
                ) : (
                  multi && <span>占 {fmtPct(share, 1)}</span>
                )}
              </div>
              {multi && (
                <div className="wallet__bar" aria-hidden>
                  <div style={{ width: `${share * 100}%` }} />
                </div>
              )}
            </div>
          );
        })}
        {st?.fakes.length ? (
          <div className="banner" style={{ marginTop: 8 }}>
            <AlertTriangle size={16} style={{ flex: 'none', marginTop: 1 }} />
            <span>
              钱包里有 {st.fakes.map((f) => `${fmtCompact(f.amount)} 个「${f.symbol}」`).join('、')}：名字像稳定币，但不是官方合约，是骗子空投的假币，不计入资产。不要去它说的网站"兑换"或"领取"。
            </span>
          </div>
        ) : null}
        <p className="card__note">
          公司总资产 = 钱包里的 SOL（含计入资产的质押）+ 官方 USDT / USDC（1 枚按 1 美元）。股东分红只按 SOL 计算。钱包里的其他代币（包括 VK）、Wrapped SOL、冒牌稳定币都不计入。
        </p>
      </Card>

      {/* ─── 资金流水 ─── */}
      <Card kicker="Cash Flow" title="资金流水" right={<span className="chip">共 {fmtNum(t.activityCount, 0)} 笔</span>}>
        {!activity.length && <div className="muted" style={{ fontSize: 12.5, padding: '6px 0' }}>{syncing ? '正在同步历史流水…' : '暂无流水'}</div>}
        <div className="flows">
          {activity.map((a) => (
            <ActivityRow key={a.id} a={a} labels={labels} cur={primary} usdCny={usdCny} multi={multi} payouts={a.kind === 'out' ? paidBySig.get(a.sig)?.filter((p) => p.wallet === a.wallet) : undefined} />
          ))}
        </div>
        {t.activity.length > 15 && (
          <button type="button" className="btn btn--ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setShowAll(!showAll)}>
            {showAll ? '收起' : `显示最近 ${t.activity.length} 笔`}
          </button>
        )}
        <p className="card__note">每一笔都会改变公司钱包里的 SOL：转入转出、买卖代币、网络费都包括在内。金额按交易当时的 SOL 价格换算，点一笔可以在 Solscan 查看链上详情。</p>
      </Card>

      <p className="muted" style={{ textAlign: 'center', fontSize: 11, margin: '4px 0 0' }}>
        数据直连 Solana 主网 · 最新区块 {slotMs ? fmtClock(slotMs, true) : '—'}
      </p>
    </>
  );
}
