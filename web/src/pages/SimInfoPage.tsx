// 「信息」页：USVK 模拟盘的代币信息（原来链上代币的信息页 InfoPage.tsx 保留，恢复时改回 App.tsx 的 PAGES）
import { ChartCandlestick } from 'lucide-react';
import { SimMarketCard, SimTokenCard } from '../components/SimToken';
import { Card } from '../components/ui';
import { useSim } from '../lib/sim';

export function SimInfoPage() {
  const { view, error } = useSim();
  if (!view) {
    return (
      <Card kicker="Token Profile" title="USVK 模拟盘">
        {error ? <div className="error">{error}</div> : <div className="skeleton" style={{ height: 120 }} />}
      </Card>
    );
  }
  return (
    <>
      <Card>
        <div className="token-hero">
          <div className="sim-logo" aria-hidden>
            US
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="kicker">Token Profile</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>USVK</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <span className="chip chip--accent">USVK</span>
              <span className="chip chip--warn">模拟盘</span>
              <span className="chip">pump.fun 规则</span>
              <span className="chip">总量 20 亿</span>
            </div>
          </div>
        </div>
        <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '12px 0 0' }}>
          VectorKeith 的 USVK 模拟盘：虚拟 SOL，不上链、不花真钱。公司、员工、内部客户都能买卖，市值从 0 开始。
        </p>
        <div className="ca-box">
          <span className="muted" style={{ fontSize: 12, flex: 'none' }}>
            合约
          </span>
          <code>模拟盘，未上链</code>
          <a className="btn" href="#/sim">
            <ChartCandlestick size={14} /> 去交易
          </a>
        </div>
      </Card>
      <SimMarketCard v={view} />
      <SimTokenCard v={view} />
    </>
  );
}
