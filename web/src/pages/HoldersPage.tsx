import { useMemo } from 'react';
import type { Holder } from '../../../shared/types';
import { SegmentedBar } from '../components/Charts';
import { useCur } from '../components/Shell';
import { Address, Card, Tile } from '../components/ui';
import { fmtCompact, fmtMoney, fmtNum, fmtPct, fmtSol } from '../lib/format';
import { useSolTo, useSymbol, useValuation } from '../lib/hooks';
import { useStore } from '../lib/store';
import { Loading } from './common';

const TAG: Record<Holder['tag'], { name: string; color: string }> = {
  curve: { name: '池子', color: 'var(--viz-pool)' },
  company: { name: '公司', color: 'var(--viz-company)' },
  external: { name: '外部', color: 'var(--viz-external)' },
};

export function HoldersPage() {
  const snap = useStore((s) => s.snap);
  const solTo = useSolTo();
  const { primary } = useCur();
  const symbol = useSymbol();
  const val = useValuation();

  const sums = useMemo(() => {
    const r = { curve: 0, company: 0, external: 0 };
    for (const h of snap?.holders ?? []) r[h.tag] += h.amount;
    return r;
  }, [snap?.holders]);

  if (!snap || !snap.market) return <Loading />;
  const supply = snap.supply;
  const holders = snap.holders;
  const top10 = holders.filter((h) => h.tag !== 'curve').slice(0, 10).reduce((s, h) => s + h.amount, 0);
  const external = Math.max(0, supply - sums.curve - sums.company);
  const max = holders[0]?.amount ?? 1;
  // 每枚流通代币对应的池内 SOL（与资产页的公司总资产口径一致）
  const perToken = val?.equityPerToken ?? 0;
  const poolSol = snap.market.poolSol;

  return (
    <>
      <div className="grid-2">
        <Tile label="持有人数" value={fmtNum(snap.holderCount, 0)} sub="余额 > 0 的钱包" />
        <Tile label="前 10 持仓（不含池子）" value={fmtPct(top10 / supply)} sub={`${fmtCompact(top10)} ${symbol}`} />
        <Tile label="公司钱包合计" value={fmtPct(sums.company / supply)} sub={`${fmtCompact(sums.company)} ${symbol}`} />
        <Tile label="池子持有" value={fmtPct(sums.curve / supply)} sub={`${fmtCompact(sums.curve)} ${symbol}`} />
      </div>

      <Card kicker="Distribution" title="持仓结构">
        <SegmentedBar
          total={supply}
          parts={[
            { key: 'curve', label: '池子', value: sums.curve, color: TAG.curve.color },
            { key: 'company', label: '公司', value: sums.company, color: TAG.company.color },
            { key: 'external', label: '外部', value: external, color: TAG.external.color },
          ]}
        />
      </Card>

      <Card kicker="Holder Ranking" title="持仓排名" right={<span className="chip">链上实时</span>}>
        <div className="barlist">
          {holders.map((h, i) => (
            <div key={h.owner} className="barlist__row">
              <div className="barlist__name">
                <span className="mono muted" style={{ width: 22, fontSize: 11 }}>
                  {i + 1}
                </span>
                <i className="swatch" style={{ background: TAG[h.tag].color }} />
                <span style={{ fontWeight: 600, fontSize: 12.5 }}>{h.tag === 'company' ? h.label : TAG[h.tag].name}</span>
                {h.isCreator && <span className="chip chip--accent">创建者</span>}
              </div>
              <div className="barlist__val">{fmtPct(h.pct / 100, h.pct >= 1 ? 2 : 3)}</div>
              <div className="barlist__track">
                <div className="barlist__bar" style={{ width: `${(h.amount / max) * 100}%`, background: TAG[h.tag].color }} />
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
                <Address address={h.owner} />
                <span className="mono dim">
                  {fmtNum(h.amount, 0)} <span className="muted">· {h.tag === 'curve' ? `池内 ${fmtSol(poolSol)} SOL` : fmtMoney(h.amount * perToken * solTo[primary], primary, { compact: true })}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="card__note">每个钱包的金额 = 持仓 × 每枚流通代币对应的池内 SOL。数据来自 getProgramAccounts（该代币的全部 Token-2022 账户），每 30 秒及每笔成交后自动刷新；公司钱包余额通过账户订阅毫秒级更新。</p>
      </Card>
    </>
  );
}
