import { RefreshCw } from 'lucide-react';
import { Card } from '../components/ui';
import { useStore } from '../lib/store';

export function Loading() {
  const conn = useStore((s) => s.conn);
  return (
    <>
      <Card className="hero-card" kicker="VectorKeith · Linking" title="正在连接 Solana 主网…">
        <div className="hero-value skeleton" style={{ width: '70%' }}>
          ¥0,000.00
        </div>
        <div className="skeleton" style={{ height: 14, width: '55%', marginTop: 10 }} />
        <div className="skeleton" style={{ height: 14, width: '40%', marginTop: 8 }} />
        <p className="card__note">
          {conn === 'offline' ? '暂时无法连接到数据服务器，正在自动重连…' : '正在订阅链上实时数据（池子、成交、公司钱包）。'}
        </p>
      </Card>
      <div className="grid-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="tile">
            <div className="skeleton" style={{ height: 12, width: '50%' }} />
            <div className="skeleton" style={{ height: 22, width: '80%', marginTop: 8 }} />
          </div>
        ))}
      </div>
    </>
  );
}

/** 首次启动时，服务器从链上回填历史成交的进度 */
export function SyncBanner() {
  const st = useStore((s) => s.snap?.status);
  if (!st) return null;
  const syncing = !st.backfillDone || (st.backfillTotal > 0 && st.backfillFetched < st.backfillTotal);
  if (!syncing) return null;
  return (
    <div className="banner banner--info" role="status">
      <RefreshCw size={15} style={{ flex: 'none', marginTop: 2, animation: 'spin 1.2s linear infinite' }} />
      <span>
        正在从 Solana 主网同步历史成交 {st.backfillTotal ? `${st.backfillFetched}/${st.backfillTotal}` : '…'}
        <span className="muted">（公共节点限速，成交多时首次同步要十几分钟；实时数据不受影响）</span>
      </span>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );
}
