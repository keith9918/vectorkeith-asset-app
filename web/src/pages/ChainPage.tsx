// VK 链：公司自己的单节点区块链，正式网（区块浏览器 / App 内钱包 / 发行资产 / 节点）
import { Blocks, ChevronLeft, ExternalLink, Search, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChainBlock, ChainMirror, ChainOverview, ChainToken } from '../../../shared/chain';
import { AddrLink, CopyBtn, KindIcon, TokenIcon, TxList, VkCoin, chainGo, useChainPath } from '../components/ChainBits';
import { NodeTab } from '../components/ChainNode';
import { IssueTab, WalletTab } from '../components/ChainWallet';
import { Dual } from '../components/Shell';
import { Card, Tile } from '../components/ui';
import { solscan } from '../lib/api';
import { chainApi, chainLink, fmtAmount, fmtVk, useChainAddress, useChainBlock, useChainOverview, useChainTx, useWallet } from '../lib/chain';
import { fmtAgo, shortAddr } from '../lib/format';
import { useNow, useSolTo } from '../lib/hooks';

type Tab = 'explorer' | 'wallet' | 'issue' | 'node';
const TABS: { key: Tab; label: string; path: string }[] = [
  { key: 'explorer', label: '浏览器', path: '' },
  { key: 'wallet', label: '钱包', path: 'wallet' },
  { key: 'issue', label: '发行资产', path: 'issue' },
  { key: 'node', label: '节点', path: 'node' },
];

// ─── 实时出块：轮询一次拿到几个新区块，按出块间隔一个个"落"进来 ───

