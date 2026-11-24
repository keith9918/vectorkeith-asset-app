import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EpochInfoView, HolderStaking, StakePositions, StakingView } from '../../../shared/types';
import { useCur } from '../components/Shell';
import { InternalTab } from '../components/InternalStaking';
import { StakeAccountRow, StakeTool } from '../components/StakeTool';
import { Card, Seg, toast } from '../components/ui';
import { postJSON } from '../lib/api';
import { CUR_SYMBOL, fmtCompact, fmtMoney, fmtNum, fmtPct, fmtSol } from '../lib/format';
import { useNow, useSolTo } from '../lib/hooks';
import { setPrefs, usePrefs } from '../lib/prefs';
import { useShareholders } from '../lib/shareholders';
import { fmtDuration, lookupStake, projectedEarnings, useHolderStaking, useStaking } from '../lib/staking';
import { useStore } from '../lib/store';
import { Loading } from './common';

// ─── 期（epoch）进度 ─────────────────────────────────────────

function EpochCard({ e }: { e: EpochInfoView }) {
  const now = useNow(1000);
  // 拿到服务器数据的时刻；之后本地按时间推算进度，每秒刷新倒计时
  const at = useMemo(() => Date.now(), [e]);
  const passed = Math.max(0, (now - at) / 1000);
  const left = Math.max(0, e.endsInSec - passed);
  const progress = Math.min(1, e.progress + passed / e.epochSec);
  const R = 26;
  const C = 2 * Math.PI * R;
  const perYear = (365.25 * 86400) / e.epochSec;
  return (
    <section className="card epoch-card" aria-label="质押收益发放周期">
      <svg width="68" height="68" viewBox="0 0 68 68" aria-hidden>
        <circle cx="34" cy="34" r={R} className="epoch-ring__track" />
        <circle cx="34" cy="34" r={R} className="epoch-ring__fill" strokeDasharray={`${C * progress} ${C}`} transform="rotate(-90 34 34)" />
        <text x="34" y="38" textAnchor="middle" className="epoch-ring__txt">
          {Math.floor(progress * 100)}%
        </text>
      </svg>
      <div style={{ minWidth: 0 }}>
        <div className="kicker">Epoch {e.epoch}</div>
        <div className="epoch-card__big">
          下一期收益 <b>{fmtDuration(left)}</b>后发放
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Solana 每期约 {fmtDuration(e.epochSec)}，一年约 {Math.round(perYear)} 期；收益每期自动发到质押账户并复投
        </div>
      </div>
    </section>
  );
}

// ─── 质押持仓（账户 + LST） ───────────────────────────────────

