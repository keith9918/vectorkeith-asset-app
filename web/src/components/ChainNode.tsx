// VK 链「节点」页：节点状态、创世分配 / 总量、gas 规则、外部钱包 / 开发者接入、管理员面板
import { Cpu, Gift, HardDrive, MemoryStick, RefreshCw, Server, Terminal, Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChainAdminView, ChainOverview } from '../../../shared/chain';
import { apiUrl } from '../lib/api';
import { bumpChain, chainApi, chainLink, fmtVk, isAddress } from '../lib/chain';
import { fmtAgo, shortAddr } from '../lib/format';
import { useStore } from '../lib/store';
import { AddrLink, CopyBtn } from './ChainBits';
import { Card, Meter, Seg, toast } from './ui';

const ALLOC_COLORS: Record<string, string> = { treasury: '#0b93ab', reserve: '#4566d9', faucet: '#16b98a', node: '#9085e9', system: '#5b6b86' };

function fmtUptime(sec?: number) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

function NodeStatus({ ov }: { ov: ChainOverview }) {
  const epochPct = ov.slotsInEpoch ? ov.slotIndex / ov.slotsInEpoch : 0;
  return (
    <Card kicker="节点状态" title={ov.online ? '运行中' : '连接中断'} right={<span className={`chip ${ov.online ? 'chip--up' : 'chip--down'}`}>{ov.online ? '● 在线' : '● 离线'}</span>}>
      <div className="rows">
        <div className="row">
          <span className="row__k">网络</span>
          <span className="row__v">{ov.name} 正式网 · 单节点</span>
        </div>
        <div className="row">
          <span className="row__k">共识</span>
          <span className="row__v">{ov.consensus}（Solana 新一代共识，投票不上链，出块即确认）</span>
        </div>
        <div className="row">
          <span className="row__k">节点软件</span>
          <span className="row__v">Agave {ov.version ?? '—'}</span>
        </div>
        <div className="row">
          <span className="row__k">区块高度 / slot</span>
          <span className="row__v num">
            {ov.height.toLocaleString()} / {ov.slot.toLocaleString()}
          </span>
        </div>
        <div className="row">
          <span className="row__k">出块间隔</span>
          <span className="row__v num">{(ov.slotMs / 1000).toFixed(2)} 秒</span>
        </div>
        <div className="row">
          <span className="row__k">Epoch {ov.epoch}</span>
          <span className="row__v" style={{ width: '55%' }}>
            <Meter value={epochPct} label="本期进度" />
          </span>
        </div>
        {ov.genesisHash && (
          <div className="row">
            <span className="row__k">创世哈希</span>
            <span className="row__v ch-mono">
              {shortAddr(ov.genesisHash, 6)} <CopyBtn text={ov.genesisHash} label="创世哈希已复制" />
            </span>
          </div>
        )}
        {ov.genesisAt && (
          <div className="row">
            <span className="row__k">创世时间</span>
            <span className="row__v">{new Date(ov.genesisAt * 1000).toLocaleString('zh-CN', { hour12: false })}</span>
          </div>
        )}
      </div>
      {!ov.online && ov.error && <p className="card__note">{ov.error}</p>}
    </Card>
  );
}