function useBlockStream(ov: ChainOverview | null): ChainBlock[] {
  const [shown, setShown] = useState<ChainBlock[]>([]);
  const queue = useRef<ChainBlock[]>([]);
  const lastSlot = useRef(-1);
  useEffect(() => {
    if (!ov?.blocks.length) return;
    // 链重新创世了（区块号大幅倒退）：重新开始
    if (ov.blocks[0].slot < lastSlot.current - 50) {
      lastSlot.current = -1;
      queue.current = [];
    }
    const fresh = [...ov.blocks].reverse().filter((b) => b.slot > lastSlot.current);
    if (!fresh.length) return;
    if (lastSlot.current < 0) {
      setShown(ov.blocks.slice(0, 10));
      lastSlot.current = ov.blocks[0].slot;
      return;
    }
    lastSlot.current = fresh[fresh.length - 1].slot;
    queue.current.push(...fresh);
    if (queue.current.length > 12) queue.current.splice(0, queue.current.length - 12);
  }, [ov]);
  const ms = Math.max(200, Math.min(1500, ov?.slotMs ?? 400));
  useEffect(() => {
    const id = setInterval(() => {
      const b = queue.current.shift();
      if (b) setShown((s) => [b, ...s].slice(0, 10));
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
  return shown;
}

function ChainHero({ ov, latest }: { ov: ChainOverview | null; latest: ChainBlock | undefined }) {
  // 浏览器索引落后链上太多（例如服务刚重启、正在补数据）时，直接显示链上的最新高度
  const tip = ov?.slot ?? 0;
  const syncing = !!latest && tip - latest.slot > 30;
  const shown = latest && !syncing ? latest.slot : tip;
  return (
    <Card className="hero-card ch-hero">
      <div className="glow-orb" aria-hidden />
      <div className="ch-hero__top">
        <span className="ch-brand">
          <Blocks size={18} /> VK CHAIN
        </span>
        <span className={`chip ${ov?.online ? 'chip--up' : ov ? 'chip--down' : ''}`}>{ov ? (ov.online ? '● 出块中' : '● 节点离线') : '连接中'}</span>
      </div>
      <div className="kicker" style={{ marginTop: 10 }}>
        最新区块
      </div>
      <div className="hero-value num ch-height">#{shown.toLocaleString()}</div>
      <div className="hero-sub">
        {syncing && <span className="chip chip--warn">浏览器数据同步中（落后 {(tip - (latest?.slot ?? 0)).toLocaleString()} 块）</span>}
        <span>
          正式网 · <b>{ov?.consensus ?? 'Alpenglow'}</b> 共识
        </span>
        <span>
          出块 <b>{ov ? (ov.slotMs / 1000).toFixed(2) : '—'}</b> 秒
        </span>
        <span>
          原生币 <b>VK</b>（付 gas）
        </span>
      </div>
    </Card>
  );
}

function BlockRibbon({ blocks }: { blocks: ChainBlock[] }) {
  return (
    <div className="ch-ribbon" aria-label="最新区块">
      {blocks.map((b, i) => (
        <a key={b.slot} href={chainLink.block(b.slot)} className={`ch-cube ${i === 0 ? 'ch-cube--new' : ''} ${b.txs ? 'ch-cube--tx' : ''}`}>
          <span className="ch-cube__slot num">#{b.slot}</span>
          <span className="ch-cube__tx">{b.txs ? `${b.txs} 笔` : '空块'}</span>
        </a>
      ))}
    </div>
  );
}

function SearchBox() {
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<ChainToken[]>([]);
  const go = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr('');
    setMatches([]);
    try {
      const r = await chainApi.search(q);
      if (r.type === 'tokens') {
        setMatches(r.matches ?? []);
        return;
      }
      chainGo(r.type === 'block' ? `block/${r.id}` : r.type === 'tx' ? `tx/${r.id}` : `address/${r.id}`);
      setQ('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <form
        className="ch-search"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <Search size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="地址 / 交易签名 / 区块号 / 资产符号" aria-label="搜索 VK 链" spellCheck={false} autoComplete="off" />
        <button type="submit" className="btn btn--solid" disabled={busy || !q.trim()}>
          搜索
        </button>
      </form>
      {err && <div className="ch-hint ch-hint--bad" style={{ marginTop: 6 }}>{err}</div>}
      {matches.length > 0 && (
        <Card kicker="搜索结果" title={`有 ${matches.length} 个同名资产`} className="ch-matches">
          <div className="ch-toklist">
            {matches.map((t) => (
              <TokenRow key={t.mint} t={t} />
            ))}
          </div>
          <p className="card__note">资产符号谁都可以用，请核对资产地址和发行人。持有人多、发行早的排在前面。</p>
        </Card>
      )}
    </div>
  );
}

const fmtSol9 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 9 });

/** 公司资产凭证 cSOL：链上总量 vs 主网真实余额（任何人都能到 Solscan 核对） */
function MirrorCard({ m, onTokenPage }: { m: ChainMirror; onTokenPage?: boolean }) {
  const sol = m.chainSol ?? m.realSol ?? 0;
  const priced = useSolTo().usd > 0;
  return (
    <Card
      className="ch-mirror"
      kicker="公司资产上链"
      title={m.stables?.length ? '公司资产储备核对' : '公司 SOL 储备核对'}
      right={<span className={`chip ${m.inSync ? 'chip--up' : 'chip--warn'}`}>{m.inSync ? '✓ 链上 = 主网' : '同步中'}</span>}
    >
      <div className="ch-mirror__big num">
        {m.chainSol != null ? fmtSol9(m.chainSol) : '—'}
        <small> cSOL</small>
      </div>
      <div className="ch-mirror__dual num">{priced ? <Dual sol={sol} /> : <span className="muted">按当前价折合：加载中…</span>}</div>
      <div className="rows">
        <Row k="链上凭证总量">
          <span className="num">{m.chainSol != null ? fmtSol9(m.chainSol) : '—'} cSOL</span>
        </Row>
        <Row k="主网真实余额">
          <span className="num">{m.realSol != null ? fmtSol9(m.realSol) : '读取中'} SOL</span>
          {m.stakedSol > 0 && <div className="muted" style={{ fontSize: 11.5 }}>其中质押 {fmtSol9(m.stakedSol)} SOL</div>}
        </Row>
        {m.stables?.map((x) => (
          <Row key={x.symbol} k={`${x.symbol}（${x.unit}）`}>
            <a className="ch-link num" href={chainLink.address(x.mint)}>
              {x.chain != null ? fmtSol9(x.chain) : '—'}
            </a>
            <span className={x.inSync ? 'up' : 'muted'}> {x.inSync ? '✓' : '同步中'}</span>
            <div className="muted" style={{ fontSize: 11.5 }}>
              主网 {x.real != null ? fmtSol9(x.real) : '读取中'} {x.unit}
            </div>
          </Row>
        ))}
        <Row k="最近同步">
          {m.lastSync ? fmtAgo(m.lastSync) : '—'}
          {m.lastSig && (
            <>
              {' · '}
              <a className="ch-link" href={chainLink.tx(m.lastSig)}>
                上一次调整
              </a>
            </>
          )}
          <div className="muted" style={{ fontSize: 11.5 }}>共调整 {m.syncs} 次</div>
        </Row>
        <Row k="主网钱包">
          <span className="ch-mirror__wallets">
            {m.wallets.map((w) => (
              <a key={w.address} href={solscan.account(w.address)} target="_blank" rel="noreferrer">
                {w.label} {shortAddr(w.address, 4)} <ExternalLink size={11} />
              </a>
            ))}
          </span>
        </Row>
      </div>
      {m.error && (
        <div className="addr-preview addr-preview--warn" style={{ marginTop: 8 }}>
          最近一次同步出错：{m.error}（会自动重试）
        </div>
      )}
      <p className="card__note">
        <ShieldCheck size={12} /> 1 cSOL = 公司在 Solana 主网上的 1 SOL{m.stables?.length ? `；${m.stables.map((x) => `1 ${x.symbol} = 1 ${x.unit}`).join('、')}` : ''}。服务器读取公司钱包的真实余额，多了自动增发、少了自动销毁，每次都在链上留一条备注；凭证不能转让、不能兑换，只用来公开记账。任何人都可以点上面的主网钱包，去 Solscan 核对。
      </p>
      {!onTokenPage && (
        <a className="btn btn--ghost" href={chainLink.address(m.mint)}>
          查看凭证和每次调整的记录
        </a>
      )}
    </Card>
  );
}

function TokenRow({ t }: { t: ChainToken }) {
  return (
    <a className="ch-tokrow" href={chainLink.address(t.mint)}>
      <TokenIcon mint={t.mint} />
      <span className="ch-tokrow__name">
        <b>{t.symbol}</b>
        <span className="muted">
          {t.name} · {t.holders ?? '—'} 个持有人
        </span>
      </span>
      <span className="ch-tokrow__amt num">
        {fmtAmount(t.supply, t.decimals)}
        <span className="muted" style={{ display: 'block', fontSize: 11 }}>
          {t.mirror ? '自动同步 · 不可转让' : t.mintAuthority ? '可增发' : '固定总量'}
        </span>
      </span>
    </a>
  );
}

function ExplorerHome({ ov, blocks }: { ov: ChainOverview | null; blocks: ChainBlock[] }) {
  const w = useWallet();
  if (!ov) return <div className="empty">正在连接 VK 链…</div>;
  return (
    <>
      <SearchBox />
      <Card kicker="实时出块" title="最新区块" right={<span className="muted num" style={{ fontSize: 12 }}>每 {(ov.slotMs / 1000).toFixed(2)} 秒一块</span>} flush>
        <BlockRibbon blocks={blocks} />
      </Card>
      {ov.mirror && <MirrorCard m={ov.mirror} />}
      <div className="grid-2">
        <Tile label="交易总数" value={<span className="num">{ov.txTotal.toLocaleString()}</span>} sub={`24 小时 ${ov.tx24h.toLocaleString()} 笔`} />
        <Tile label="实时 TPS" value={<span className="num">{ov.tps}</span>} sub="最近 1 分钟（不含投票）" />
        <Tile label="地址" value={<span className="num">{ov.addresses.toLocaleString()}</span>} sub={`资产 ${ov.tokens.length} 种`} />
        <Tile label="Gas 单价" value={<span className="num">{fmtVk(ov.feePerSig)}</span>} sub="VK / 签名（一半销毁）" />
        <Tile label="VK 总量" value={<span className="num">{fmtVk(ov.supply.total)}</span>} sub={`创世 ${fmtVk(ov.supply.genesis)}`} />
        <Tile label="已销毁" value={<span className="num">{fmtVk(ov.supply.burned)}</span>} sub="来自 gas 销毁" />
      </div>
      {!w && (
        <div className="banner banner--info">
          <VkCoin size={20} />
          <span>
            想转账、发币？先{' '}
            <button type="button" className="ch-link" onClick={() => chainGo('wallet')}>
              创建一个 VK 链钱包
            </button>
            ，领一点 VK 当 gas。
          </span>
        </div>
      )}
      <Card kicker="交易" title="最新交易">
        <TxList txs={ov.txs} empty="还没有交易：去钱包里领取 VK，就是第一笔" />
      </Card>
      <Card kicker="资产" title={`链上资产 · ${ov.tokens.length} 种`} right={<button type="button" className="btn btn--ghost" onClick={() => chainGo('issue')}>发行</button>}>
        {ov.tokens.length ? (
          <div className="ch-toklist">
            {ov.tokens.map((t) => (
              <TokenRow key={t.mint} t={t} />
            ))}
          </div>
        ) : (
          <div className="empty">还没有人发行资产</div>
        )}
      </Card>
    </>
  );
}

// ─── 详情页 ──────────────────────────────────────────────────

function DetailShell({ title, kicker, children }: { title: ReactNode; kicker: string; children: ReactNode }) {
  return (
    <>
      <button type="button" className="ch-back" onClick={() => (history.length > 1 ? history.back() : chainGo())}>
        <ChevronLeft size={16} /> 返回
      </button>
      <Card kicker={kicker} title={title}>
        {children}
      </Card>
    </>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row__k">{k}</span>
      <span className="row__v">{children}</span>
    </div>
  );
}

function TxDetail({ sig }: { sig: string }) {
  const { data: tx, error } = useChainTx(sig);
  const [logs, setLogs] = useState(false);
  if (!tx) return <DetailShell kicker="交易" title="交易详情">{error ? <div className="addr-preview addr-preview--warn">{error}</div> : <div className="empty">加载中…</div>}</DetailShell>;
  return (
    <>
      <DetailShell
        kicker="交易"
        title={
          <span className="ch-txhead">
            <KindIcon kind={tx.kind} ok={tx.ok} /> {tx.title}
          </span>
        }
      >
        <div className="rows">
          <Row k="状态">
            <span className={`chip ${tx.ok ? 'chip--up' : 'chip--down'}`}>{tx.ok ? '成功' : '失败'}</span>
            {tx.confirmations && <span className="muted"> · {tx.confirmations === 'finalized' ? '已最终确认' : '已确认'}</span>}
          </Row>
          {tx.err && <Row k="原因">{tx.err}</Row>}
          {tx.amount && (
            <Row k="金额">
              <b className="num">
                {fmtAmount(tx.amount.value)} {tx.amount.symbol}
              </b>
            </Row>
          )}
          {tx.from && (
            <Row k="付款方">
              <AddrLink a={tx.from} n={6} />
            </Row>
          )}
          {tx.to && (
            <Row k="收款方">
              <AddrLink a={tx.to} n={6} />
            </Row>
          )}
          {tx.mint && (
            <Row k="资产">
              <AddrLink a={tx.mint} label={tx.amount?.symbol && tx.amount.symbol !== 'VK' ? tx.amount.symbol : shortAddr(tx.mint, 6)} />
            </Row>
          )}
          {tx.memo && <Row k="备注">“{tx.memo}”</Row>}
          <Row k="时间">{tx.time ? `${new Date(tx.time * 1000).toLocaleString('zh-CN', { hour12: false })}（${fmtAgo(tx.time * 1000)}）` : '—'}</Row>
          <Row k="区块">
            <a className="ch-link num" href={chainLink.block(tx.slot)}>
              #{tx.slot}
            </a>
          </Row>
          <Row k="Gas">
            <span className="num">{fmtVk(tx.fee / 1e9)} VK</span>
            {tx.computeUnits != null && <span className="muted"> · {tx.computeUnits.toLocaleString()} 计算单元</span>}
          </Row>
          <Row k="付 gas">
            <AddrLink a={tx.payer} n={6} />
          </Row>
          <Row k="签名">
            <span className="ch-mono" style={{ fontSize: 11.5 }}>
              {shortAddr(tx.sig, 10)} <CopyBtn text={tx.sig} label="签名已复制" />
            </span>
          </Row>
        </div>
      </DetailShell>
      {(tx.vk.length > 0 || tx.tok.length > 0) && (
        <Card kicker="余额变化" title="这笔交易改变了谁的余额">
          <div className="rows">
            {tx.tok.map((t) => (
              <Row key={`${t.o}:${t.m}`} k="">
                <span className="ch-delta">
                  <AddrLink a={t.o} />
                  <b className={t.d > 0 ? 'up' : 'down'}>
                    {t.d > 0 ? '+' : '−'}
                    {fmtAmount(Math.abs(t.d), t.dec)} {t.m === tx.mint && tx.amount ? tx.amount.symbol : shortAddr(t.m, 3)}
                  </b>
                </span>
              </Row>
            ))}
            {tx.vk.map((x) => (
              <Row key={x.a} k="">
                <span className="ch-delta">
                  <AddrLink a={x.a} />
                  <b className={x.d > 0 ? 'up' : 'down'}>
                    {x.d > 0 ? '+' : '−'}
                    {fmtVk(Math.abs(x.d) / 1e9)} VK
                  </b>
                </span>
              </Row>
            ))}
          </div>
          <p className="card__note">VK 变化里包含付出去的 gas 和新账户押金。</p>
        </Card>
      )}
      <Card kicker="指令" title={`${tx.ix.length} 条指令`}>
        <div className="rows">
          {tx.ix.map((ix, i) => (
            <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
              <span className="row__k ch-mono" style={{ fontSize: 11.5 }}>
                #{i + 1} {ix.p}
              </span>
              <span className="row__v" style={{ fontSize: 12 }}>
                <b>{ix.t}</b>
                {ix.info &&
                  Object.entries(ix.info)
                    .slice(0, 6)
                    .map(([k, v]) => (
                      <div key={k} className="muted ch-mono" style={{ fontSize: 11 }}>
                        {k}: {typeof v === 'string' && v.length > 40 ? shortAddr(v, 6) : String(v)}
                      </div>
                    ))}
              </span>
            </div>
          ))}
        </div>
        {tx.logs && tx.logs.length > 0 && (
          <>
            <button type="button" className="btn btn--ghost" style={{ marginTop: 8 }} onClick={() => setLogs((v) => !v)}>
              {logs ? '收起' : '查看'}程序日志（{tx.logs.length} 行）
            </button>
            {logs && <pre className="ch-code ch-logs">{tx.logs.join('\n')}</pre>}
          </>
        )}
      </Card>
    </>
  );
}

const KIND_LABEL: Record<string, string> = { wallet: '钱包地址', program: '程序', token: '资产（代币）', 'token-account': '代币账户', sysvar: '系统变量', new: '新地址（链上还没有记录）' };

function AddressDetail({ addr }: { addr: string }) {
  const { data: v, error } = useChainAddress(addr, 8000);
  const w = useWallet();
  const mine = w?.address === addr;
  if (!v) return <DetailShell kicker="地址" title={shortAddr(addr, 6)}>{error ? <div className="addr-preview addr-preview--warn">{error}</div> : <div className="empty">加载中…</div>}</DetailShell>;
  const t = v.token;
  return (
    <>
      <DetailShell
        kicker={KIND_LABEL[v.kind] ?? '地址'}
        title={
          t ? (
            <span className="ch-txhead">
              <TokenIcon mint={t.mint} size={34} /> {t.name}（{t.symbol}）
            </span>
          ) : (
            (v.label ?? (mine ? '我的钱包' : shortAddr(addr, 6)))
          )
        }
      >
        <div className="ch-fulladdr ch-mono">
          {addr} <CopyBtn text={addr} label="地址已复制" />
        </div>
        <div className="rows">
          {t ? (
            <>
              <Row k="总量">
                <b className="num">{t.mirror ? fmtSol9(t.supply) : fmtAmount(t.supply, t.decimals)}</b> {t.symbol}
              </Row>
              <Row k="持有人">{t.holders ?? '—'}</Row>
              <Row k="小数位">{t.decimals}</Row>
              {t.mirror ? (
                <>
                  <Row k="增发 / 销毁">系统按公司主网真实余额自动调整</Row>
                  <Row k="转让">不可转让（链上规则锁定）</Row>
                </>
              ) : (
                <Row k="增发权限">{t.mintAuthority ? <AddrLink a={t.mintAuthority} /> : <span className="chip chip--accent">已放弃 · 总量固定</span>}</Row>
              )}
              {t.creator && (
                <Row k="发行人">
                  <AddrLink a={t.creator} />
                </Row>
              )}
              {t.createdAt && <Row k="发行时间">{new Date(t.createdAt * 1000).toLocaleString('zh-CN', { hour12: false })}</Row>}
              <Row k="标准">{t.program === 'token-2022' ? 'Token-2022（链上元数据）' : 'SPL Token'}</Row>
              {t.description && <Row k="简介">{t.description}</Row>}
            </>
          ) : (
            <>
              <Row k="VK 余额">
                <b className="num">{fmtVk(v.vk)}</b> VK
              </Row>
              {v.label && <Row k="标签">{v.label}</Row>}
              {v.tokenAccount && (
                <>
                  <Row k="所属资产">
                    <AddrLink a={v.tokenAccount.mint} />
                  </Row>
                  <Row k="持有人">
                    <AddrLink a={v.tokenAccount.owner} />
                  </Row>
                  <Row k="数量">{fmtAmount(v.tokenAccount.amount)}</Row>
                </>
              )}
              {v.kind === 'program' && v.space != null && <Row k="程序大小">{(v.space / 1024).toFixed(1)} KB</Row>}
            </>
          )}
        </div>
      </DetailShell>
      {v.mirror && <MirrorCard m={v.mirror} onTokenPage />}
      {!t && v.tokens.length > 0 && (
        <Card kicker="资产" title={`持有 ${v.tokens.length} 种资产`}>
          <div className="ch-toklist">
            {v.tokens.map((x) => (
              <a key={x.account} className="ch-tokrow" href={chainLink.address(x.mint)}>
                <TokenIcon mint={x.mint} />
                <span className="ch-tokrow__name">
                  <b>{x.symbol ?? shortAddr(x.mint, 4)}</b>
                  <span className="muted">{x.name ?? '资产'}</span>
                </span>
                <span className="ch-tokrow__amt num">{fmtAmount(x.amount, x.decimals)}</span>
              </a>
            ))}
          </div>
        </Card>
      )}
      <Card kicker="记录" title={`交易 · ${v.txs.length}${v.txs.length >= 60 ? '+' : ''} 笔`}>
        <TxList txs={v.txs} me={t ? undefined : addr} empty="这个地址还没有交易" />
      </Card>
    </>
  );
}

function BlockDetail({ slot }: { slot: number }) {
  const { data: b, error } = useChainBlock(slot);
  return (
    <>
      <DetailShell kicker="区块" title={<span className="num">#{slot.toLocaleString()}</span>}>
        {!b ? (
          error ? (
            <div className="addr-preview addr-preview--warn">{error}</div>
          ) : (
            <div className="empty">加载中…</div>
          )
        ) : (
          <div className="rows">
            <Row k="时间">{b.time ? `${new Date(b.time * 1000).toLocaleString('zh-CN', { hour12: false })}（${fmtAgo(b.time * 1000)}）` : '—'}</Row>
            <Row k="区块高度">{b.height?.toLocaleString() ?? '—'}</Row>
            <Row k="交易">{b.txs} 笔</Row>
            <Row k="Gas 合计">{fmtVk(b.fees / 1e9)} VK</Row>
            <Row k="区块哈希">
              <span className="ch-mono" style={{ fontSize: 11.5 }}>
                {shortAddr(b.hash, 8)} <CopyBtn text={b.hash} label="区块哈希已复制" />
              </span>
            </Row>
            <Row k="上一个区块">
              <a className="ch-link num" href={chainLink.block(b.parentSlot)}>
                #{b.parentSlot}
              </a>
            </Row>
          </div>
        )}
        <div className="ch-actions" style={{ justifyContent: 'space-between' }}>
          <a className="btn btn--ghost" href={chainLink.block(Math.max(0, slot - 1))}>
            ← #{slot - 1}
          </a>
          <a className="btn btn--ghost" href={chainLink.block(slot + 1)}>
            #{slot + 1} →
          </a>
        </div>
      </DetailShell>
      {b && (
        <Card kicker="交易" title={`${b.txs} 笔交易`}>
          <TxList txs={b.txList} empty="空块：这个区块里没有交易（Alpenglow 共识下投票不上链）" />
        </Card>
      )}
    </>
  );
}

// ─── 页面 ────────────────────────────────────────────────────

export function ChainPage() {
  const path = useChainPath();
  const { data: ov } = useChainOverview(2000);
  const blocks = useBlockStream(ov);
  useNow(1000); // 让"几秒前"每秒刷新
  const view = path[0] ?? '';
  const id = path[1] ?? '';
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view, id]);
  const detail = view === 'tx' || view === 'address' || view === 'block';
  const tab: Tab = view === 'wallet' ? 'wallet' : view === 'issue' ? 'issue' : view === 'node' ? 'node' : 'explorer';
  return (
    <div className="ch-page">
      {!detail && tab === 'explorer' && <ChainHero ov={ov} latest={blocks[0]} />}
      {!detail && (
        <nav className="ch-tabs" aria-label="VK 链">
          {TABS.map((t) => (
            <a key={t.key} href={`#/chain${t.path ? `/${t.path}` : ''}`} className={tab === t.key ? 'ch-tab ch-tab--on' : 'ch-tab'} aria-current={tab === t.key ? 'page' : undefined}>
              {t.label}
            </a>
          ))}
        </nav>
      )}
      {ov && !ov.online && (
        <div className="banner" role="status">
          <span>VK 链节点暂时连不上（{ov.error ?? '未知原因'}），正在自动重连。</span>
        </div>
      )}
      {view === 'tx' && id ? (
        <TxDetail sig={id} />
      ) : view === 'address' && id ? (
        <AddressDetail addr={id} />
      ) : view === 'block' && id ? (
        <BlockDetail slot={Number(id)} />
      ) : tab === 'wallet' ? (
        <WalletTab ov={ov} />
      ) : tab === 'issue' ? (
        <IssueTab ov={ov} />
      ) : tab === 'node' ? (
        <NodeTab ov={ov} />
      ) : (
        <ExplorerHome ov={ov} blocks={blocks} />
      )}
    </div>
  );
}