function PositionsList({ p, empty }: { p: StakePositions; empty: string }) {
  const { primary } = useCur();
  const solTo = useSolTo();
  if (!p.accounts.length && !p.lst.length) return <div className="muted" style={{ fontSize: 12.5, padding: '6px 0' }}>{empty}</div>;
  return (
    <div>
      {p.accounts.map((a) => (
        <StakeAccountRow key={a.address} a={a} />
      ))}
      {p.lst.map((l) => (
        <div key={l.owner + l.mint} className="stake-row">
          <span className="val-av val-av--txt" style={{ width: 30, height: 30 }}>
            {l.symbol.slice(0, 1)}
          </span>
          <div className="stake-row__main">
            <div className="stake-row__title">
              {l.symbol}
              <span className="chip stake-st stake-st--active">流动性质押</span>
            </div>
            <div className="stake-row__sub">
              {fmtNum(l.amount, 4)} 枚 · 1 {l.symbol} = {fmtNum(l.solPerToken, 4)} SOL{l.apy ? ` · 约 ${fmtNum(l.apy, 2)}%` : ''}
            </div>
          </div>
          <div className="flow-row__amt">
            <span>{fmtSol(l.sol)} SOL</span>
            <span className="muted">{fmtMoney(l.sol * solTo[primary], primary)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function PositionsSummary({ p }: { p: StakePositions }) {
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  return (
    <div className="stat3">
      <div>
        <span>质押中</span>
        <b>{p.stakedSol >= 10_000 ? fmtCompact(p.stakedSol, 2) : fmtSol(p.stakedSol)} SOL</b>
        <em>
          {fmtMoney(p.stakedSol * solTo[primary], primary)}
          <br />
          {fmtMoney(p.stakedSol * solTo[secondary], secondary)}
        </em>
      </div>
      <div>
        <span>年化</span>
        <b>{p.apy ? `${fmtNum(p.apy, 2)}%` : '—'}</b>
        <em>按上一期实际收益</em>
      </div>
      <div>
        <span>上一期收益</span>
        <b className={p.lastEpochReward > 0 ? 'up' : ''}>+{fmtSol(p.lastEpochReward)} SOL</b>
        <em>{fmtMoney(p.lastEpochReward * solTo[primary], primary)}</em>
      </div>
    </div>
  );
}

// ─── 公司质押 ─────────────────────────────────────────────────

function CompanyHero({ v, potentialPct, setPotentialPct }: { v: StakingView; potentialPct: number; setPotentialPct: (n: number) => void }) {
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const c = v.company;
  const total = c.walletSol + c.stakedSol;
  const apy = c.apy ?? v.networkApy;
  const ep = v.epoch.epochSec;
  if (c.stakedSol > 0) {
    const yearly = projectedEarnings(c.stakedSol, apy, 365, ep);
    return (
      <Card className="hero-card" kicker="Company Staking" title="公司总质押" right={<span className="chip chip--accent">年化 {fmtNum(apy, 2)}%</span>}>
        <div className="glow-orb" />
        <div className="hero-value">
          {fmtSol(c.stakedSol)}
          <small style={{ fontSize: 18, marginLeft: 6 }}>SOL</small>
        </div>
        <div className="hero-sub">
          <span>
            <b>{fmtMoney(c.stakedSol * solTo[primary], primary)}</b>
          </span>
          <span>
            <b>{fmtMoney(c.stakedSol * solTo[secondary], secondary)}</b>
          </span>
          <span>占公司资产 {fmtPct(total > 0 ? c.stakedSol / total : 0, 1)}</span>
        </div>
        <div className="rows" style={{ marginTop: 10 }}>
          <div className="row">
            <span className="row__k">投入本金</span>
            <span className="row__v mono">{fmtSol(c.principal)} SOL</span>
          </div>
          <div className="row">
            <span className="row__k">累计质押收益</span>
            <span className="row__v mono up">
              +{fmtSol(c.rewardsSol)} SOL <span className="muted">{fmtMoney(c.rewardsSol * solTo[primary], primary)}</span>
            </span>
          </div>
          <div className="row">
            <span className="row__k">上一期收益</span>
            <span className="row__v mono">+{fmtSol(c.lastEpochReward)} SOL</span>
          </div>
          <div className="row">
            <span className="row__k">预计每年</span>
            <span className="row__v mono">
              +{fmtSol(yearly)} SOL <span className="muted">{fmtMoney(yearly * solTo[primary], primary)}</span>
            </span>
          </div>
        </div>
        <p className="card__note">
          质押中的 SOL 仍是公司的（提取权限在公司钱包），{v.includeInAssets ? '已计入公司总资产' : '目前没有计入公司总资产（管理员已关闭）'}。钱包里还有 {fmtSol(c.walletSol)} SOL 没有质押。
        </p>
      </Card>
    );
  }
  const amount = (c.walletSol * potentialPct) / 100;
  const yearly = projectedEarnings(amount, apy, 365, ep);
  const perEpoch = projectedEarnings(amount, apy, ep / 86400, ep);
  return (
    <Card className="hero-card" kicker="Company Staking" title="公司总质押" right={<span className="chip">还没有质押</span>}>
      <div className="glow-orb" />
      <p style={{ margin: '0 0 6px', fontSize: 13.5, color: 'var(--text-2)' }}>
        公司钱包里有 <b style={{ color: 'var(--text-1)' }}>{fmtSol(c.walletSol)} SOL</b> 闲着。如果拿出 <b style={{ color: 'var(--text-1)' }}>{potentialPct}%</b> 去质押：
      </p>
      <div className="hero-value">
        <small>+</small>
        {fmtSol(yearly)}
        <small style={{ fontSize: 18, marginLeft: 6 }}>SOL / 年</small>
      </div>
      <div className="hero-sub">
        <span>
          <b>{fmtMoney(yearly * solTo[primary], primary)}</b>
        </span>
        <span>
          <b>{fmtMoney(yearly * solTo[secondary], secondary)}</b>
        </span>
        <span>每期 +{fmtSol(perEpoch)} SOL</span>
      </div>
      <input className="tm-slider" type="range" min={0} max={100} step={5} value={potentialPct} aria-label="拿出多少比例去质押" onChange={(e) => setPotentialPct(Number(e.target.value))} />
      <div className="tm-axis">
        <span>质押 {fmtSol(amount)} SOL</span>
        <span>留在钱包 {fmtSol(c.walletSol - amount)} SOL</span>
      </div>
      <p className="card__note">按全网质押加权平均年化 {fmtNum(v.networkApy, 2)}%（含 Jito MEV 分成）估算，收益每期复投。质押后 SOL 仍在公司自己的质押账户里，{v.includeInAssets ? '照样计入公司总资产' : '目前设置为不计入公司总资产'}，随时可以解除。</p>
    </Card>
  );
}

function ProfitShare({ yearly, epochSec, ratio, actual }: { yearly: number; epochSec: number; ratio: number; actual: boolean }) {
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const role = useStore((s) => s.access?.role ?? 'public');
  const { view } = useShareholders();
  const perEpoch = (yearly * epochSec) / (365.25 * 86400);
  const holders = view?.holders ?? [];
  return (
    <Card kicker="Profit Share" title="质押收益分成" right={<span className="chip">{actual ? '按实际质押' : '按上面的假设'}</span>}>
      <div className="rows">
        <div className="row">
          <span className="row__k">每年质押收益</span>
          <span className="row__v">
            <b className="mono">+{fmtSol(yearly)} SOL</b>
            <div className="muted" style={{ fontSize: 11.5 }}>
              {fmtMoney(yearly * solTo[primary], primary)} · {fmtMoney(yearly * solTo[secondary], secondary)}
            </div>
          </span>
        </div>
        <div className="row">
          <span className="row__k">其中进入分红池（{fmtPct(ratio, 0)}）</span>
          <span className="row__v mono">
            +{fmtSol(yearly * ratio)} SOL <span className="muted">{fmtMoney(yearly * ratio * solTo[primary], primary)}</span>
          </span>
        </div>
      </div>
      <div className="wm__title" style={{ marginTop: 12 }}>
        按持股比例分成
      </div>
      {role === 'admin' || role === 'holder' ? (
        holders.length ? (
          <div className="share-table">
            <div className="share-table__head">
              <span>股东</span>
              <span>持股</span>
              <span>每期</span>
              <span>每年</span>
            </div>
            {holders.map((h) => (
              <div key={h.id} className="share-table__row">
                <span>{h.name}</span>
                <span className="mono">{+h.pct.toFixed(4)}%</span>
                <span className="mono">+{fmtSol((perEpoch * h.pct) / 100)}</span>
                <span className="mono">
                  +{fmtSol((yearly * h.pct) / 100)}
                  <em>{fmtMoney(((yearly * h.pct) / 100) * solTo[primary], primary)}</em>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12.5 }}>{role === 'admin' ? '还没有登记股东，到「股东」页添加后这里会按持股比例分好。' : '没有找到你的持股记录。'}</div>
        )
      ) : (
        <div className="muted" style={{ fontSize: 12.5 }}>股东用查看码登录后，这里会显示自己按持股比例分到的质押收益。</div>
      )}
      <p className="card__note">质押收益让公司总资产变多：分红 = 总资产 × {fmtPct(ratio, 0)}，所以分红池同步增加；每位股东按持股比例享有对应的部分。单位 SOL，按现价折合{primary === 'cny' ? '人民币' : '美元'}。</p>
    </Card>
  );
}

function IncludeToggle({ v, onChanged }: { v: StakingView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const set = async (on: boolean) => {
    setBusy(true);
    try {
      await postJSON('/api/admin/staking', { includeInAssets: on });
      toast(on ? '质押中的 SOL 已计入公司总资产' : '质押中的 SOL 不再计入公司总资产');
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <span className="row__k">质押中的 SOL 计入公司总资产（管理员）</span>
      <Seg<'on' | 'off'>
        label="计入公司总资产"
        value={v.includeInAssets ? 'on' : 'off'}
        onChange={(x) => !busy && void set(x === 'on')}
        options={[
          { value: 'on', label: '计入' },
          { value: 'off', label: '不计入' },
        ]}
      />
    </div>
  );
}

function CompanyTab({ v, reload }: { v: StakingView; reload: () => void }) {
  const role = useStore((s) => s.access?.role ?? 'public');
  const ratio = useStore((s) => s.snap?.treasury.dividendRatio ?? 0.1);
  const [pct, setPct] = useState(90);
  const c = v.company;
  const apy = c.apy ?? v.networkApy;
  const actual = c.stakedSol > 0;
  const yearly = projectedEarnings(actual ? c.stakedSol : (c.walletSol * pct) / 100, apy, 365, v.epoch.epochSec);
  return (
    <>
      <CompanyHero v={v} potentialPct={pct} setPotentialPct={setPct} />
      <ProfitShare yearly={yearly} epochSec={v.epoch.epochSec} ratio={ratio} actual={actual} />
      <Card kicker="Positions" title="公司质押明细" right={<span className="chip">{c.accounts.length + c.lst.length} 笔</span>}>
        {actual && <PositionsSummary p={c} />}
        <div style={{ marginTop: actual ? 10 : 0 }}>
          <PositionsList p={c} empty="公司钱包还没有质押账户，也没有 JitoSOL 等流动性质押代币。" />
        </div>
        {role === 'admin' && (
          <div className="rows" style={{ marginTop: 8 }}>
            <IncludeToggle v={v} onChanged={reload} />
          </div>
        )}
        <p className="card__note">自动识别公司钱包名下的全部质押账户（提取权限或质押权限是公司钱包），以及钱包里的 JitoSOL、mSOL、bSOL、JupSOL、INF 等流动性质押代币。</p>
      </Card>
      {role === 'admin' ? (
        <StakeTool companyMode title="用公司钱包质押（管理员）" validators={v.validators} epochSec={v.epoch.epochSec} endsInSec={v.epoch.endsInSec} />
      ) : (
        <Card kicker="Stake" title="怎么质押">
          <p className="card__note" style={{ marginTop: 0 }}>
            公司质押由管理员用公司钱包操作。个人想质押自己的 SOL，切换到上面的「个人质押」。
          </p>
        </Card>
      )}
    </>
  );
}

// ─── 个人质押 ─────────────────────────────────────────────────

function HolderBlock({ h, open, onToggle }: { h: HolderStaking; open: boolean; onToggle: () => void }) {
  const solTo = useSolTo();
  const { primary } = useCur();
  const p = h.positions;
  return (
    <div className="holder">
      <button type="button" className="holder__top" style={{ width: '100%', textAlign: 'left' }} onClick={onToggle} aria-expanded={open}>
        <div className="holder__name">
          {h.name}
          <span className="chip chip--accent">{+h.pct.toFixed(4)}%</span>
        </div>
        <div className="holder__due">
          {fmtSol(p.stakedSol)} SOL
          <div className="muted">
            {fmtMoney(p.stakedSol * solTo[primary], primary)}
            {p.apy ? ` · 年化 ${fmtNum(p.apy, 2)}%` : ''}
          </div>
        </div>
      </button>
      <div className="holder__meta">
        上一期收益 +{fmtSol(p.lastEpochReward)} SOL · 钱包可用 {fmtSol(p.walletSol)} SOL · {h.wallets.length} 个钱包
      </div>
      {open && (
        <div style={{ marginTop: 6 }}>
          <PositionsList p={p} empty="这些钱包还没有质押。" />
        </div>
      )}
    </div>
  );
}

function HoldersCard() {
  const role = useStore((s) => s.access?.role ?? 'public');
  const enabled = role === 'admin' || role === 'holder';
  const { list, error } = useHolderStaking(enabled);
  const [open, setOpen] = useState<string | null>(null);
  if (!enabled) return null;
  if (role === 'holder') {
    const me = list?.[0];
    return (
      <Card kicker="My Staking" title="我的质押">
        {error && <div className="error">{error}</div>}
        {!list && !error && <div className="muted" style={{ fontSize: 12.5 }}>正在查询链上质押…</div>}
        {list && !me && <div className="muted" style={{ fontSize: 12.5 }}>你还没有登记收款钱包。请管理员在「股东」页把你的钱包加上，这里就会自动显示你的质押。</div>}
        {me && (
          <>
            <PositionsSummary p={me.positions} />
            <div style={{ marginTop: 10 }}>
              <PositionsList p={me.positions} empty="你登记的钱包还没有质押。可以在下面连接钱包质押。" />
            </div>
          </>
        )}
        <p className="card__note">按你在股东名册里登记的钱包，自动查询链上的质押账户和流动性质押代币。</p>
      </Card>
    );
  }
  const totals = (list ?? []).reduce((s, h) => s + h.positions.stakedSol, 0);
  return (
    <Card kicker="Shareholder Staking" title="股东个人质押" right={list ? <span className="chip">{fmtSol(totals)} SOL</span> : undefined}>
      {error && <div className="error">{error}</div>}
      {!list && !error && <div className="muted" style={{ fontSize: 12.5 }}>正在查询各位股东钱包的链上质押…</div>}
      {list && !list.length && <div className="muted" style={{ fontSize: 12.5 }}>股东名册里还没有人登记收款钱包。</div>}
      {list?.map((h) => (
        <HolderBlock key={h.sid} h={h} open={open === h.sid} onToggle={() => setOpen(open === h.sid ? null : h.sid)} />
      ))}
      <p className="card__note">只有管理员能看到全部股东；股东登录后只看到自己的。数据按股东名册里登记的钱包从链上查询。</p>
    </Card>
  );
}

function LookupCard() {
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<StakePositions | null>(null);
  const go = async () => {
    setErr('');
    setBusy(true);
    try {
      setRes(await lookupStake(addr));
    } catch (e) {
      setRes(null);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card kicker="Lookup" title="查询钱包的质押">
      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (addr.trim()) void go();
        }}
      >
        <input className="input" value={addr} onChange={(e) => setAddr(e.target.value.trim())} placeholder="粘贴任意 Solana 钱包地址" autoComplete="off" autoCapitalize="off" spellCheck={false} style={{ fontFamily: 'var(--font-code)', fontSize: 13 }} aria-label="钱包地址" />
        <button type="submit" className="btn btn--solid" style={{ height: 40 }} disabled={!addr || busy}>
          <Search size={14} /> {busy ? '查询中' : '查询'}
        </button>
      </form>
      {err && <div className="error">{err}</div>}
      {res && (
        <div style={{ marginTop: 12 }}>
          <PositionsSummary p={res} />
          <div className="muted" style={{ fontSize: 12, margin: '8px 0 2px' }}>
            钱包可用 {fmtSol(res.walletSol)} SOL · {res.accounts.length} 个质押账户{res.lst.length ? ` · ${res.lst.length} 种流动性质押代币` : ''}
          </div>
          <PositionsList p={res} empty="这个钱包没有质押。" />
        </div>
      )}
      <p className="card__note">只读查询：链上的质押信息本来就是公开的，查询不需要也不会获得任何权限。</p>
    </Card>
  );
}

const PERIODS = [
  { days: 30, label: '1 个月' },
  { days: 365, label: '1 年' },
  { days: 365 * 3, label: '3 年' },
];

function Calculator({ v }: { v: StakingView }) {
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const [amount, setAmount] = useState('10');
  const [apy, setApy] = useState(() => fmtNum(v.networkApy, 2));
  const n = Math.max(0, Number(amount) || 0);
  const a = Math.max(0, Math.min(50, Number(apy) || 0));
  return (
    <Card kicker="Calculator" title="个人质押计算器">
      <div className="grid-form">
        <div className="field">
          <label htmlFor="calc-sol">质押多少 SOL</label>
          <input id="calc-sol" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="calc-apy">年化 %（全网平均 {fmtNum(v.networkApy, 2)}）</label>
          <input id="calc-apy" inputMode="decimal" value={apy} onChange={(e) => setApy(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>
      </div>
      <div className="share-table">
        <div className="share-table__head">
          <span>时间</span>
          <span>收益</span>
          <span>{CUR_SYMBOL[primary] || primary}</span>
          <span>到时共有</span>
        </div>
        {PERIODS.map((p) => {
          const e = projectedEarnings(n, a, p.days, v.epoch.epochSec);
          return (
            <div key={p.days} className="share-table__row">
              <span>{p.label}</span>
              <span className="mono up">+{fmtSol(e)}</span>
              <span className="mono">
                {fmtMoney(e * solTo[primary], primary)}
                <em>{fmtMoney(e * solTo[secondary], secondary)}</em>
              </span>
              <span className="mono">{fmtSol(n + e)}</span>
            </div>
          );
        })}
      </div>
      <p className="card__note">每期（约 {fmtDuration(v.epoch.epochSec)}）收益自动复投；按现在的 SOL 价格折算，实际年化会随全网质押量和验证者表现小幅变化。最少质押 1 SOL。</p>
    </Card>
  );
}

function PersonalTab({ v }: { v: StakingView }) {
  return (
    <>
      <HoldersCard />
      <LookupCard />
      <Calculator v={v} />
      <StakeTool title="用自己的钱包质押" validators={v.validators} epochSec={v.epoch.epochSec} endsInSec={v.epoch.endsInSec} />
    </>
  );
}

// ─── 页面 ─────────────────────────────────────────────────────

export function StakingPage() {
  const snap = useStore((s) => s.snap);
  const prefs = usePrefs();
  const { view, reload } = useStaking();
  const role = useStore((s) => s.access?.role ?? 'public');
  const tab = prefs.stakeTab;
  useEffect(() => {
    if (role === 'member') setPrefs({ stakeTab: 'internal' });
  }, [role]);
  useEffect(() => {
    if (location.hash.includes('personal') && tab !== 'personal') setPrefs({ stakeTab: 'personal' });
    if (location.hash.includes('internal') && tab !== 'internal') setPrefs({ stakeTab: 'internal' });
  }, [tab]);
  if (!snap || !view) return <Loading />;
  return (
    <>
      <div className="stake-tabs">
        <Seg<'company' | 'personal' | 'internal'>
          label="质押类别"
          value={tab}
          onChange={(x) => setPrefs({ stakeTab: x })}
          options={[
            { value: 'company', label: '公司质押' },
            { value: 'personal', label: '个人质押' },
            { value: 'internal', label: '内部质押' },
          ]}
        />
      </div>
      {tab !== 'internal' && <EpochCard e={view.epoch} />}
      {tab === 'company' ? <CompanyTab v={view} reload={reload} /> : tab === 'personal' ? <PersonalTab v={view} /> : <InternalTab />}
      <p className="muted" style={{ textAlign: 'center', fontSize: 11, margin: '4px 0 0' }}>
        验证者数据来自 Stakewiz，质押数据直接来自 Solana 主网
      </p>
    </>
  );
}