function Tokenomics({ ov }: { ov: ChainOverview }) {
  const total = ov.supply.genesis || 1;
  const parts = ov.allocation.filter((a) => a.genesis > 0);
  return (
    <Card kicker="原生币 VK" title="创世分配">
      <div className="ch-supply">
        <div>
          <span className="muted">创世总量</span>
          <b className="num">{fmtVk(ov.supply.genesis)}</b>
        </div>
        <div>
          <span className="muted">当前总量</span>
          <b className="num">{fmtVk(ov.supply.total)}</b>
        </div>
        <div>
          <span className="muted">已销毁（gas）</span>
          <b className="num down">{fmtVk(ov.supply.burned)}</b>
        </div>
      </div>
      <div className="segbar" style={{ marginTop: 12 }} aria-label="创世分配比例">
        {parts.map((a) => (
          <div key={a.key} className="segbar__part" style={{ width: `${(a.genesis / total) * 100}%`, background: ALLOC_COLORS[a.key] }} title={`${a.label} ${((a.genesis / total) * 100).toFixed(2)}%`}>
            {a.genesis / total > 0.12 ? `${((a.genesis / total) * 100).toFixed(0)}%` : ''}
          </div>
        ))}
      </div>
      <div className="rows" style={{ marginTop: 6 }}>
        {parts.map((a) => (
          <div key={a.key} className="row">
            <span className="row__k" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <i className="swatch" style={{ background: ALLOC_COLORS[a.key] }} />
              {a.address ? <AddrLink a={a.address} label={a.label} /> : a.label}
            </span>
            <span className="row__v num">
              {fmtVk(a.genesis)} <span className="muted">（{((a.genesis / total) * 100).toFixed(a.genesis / total < 0.01 ? 4 : 1)}%）</span>
              {a.key !== 'system' && <div className="muted" style={{ fontSize: 11.5 }}>现有 {fmtVk(a.balance)}</div>}
            </span>
          </div>
        ))}
      </div>
      <p className="card__note">
        创世时一次性发行，之后不再增发（通胀率 0）。每笔交易的 gas 一半销毁、一半给出块节点，所以总量只会慢慢变少。累计 gas {fmtVk(ov.gasTotal)} VK。
      </p>
    </Card>
  );
}

function GasRules({ ov }: { ov: ChainOverview }) {
  return (
    <Card kicker="Gas" title="用 VK 付手续费">
      <div className="rows">
        <div className="row">
          <span className="row__k">每个签名</span>
          <span className="row__v num">{fmtVk(ov.feePerSig)} VK</span>
        </div>
        <div className="row">
          <span className="row__k">去向</span>
          <span className="row__v">50% 销毁 · 50% 给出块节点</span>
        </div>
        <div className="row">
          <span className="row__k">新账户押金</span>
          <span className="row__v">≥ 0.00089088 VK（免租金最低余额，关闭账户可退回）</span>
        </div>
        <div className="row">
          <span className="row__k">发行一种资产</span>
          <span className="row__v">约 0.0056 VK 押金 + 0.000005 VK gas</span>
        </div>
      </div>
    </Card>
  );
}

function DevGuide({ ov }: { ov: ChainOverview }) {
  const rpc = apiUrl(ov.rpcPath).startsWith('http') ? apiUrl(ov.rpcPath) : `${location.origin}${ov.rpcPath}`;
  const ws = rpc.replace(/^http/, 'ws');
  return (
    <Card kicker="外部钱包 / 开发者" title="用其他工具连 VK 链">
      <div className="rows">
        <div className="row">
          <span className="row__k">RPC 地址</span>
          <span className="row__v ch-mono" style={{ fontSize: 12 }}>
            {rpc} <CopyBtn text={rpc} label="RPC 地址已复制" />
          </span>
        </div>
        <div className="row">
          <span className="row__k">WebSocket</span>
          <span className="row__v ch-mono" style={{ fontSize: 12 }}>
            {ws} <CopyBtn text={ws} label="WebSocket 地址已复制" />
          </span>
        </div>
      </div>
      <ul className="ch-bullets" style={{ marginTop: 10 }}>
        <li>Solflare / Backpack：设置 → 网络 → 自定义 RPC，填上面的 RPC 地址；导入 App 里备份的私钥即可。外部钱包会把 VK 显示成"SOL"，这是正常的（它们按 Solana 的单位名称显示）</li>
        <li>Phantom 不支持自定义网络，用不了</li>
        <li>不支持 requestAirdrop：VK 请在 App 钱包里领取，或找管理员发放</li>
      </ul>
      <pre className="ch-code">
        <Terminal size={13} /> {`solana config set --url ${rpc}
solana balance
spl-token create-token --program-2022 --enable-metadata`}
      </pre>
    </Card>
  );
}

// ─── 管理员 ──────────────────────────────────────────────────

