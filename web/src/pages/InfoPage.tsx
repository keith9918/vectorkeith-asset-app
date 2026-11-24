import { AtSign, BarChart3, Copy, Flame, Globe, Rocket, Search, Send, Zap } from 'lucide-react';
import { useCur } from '../components/Shell';
import { Address, Card, copyText } from '../components/ui';
import { tokenImage } from '../lib/api';
import { fmtAgo, fmtDate, fmtMoney, fmtNum, fmtPrice, fmtSol } from '../lib/format';
import { useNow, useSolTo } from '../lib/hooks';
import { useStore } from '../lib/store';
import { Loading } from './common';

const Check = ({ ok, yes, no }: { ok: boolean; yes: string; no: string }) => (
  <span className={ok ? 'ok' : 'down'}>
    {ok ? '✓ ' : '⚠ '}
    {ok ? yes : no}
  </span>
);

export function InfoPage() {
  const snap = useStore((s) => s.snap);
  const conn = useStore((s) => s.conn);
  const rtt = useStore((s) => s.rtt);
  const slot = useStore((s) => s.slot);
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const now = useNow(1000);

  if (!snap) return <Loading />;
  const t = snap.token;
  const mint = t?.mint ?? snap.mint;
  const price = snap.market?.priceSol ?? 0;
  const supply = t?.supply ?? 1e9;
  const st = snap.status;
  const uptime = Math.floor((now - st.startedAt) / 1000);

  const links = [
    { name: 'pump.fun', href: `https://pump.fun/coin/${mint}`, Icon: Rocket },
    { name: 'Solscan', href: `https://solscan.io/token/${mint}`, Icon: Search },
    { name: 'DexScreener', href: `https://dexscreener.com/solana/${mint}`, Icon: BarChart3 },
    { name: 'GMGN', href: `https://gmgn.ai/sol/token/${mint}`, Icon: Flame },
    { name: 'Birdeye', href: `https://birdeye.so/token/${mint}?chain=solana`, Icon: Zap },
    { name: 'Jupiter', href: `https://jup.ag/tokens/${mint}`, Icon: Globe },
  ];
  if (t?.website) links.push({ name: '官网', href: t.website, Icon: Globe });
  if (t?.twitter) links.push({ name: 'X / Twitter', href: t.twitter, Icon: AtSign });
  if (t?.telegram) links.push({ name: 'Telegram', href: t.telegram, Icon: Send });

  return (
    <>
      <Card>
        <div className="token-hero">
          <img src={tokenImage(t)} alt={t?.name || '代币图标'} />
          <div style={{ minWidth: 0 }}>
            <div className="kicker">Token Profile</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>{t?.name || '—'}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <span className="chip chip--accent">{t?.symbol || '—'}</span>
              <span className="chip">Solana</span>
              <span className="chip">Token-2022</span>
            </div>
          </div>
        </div>
        {t?.description && <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '12px 0 0' }}>{t.description}</p>}
        <div className="ca-box">
          <span className="muted" style={{ fontSize: 12, flex: 'none' }}>
            合约
          </span>
          <code>{mint}</code>
          <button type="button" className="btn" onClick={() => copyText(mint, '合约地址已复制')}>
            <Copy size={14} /> 复制
          </button>
        </div>
      </Card>

      <Card kicker="Market Data" title="市场数据">
        <div className="rows">
          <div className="row">
            <span className="row__k">现价</span>
            <span className="row__v mono">
              {fmtPrice(price * solTo[primary], primary)} <span className="dim">· {fmtPrice(price * solTo[secondary], secondary)}</span>
            </span>
          </div>
          <div className="row">
            <span className="row__k">SOL 本位价</span>
            <span className="row__v mono">{fmtPrice(price, 'sol')}</span>
          </div>
          <div className="row">
            <span className="row__k">市值 / FDV</span>
            <span className="row__v mono">
              {fmtMoney(price * supply * solTo[primary], primary)} <span className="dim">· {fmtMoney(price * supply * solTo[secondary], secondary)}</span>
            </span>
          </div>
          <div className="row">
            <span className="row__k">累计成交</span>
            <span className="row__v mono">
              {fmtNum(snap.stats.totalTrades, 0)} 笔 · {fmtSol(snap.stats.totalVolumeSol)} SOL
            </span>
          </div>
          <div className="row">
            <span className="row__k">SOL 价格</span>
            <span className="row__v mono">
              {fmtMoney(solTo.cny, 'cny')} · {fmtMoney(solTo.usd, 'usd')} <span className="muted">({snap.solPrice.source})</span>
            </span>
          </div>
          <div className="row">
            <span className="row__k">美元兑人民币</span>
            <span className="row__v mono">1 USD = {snap.solPrice.usdCny.toFixed(4)} CNY</span>
          </div>
        </div>
      </Card>

      <Card kicker="On-chain Facts" title="代币信息">
        <div className="rows">
          <div className="row">
            <span className="row__k">总供应量</span>
            <span className="row__v mono">{fmtNum(supply, 0)}</span>
          </div>
          <div className="row">
            <span className="row__k">精度</span>
            <span className="row__v mono">{t?.decimals ?? 6}</span>
          </div>
          <div className="row">
            <span className="row__k">铸币权限</span>
            <span className="row__v">
              <Check ok={!t?.mintAuthority} yes="已放弃（不可增发）" no="未放弃" />
            </span>
          </div>
          <div className="row">
            <span className="row__k">冻结权限</span>
            <span className="row__v">
              <Check ok={!t?.freezeAuthority} yes="已放弃（不可冻结）" no="未放弃" />
            </span>
          </div>
          <div className="row">
            <span className="row__k">元数据</span>
            <span className="row__v">
              <Check ok={!t?.updateAuthority} yes="不可更改" no="可更改" />
            </span>
          </div>
          <div className="row">
            <span className="row__k">发行平台</span>
            <span className="row__v">pump.fun</span>
          </div>
          <div className="row">
            <span className="row__k">创建时间</span>
            <span className="row__v mono">{t?.createdAt ? fmtDate(t.createdAt * 1000) : '—'}</span>
          </div>
          <div className="row">
            <span className="row__k">创建者</span>
            <span className="row__v">{snap.curve?.creator ? <Address address={snap.curve.creator} /> : '—'}</span>
          </div>
          <div className="row">
            <span className="row__k">{snap.market?.mode === 'amm' ? '池子（PumpSwap）' : '池子（pump.fun 内盘）'}</span>
            <span className="row__v">{snap.market ? <Address address={snap.market.poolAddress} /> : '—'}</span>
          </div>
          {snap.creatorVault && (
            <div className="row">
              <span className="row__k">创作者金库</span>
              <span className="row__v">
                <Address address={snap.creatorVault.address} />
              </span>
            </div>
          )}
          <div className="row">
            <span className="row__k">代币程序</span>
            <span className="row__v">
              <Address address={t?.tokenProgram ?? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'} />
            </span>
          </div>
          <div className="row">
            <span className="row__k">交易手续费</span>
            <span className="row__v">
              协议 {snap.fees.protocolBps / 100}% + 创作者 {snap.fees.creatorBps / 100}%
            </span>
          </div>
        </div>
      </Card>

      <Card kicker="Links" title="外部链接">
        <div className="links">
          {links.map(({ name, href, Icon }) => (
            <a key={name} href={href} target="_blank" rel="noreferrer">
              <Icon size={18} />
              {name}
            </a>
          ))}
        </div>
      </Card>

      <Card kicker="Data Source" title="数据源状态">
        <div className="rows">
          <div className="row">
            <span className="row__k">App ↔ 服务器</span>
            <span className="row__v">{conn === 'live' ? <span className="ok">✓ 实时连接{rtt !== null ? ` · ${rtt}ms` : ''}</span> : <span className="down">{conn === 'offline' ? '离线' : '连接中'}</span>}</span>
          </div>
          <div className="row">
            <span className="row__k">服务器 ↔ Solana</span>
            <span className="row__v">{st.wsConnected ? <span className="ok">✓ WebSocket 订阅中</span> : <span className="down">重连中</span>}</span>
          </div>
          <div className="row">
            <span className="row__k">RPC 节点</span>
            <span className="row__v mono" style={{ fontSize: 12 }}>
              {st.rpcHttp}
            </span>
          </div>
          <div className="row">
            <span className="row__k">最新 Slot</span>
            <span className="row__v mono">#{(slot || st.slot).toLocaleString('en-US')}</span>
          </div>
          <div className="row">
            <span className="row__k">历史成交同步</span>
            <span className="row__v">
              {st.backfillDone && st.backfillFetched >= st.backfillTotal ? <span className="ok">✓ 已完成</span> : `进行中 ${st.backfillFetched}/${st.backfillTotal}`}
            </span>
          </div>
          <div className="row">
            <span className="row__k">持仓排名刷新</span>
            <span className="row__v">{st.lastHoldersMs ? fmtAgo(st.lastHoldersMs, now) : '—'}</span>
          </div>
          <div className="row">
            <span className="row__k">服务已运行</span>
            <span className="row__v mono">
              {Math.floor(uptime / 3600)}h {Math.floor((uptime % 3600) / 60)}m {uptime % 60}s
            </span>
          </div>
        </div>
        {st.errors.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
              最近的告警（{st.errors.length}）
            </summary>
            <pre className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>
              {st.errors.join('\n')}
            </pre>
          </details>
        )}
      </Card>
    </>
  );
}