function AdminPanel() {
  const [v, setV] = useState<ChainAdminView | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [from, setFrom] = useState<'treasury' | 'reserve'>('treasury');
  const [refill, setRefill] = useState('100000');
  const [fa, setFa] = useState({ amount: '', cooldown: '', perIp: '' });
  const load = () =>
    chainApi
      .adminView()
      .then((x) => {
        setV(x);
        setErr('');
        setFa((f) => (f.amount ? f : { amount: String(x.faucet.amount), cooldown: String(x.faucet.cooldownH), perIp: String(x.faucet.perIpPerDay) }));
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    void load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);
  const run = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    try {
      const r = await chainApi.admin(body);
      toast(okMsg + (r.sig ? ` · ${shortAddr(r.sig, 4)}` : ''));
      bumpChain();
      await load();
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!v) return <Card kicker="管理员" title="节点管理">{err ? <div className="addr-preview addr-preview--warn">{err}</div> : <div className="empty">加载中…</div>}</Card>;
  const n = v.node;
  return (
    <>
      <Card kicker="管理员" title="节点资源" right={<button type="button" className="icon-btn" aria-label="刷新" onClick={() => void load()}><RefreshCw size={16} /></button>}>
        <div className="grid-2">
          <div className="tile">
            <div className="tile__label">
              <Cpu size={12} /> CPU
            </div>
            <div className="tile__value num">{n.cpuPct != null ? `${n.cpuPct}%` : '—'}</div>
            <div className="tile__sub">上限 1 个核（低优先级）</div>
          </div>
          <div className="tile">
            <div className="tile__label">
              <MemoryStick size={12} /> 内存
            </div>
            <div className="tile__value num">{n.memMB != null ? `${n.memMB} MB` : '—'}</div>
            <div className="tile__sub">上限 1300 MB</div>
          </div>
          <div className="tile">
            <div className="tile__label">
              <Timer size={12} /> 已运行
            </div>
            <div className="tile__value">{fmtUptime(n.uptimeSec)}</div>
            <div className="tile__sub">{n.active ? '服务运行中' : '服务未运行'}</div>
          </div>
          <div className="tile">
            <div className="tile__label">
              <HardDrive size={12} /> 磁盘剩余
            </div>
            <div className="tile__value num">{n.diskFreeGB != null ? `${n.diskFreeGB} GB` : '—'}</div>
            <div className="tile__sub">共 {n.diskTotalGB ?? '—'} GB</div>
          </div>
        </div>
        <div className="rows" style={{ marginTop: 8 }}>
          <div className="row">
            <span className="row__k">
              <Server size={12} /> 节点身份
            </span>
            <span className="row__v">{n.identity ? <AddrLink a={n.identity} /> : '—'}</span>
          </div>
          <div className="row">
            <span className="row__k">索引进度</span>
            <span className="row__v num">
              slot {v.index.lastSlot.toLocaleString()}（落后 {v.index.behind}）· {v.index.txs} 笔交易 · {v.index.tokens} 种资产
            </span>
          </div>
        </div>
      </Card>
      <Card kicker="管理员" title="账户余额">
        <div className="rows">
          {v.keys.map((k) => (
            <div key={k.key} className="row">
              <span className="row__k">
                <AddrLink a={k.address} label={k.label} />
                {!k.loaded && <span className="chip chip--warn" style={{ marginLeft: 6 }}>私钥不在服务器</span>}
              </span>
              <span className="row__v num">{fmtVk(k.vk)} VK</span>
            </div>
          ))}
        </div>
      </Card>
      <Card kicker="管理员" title="发放 VK">
        <div className="ch-optrow">
          <span className="muted">从</span>
          <Seg
            value={from}
            onChange={setFrom}
            label="发放来源"
            options={[
              { value: 'treasury', label: '公司金库' },
              { value: 'reserve', label: '生态储备' },
            ]}
          />
        </div>
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor="ch-ad-to">收款地址</label>
          <input id="ch-ad-to" className="ch-mono" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="员工的 VK 链地址" spellCheck={false} />
        </div>
        <div className="ch-inline">
          <input className="input num" inputMode="decimal" placeholder="数量（VK）" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          <input className="input" placeholder="备注（可选）" value={memo} maxLength={60} onChange={(e) => setMemo(e.target.value)} />
        </div>
        <button
          type="button"
          className="btn btn--solid ch-wide"
          style={{ marginTop: 10 }}
          disabled={busy || !isAddress(to) || !(Number(amount) > 0)}
          onClick={async () => {
            if (!confirm(`从${from === 'treasury' ? '公司金库' : '生态储备'}发放 ${amount} VK 到 ${shortAddr(to, 4)}？`)) return;
            if (await run({ action: 'airdrop', from, to, amount, memo }, `已发放 ${amount} VK`)) {
              setAmount('');
              setMemo('');
            }
          }}
        >
          <Gift size={15} /> 发放
        </button>
      </Card>
      <Card kicker="管理员" title="水龙头">
        <label className="toggle" style={{ borderTop: 0 }}>
          <span>
            开放领取
            <em>关闭后员工不能自助领取 VK</em>
          </span>
          <input type="checkbox" role="switch" checked={v.faucet.enabled} disabled={busy} onChange={(e) => void run({ action: 'settings', faucetEnabled: e.target.checked }, e.target.checked ? '水龙头已开启' : '水龙头已暂停')} />
        </label>
        <label className="toggle">
          <span>
            每个钱包只能领一次
            <em>开启后不看间隔小时：领过就不能再领（新钱包领一点当 gas）</em>
          </span>
          <input type="checkbox" role="switch" checked={v.faucet.once} disabled={busy} onChange={(e) => void run({ action: 'settings', faucetOnce: e.target.checked }, e.target.checked ? '已改为每个钱包只能领一次' : '已改为按间隔小时领取')} />
        </label>
        <div className="ch-faucetgrid">
          <div className="field">
            <label htmlFor="ch-fa-amt">每次 VK</label>
            <input id="ch-fa-amt" className="num" inputMode="decimal" value={fa.amount} onChange={(e) => setFa({ ...fa, amount: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="ch-fa-cd">间隔小时</label>
            <input id="ch-fa-cd" className="num" inputMode="numeric" value={fa.cooldown} disabled={v.faucet.once} onChange={(e) => setFa({ ...fa, cooldown: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="ch-fa-ip">每网络每天</label>
            <input id="ch-fa-ip" className="num" inputMode="numeric" value={fa.perIp} onChange={(e) => setFa({ ...fa, perIp: e.target.value })} />
          </div>
        </div>
        <p className="card__note" style={{ marginTop: 0, marginBottom: 8 }}>
          每次发放多少 VK；同一个地址隔多少小时才能再领（"只能领一次"开启时不起作用）；同一个网络（IP）每天最多领几次。
        </p>
        <button type="button" className="btn" disabled={busy} onClick={() => void run({ action: 'settings', faucetAmount: Number(fa.amount), faucetCooldownH: Number(fa.cooldown), faucetPerIpPerDay: Number(fa.perIp) }, '水龙头设置已保存')}>
          保存设置
        </button>
        <div className="rows" style={{ marginTop: 10 }}>
          <div className="row">
            <span className="row__k">领过的钱包</span>
            <span className="row__v num">{v.faucet.claimedAddresses} 个</span>
          </div>
          <div className="row">
            <span className="row__k">今天领取</span>
            <span className="row__v num">{v.faucet.claimsToday} 次</span>
          </div>
          <div className="row">
            <span className="row__k">近 30 天合计</span>
            <span className="row__v num">
              {v.faucet.claimsTotal} 次 · {fmtVk(v.faucet.givenTotal)} VK
            </span>
          </div>
        </div>
        <div className="ch-inline" style={{ marginTop: 10 }}>
          <input className="input num" inputMode="decimal" value={refill} onChange={(e) => setRefill(e.target.value.replace(/[^\d.]/g, ''))} aria-label="补充数量" />
          <button type="button" className="btn" disabled={busy || !(Number(refill) > 0)} onClick={() => void run({ action: 'refill', amount: refill }, `已从金库补充 ${refill} VK`)}>
            从金库补充
          </button>
        </div>
        {v.recentClaims.length > 0 && (
          <div className="ch-claims">
            {v.recentClaims.slice(0, 8).map((c) => (
              <a key={c.sig} className="row" href={chainLink.tx(c.sig)}>
                <span className="row__k ch-mono">{shortAddr(c.address, 4)}</span>
                <span className="row__v num">
                  +{fmtVk(c.amount)} VK <span className="muted">· {fmtAgo(c.at)}</span>
                </span>
              </a>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

export function NodeTab({ ov }: { ov: ChainOverview | null }) {
  const role = useStore((s) => s.access?.role);
  if (!ov) return <div className="empty">加载中…</div>;
  return (
    <>
      <NodeStatus ov={ov} />
      <Tokenomics ov={ov} />
      <GasRules ov={ov} />
      <DevGuide ov={ov} />
      {role === 'admin' && <AdminPanel />}
    </>
  );
}
