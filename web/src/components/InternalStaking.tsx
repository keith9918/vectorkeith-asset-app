import { Building2, HandCoins, KeyRound, Pencil, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import type { InternalAccount, InternalProgram, InternalRecord, InternalView, LedgerType, PreparedTransfer } from '../../../shared/types';
import { solscan } from '../lib/api';
import { fmtDate, fmtMoney, fmtNum, fmtPct, fmtShortDate, fmtSol, shortAddr } from '../lib/format';
import { useNow, useSolTo } from '../lib/hooks';
import { internalAdmin, internalSent, LEDGER_LABEL, prepareInternal, requestRedeem, useInternal } from '../lib/internal';
import { fmtCode } from '../lib/shareholders';
import { loginWithCode, useStore } from '../lib/store';
import { base64ToBytes, isUserRejection, signAndSend } from '../lib/wallet';
import { useCur } from './Shell';
import { Address, Card, copyText, Seg, toast } from './ui';
import { useWalletSession, WalletBar } from './WalletConnect';

const pad = (n: number) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function Money({ sol }: { sol: number }) {
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  return (
    <span className="muted" style={{ fontSize: 11.5 }}>
      {fmtMoney(sol * solTo[primary], primary)} · {fmtMoney(sol * solTo[secondary], secondary)}
    </span>
  );
}

function Facts({ p }: { p: InternalProgram }) {
  return (
    <div className="sim-chips" style={{ marginTop: 0 }}>
      <span className="chip chip--accent">年化 {fmtNum(p.apr, 2)}%</span>
      <span className="chip">最低 {p.minDeposit} SOL</span>
      <span className="chip">每笔锁定 {p.lockDays} 天</span>
      {p.payoutNote && <span className="chip">{p.payoutNote}</span>}
    </div>
  );
}

function RecordRow({ r, admin, members, onChanged }: { r: InternalRecord; admin?: boolean; members?: InternalAccount[]; onChanged?: () => void }) {
  const { primary } = useCur();
  const usdCny = useStore((s) => s.snap?.solPrice.usdCny ?? 7.1);
  const [busy, setBusy] = useState(false);
  const up = r.type !== 'withdraw';
  const act = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      await internalAdmin(body);
      toast(ok);
      onChanged?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sub = [
    r.source === 'chain' ? fmtShortDate(r.ts * 1000) : fmtDate(r.ts * 1000, false),
    r.source === 'chain' ? `链上 · ${r.from === 'company' ? '公司钱包' : '内部质押钱包'}${r.type === 'deposit' ? ' ← ' : ' → '}${shortAddr(r.addr)}` : `线下${r.currency && r.currency !== 'sol' && r.amount ? ` ${fmtMoney(r.amount, r.currency)}` : ''}`,
    r.note,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`payout ${r.ignored ? 'payout--ex' : ''}`}>
      <span className={`flow-row__icon ${r.type === 'withdraw' ? 'down' : 'up'}`}>{r.type === 'interest' ? <HandCoins size={15} /> : r.type === 'deposit' ? <Plus size={15} /> : <Building2 size={15} />}</span>
      <span className="flow-row__main">
        <span className="flow-row__title">
          {admin && r.name ? `${r.name} · ` : ''}
          {LEDGER_LABEL[r.type]}
          {r.ignored && <span className="chip chip--warn" style={{ height: 18, fontSize: 10, padding: '0 5px' }}>不计入</span>}
          {admin && r.source === 'chain' && !r.auto && !r.ignored && <span className="chip" style={{ height: 18, fontSize: 10, padding: '0 5px' }}>已手动归类</span>}
        </span>
        <span className="flow-row__sub">{sub}</span>
      </span>
      <span className="flow-row__amt">
        <span className={r.ignored ? 'muted' : up ? 'up' : 'down'}>
          {r.type === 'withdraw' ? '−' : '+'}
          {fmtSol(r.sol)} SOL
        </span>
        <span className="muted">{fmtMoney(primary === 'usd' ? r.usd : r.usd * usdCny, primary)}</span>
      </span>
      {(r.sig || admin) && (
        <span className="payout__actions">
          {r.sig && (
            <a className="chip" href={solscan.tx(r.sig)} target="_blank" rel="noreferrer">
              详情
            </a>
          )}
          {admin && r.source === 'chain' && (
            <select
              className="chip"
              aria-label="归类"
              disabled={busy}
              value={r.ignored ? 'ignore' : r.auto ? 'auto' : r.type}
              onChange={(e) => void act({ action: 'override', id: r.id, type: e.target.value, mid: r.mid }, '已改归类')}
            >
              <option value="auto">自动（{LEDGER_LABEL[r.type]}）</option>
              <option value="deposit">充值</option>
              <option value="withdraw">赎回</option>
              <option value="interest">分息</option>
              <option value="ignore">不计入</option>
            </select>
          )}
          {admin && !r.mid && members?.length ? (
            <select className="chip" aria-label="认领给员工" disabled={busy} value="" onChange={(e) => e.target.value && void act({ action: 'override', id: r.id, type: 'deposit', mid: e.target.value }, '已认领')}>
              <option value="">认领给…</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : null}
          {admin && r.source === 'manual' && (
            <button type="button" className="chip" disabled={busy} onClick={() => confirm('删除这条线下记录？') && void act({ action: 'remove-manual', id: r.id }, '已删除')}>
              <Trash2 size={11} /> 删除
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function RecordList({ list, admin, members, onChanged, empty }: { list: InternalRecord[]; admin?: boolean; members?: InternalAccount[]; onChanged?: () => void; empty: string }) {
  const [all, setAll] = useState(false);
  if (!list.length) return <div className="muted" style={{ fontSize: 12.5, padding: '6px 0' }}>{empty}</div>;
  return (
    <>
      <div className="flows">
        {(all ? list : list.slice(0, 10)).map((r) => (
          <RecordRow key={r.id} r={r} admin={admin} members={members} onChanged={onChanged} />
        ))}
      </div>
      {list.length > 10 && (
        <button type="button" className="btn btn--ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setAll(!all)}>
          {all ? '收起' : `显示全部 ${list.length} 笔`}
        </button>
      )}
    </>
  );
}

// ─── 未登录 / 访客 / 股东：介绍 + 员工登录 ────────────────────

function Intro({ v }: { v: InternalView }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const info = await loginWithCode(code);
      toast(info.role === 'member' ? `欢迎，${info.name}` : '已登录');
      setCode('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="hero-card" kicker="Internal Staking" title={v.program.name} right={<span className={`chip ${v.program.enabled ? 'chip--accent' : ''}`}>{v.program.enabled ? '开放中' : '未开放'}</span>}>
      <div className="glow-orb" />
      <p style={{ margin: '0 0 10px', fontSize: 13.5, color: 'var(--text-2)' }}>员工把 SOL 充进公司内部质押，按年化每天计算分息，公司定期发放；锁定期过后可以申请赎回本金。</p>
      <Facts p={v.program} />
      <div className="wm__title" style={{ marginTop: 14 }}>
        员工登录
      </div>
      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) void submit();
        }}
      >
        <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="员工登录码，例如 ABCD-EFGH" autoCapitalize="characters" autoComplete="off" spellCheck={false} aria-label="员工登录码" />
        <button type="submit" className="btn btn--solid" style={{ height: 40 }} disabled={!code.trim() || busy}>
          登录
        </button>
      </form>
      {err && <div className="error">{err}</div>}
      <p className="card__note">登录码由公司管理员发放。登录后可以充值、查看自己的本金和分息、申请赎回，看不到其他员工。</p>
    </Card>
  );
}

// ─── 员工：我的内部质押 ───────────────────────────────────────

function MemberView({ v, at }: { v: InternalView; at: number }) {
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const now = useNow(1000);
  const me = v.me;
  const s = useWalletSession();
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<{ kind: 'idle' | 'working' | 'error' | 'sent'; text?: string; sig?: string }>({ kind: 'idle' });
  const [redeem, setRedeem] = useState('');
  const [note, setNote] = useState('');
  const [rbusy, setRbusy] = useState(false);
  if (!me) return <Card title="内部质押">没有找到你的账户，请联系管理员。</Card>;
  const p = v.program;
  const tick = me.principal > 0 ? (me.daily * Math.max(0, now - at)) / 86400_000 : 0;
  // 小数位数按每秒增长量来定，保证数字真的每秒都在变
  const perSec = me.daily / 86400;
  const dec = perSec > 0 ? Math.min(12, Math.max(6, Math.ceil(-Math.log10(perSec)))) : 8;
  const n = Number(amount);
  const validDeposit = n >= p.minDeposit;
  const registered = !!s.account && me.wallets.includes(s.account.address);
  const canRedeem = Math.max(0, me.available - me.pendingRedeem);

  const deposit = async () => {
    if (!s.wallet || !s.account) return;
    if (!confirm(`从 ${shortAddr(s.account.address)} 充值 ${fmtNum(n, 4)} SOL 到${p.name}？\n按年化 ${p.apr}% 每天计算分息，锁定 ${p.lockDays} 天后可以申请赎回。`)) return;
    try {
      setPhase({ kind: 'working', text: '正在组装交易并在链上模拟…' });
      const prep = await prepareInternal({ action: 'deposit', owner: s.account.address, sol: n });
      setPhase({ kind: 'working', text: `请在 ${s.wallet.name} 里确认：转出 ${fmtNum(n, 4)} SOL 到内部质押钱包` });
      const sig = await signAndSend(s.wallet, s.account, base64ToBytes(prep.transaction));
      setPhase({ kind: 'sent', text: `已提交充值 ${fmtNum(n, 4)} SOL，链上确认后几秒内自动到账`, sig });
      setAmount('');
    } catch (e) {
      setPhase({ kind: 'error', text: isUserRejection(e) ? '你在钱包里取消了，没有转出任何 SOL' : (e as Error).message });
    }
  };

  const submitRedeem = async (cancel?: string) => {
    setRbusy(true);
    try {
      await requestRedeem(cancel ? { cancel } : { sol: Number(redeem), note });
      toast(cancel ? '已撤回申请' : '已提交赎回申请，等待公司处理');
      setRedeem('');
      setNote('');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setRbusy(false);
    }
  };

  return (
    <>
      <Card className="hero-card" kicker="My Internal Staking" title={`${me.name} 的${p.name}`} right={<span className="chip chip--accent">年化 {fmtNum(p.apr, 2)}%</span>}>
        <div className="glow-orb" />
        <div className="muted" style={{ fontSize: 12.5 }}>
          本金
        </div>
        <div className="hero-value">
          {fmtSol(me.principal)}
          <small style={{ fontSize: 18, marginLeft: 6 }}>SOL</small>
        </div>
        <div className="hero-sub">
          <span>
            <b>{fmtMoney(me.principal * solTo[primary], primary)}</b>
          </span>
          <span>
            <b>{fmtMoney(me.principal * solTo[secondary], secondary)}</b>
          </span>
        </div>
        <div className="tick">
          <span className="muted">累计分息</span>
          <b className="up mono">+{fmtNum(me.accrued + tick, dec)} SOL</b>
          {me.principal > 0 && <span className="muted">每秒 +{perSec.toExponential(1).replace('e-', '×10⁻').replace(/(d+)$/, (d) => [...d].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c]).join(''))} SOL</span>}
        </div>
        <div className="rows" style={{ marginTop: 6 }}>
          <div className="row">
            <span className="row__k">每天分息</span>
            <span className="row__v mono">
              +{fmtSol(me.daily)} SOL <Money sol={me.daily} />
            </span>
          </div>
          <div className="row">
            <span className="row__k">已发 / 待发分息</span>
            <span className="row__v mono">
              {fmtSol(me.paid)} / <b>{fmtSol(me.unpaid + tick)}</b> SOL
            </span>
          </div>
          <div className="row">
            <span className="row__k">锁定中 / 可赎回</span>
            <span className="row__v mono">
              {fmtSol(me.locked)} / {fmtSol(me.available)} SOL
              {me.nextUnlock && <div className="muted" style={{ fontSize: 11 }}>{fmtDate(me.nextUnlock * 1000, false)} 解锁下一笔</div>}
            </span>
          </div>
        </div>
        <p className="card__note">{p.payoutNote ? `${p.payoutNote}。` : ''}分息 = 本金 × 年化 × 天数 ÷ 365，从充值到账的那一刻开始计算。</p>
      </Card>

      <Card kicker="Deposit" title="充值">
        {!p.enabled || !p.poolWallet ? (
          <div className="muted" style={{ fontSize: 12.5 }}>暂未开放充值。</div>
        ) : (
          <>
            <div className="rows">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <span className="row__k">充值地址</span>
                <span className="row__v">
                  <Address address={p.poolWallet} />
                </span>
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <span className="row__k">你登记的钱包</span>
                <span className="row__v" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                  {me.wallets.length ? me.wallets.map((w) => <Address key={w} address={w} />) : <span className="muted">还没有登记（请联系管理员）</span>}
                </span>
              </div>
            </div>
            <p className="card__note" style={{ marginTop: 4 }}>
              要用<b>你登记的钱包</b>转账，系统才能自动记到你名下；也可以直接在钱包里往上面的地址转 SOL（最少 {p.minDeposit} SOL）。
            </p>
            <div className="wm__title" style={{ marginTop: 12 }}>
              连接钱包充值
            </div>
            <WalletBar s={s} busy={phase.kind === 'working'} tag={registered ? '已登记' : undefined} />
            {s.account && !registered && <div className="addr-preview addr-preview--warn" style={{ marginTop: 8 }}>这个钱包没有登记在你名下，用它充值无法自动记账。请换成登记的钱包，或请管理员先登记。</div>}
            {s.account && registered && (
              <>
                <div className="field" style={{ margin: '10px 0 8px' }}>
                  <label htmlFor="dep-amount">充值多少 SOL（最少 {p.minDeposit}）</label>
                  <input id="dep-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="输入 SOL 数量" />
                </div>
                {validDeposit && (
                  <div className="addr-preview addr-preview--ok">
                    充值后本金 {fmtSol(me.principal + n)} SOL，每天分息约 +{fmtSol(((me.principal + n) * p.apr) / 100 / 365)} SOL，每年约 +{fmtSol(((me.principal + n) * p.apr) / 100)} SOL（{fmtMoney((((me.principal + n) * p.apr) / 100) * solTo[primary], primary)}）。这笔锁定 {p.lockDays} 天。
                  </div>
                )}
                <button type="button" className="btn btn--solid" style={{ width: '100%', marginTop: 10 }} disabled={!validDeposit || phase.kind === 'working'} onClick={deposit}>
                  用 {s.wallet?.name} 签名充值
                </button>
              </>
            )}
            {phase.kind === 'working' && <div className="addr-preview addr-preview--info" style={{ marginTop: 10 }}>{phase.text}</div>}
            {phase.kind === 'error' && <div className="error">{phase.text}</div>}
            {phase.kind === 'sent' && (
              <div className="addr-preview addr-preview--ok" style={{ marginTop: 10 }}>
                ✓ {phase.text}
                <a href={solscan.tx(phase.sig!)} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>
                  查看 ›
                </a>
              </div>
            )}
          </>
        )}
      </Card>

      <Card kicker="Redeem" title="申请赎回本金" right={<span className="chip">可申请 {fmtSol(canRedeem)} SOL</span>}>
        <div className="grid-form">
          <div className="field">
            <label htmlFor="red-amount">赎回多少 SOL</label>
            <input id="red-amount" inputMode="decimal" value={redeem} onChange={(e) => setRedeem(e.target.value.replace(/[^\d.]/g, ''))} placeholder={`最多 ${fmtNum(canRedeem, 4)}`} />
          </div>
          <div className="field">
            <label htmlFor="red-note">备注（可不填）</label>
            <input id="red-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} />
          </div>
        </div>
        <button type="button" className="btn btn--solid" style={{ width: '100%' }} disabled={rbusy || !(Number(redeem) > 0) || Number(redeem) > canRedeem + 1e-9} onClick={() => void submitRedeem()}>
          提交赎回申请
        </button>
        {me.requests.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {me.requests.slice(0, 6).map((r) => (
              <div key={r.id} className="row">
                <span className="row__k">
                  {fmtShortDate(r.ts * 1000)} · {fmtSol(r.sol)} SOL{r.note ? ` · ${r.note}` : ''}
                </span>
                <span className="row__v">
                  {r.status === 'pending' ? (
                    <>
                      <span className="chip chip--warn">处理中</span>{' '}
                      <button type="button" className="chip" disabled={rbusy} onClick={() => void submitRedeem(r.id)}>
                        撤回
                      </button>
                    </>
                  ) : (
                    <span className="chip">{r.status === 'done' ? '已处理' : '已取消'}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="card__note">锁定期（每笔 {p.lockDays} 天）过后的本金可以申请赎回。公司处理后把 SOL 转回你登记的钱包，到账时会自动记账并通知你。</p>
      </Card>

      <Card kicker="Records" title="我的记录" right={<span className="chip">{me.records.length} 笔</span>}>
        <RecordList list={me.records} empty="还没有记录。" />
      </Card>
    </>
  );
}

// ─── 管理员 ───────────────────────────────────────────────────

function ProgramCard({ v, onChanged }: { v: InternalView; onChanged: () => void }) {
  const p = v.program;
  const [editing, setEditing] = useState(!p.poolWallet);
  const [f, setF] = useState({ name: p.name, poolWallet: p.poolWallet ?? '', apr: String(p.apr), minDeposit: String(p.minDeposit), lockDays: String(p.lockDays), payoutNote: p.payoutNote });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (body: Record<string, unknown>, ok: string) => {
    setErr('');
    setBusy(true);
    try {
      await internalAdmin({ action: 'config', ...body });
      toast(ok);
      onChanged();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (Number(f.apr) !== p.apr && p.poolWallet && !confirm(`年化从 ${p.apr}% 改成 ${f.apr}%？\n从现在起按新年化计算，之前已经产生的分息不变。`)) return;
    if (await run({ name: f.name, poolWallet: f.poolWallet, apr: Number(f.apr), minDeposit: Number(f.minDeposit), lockDays: Number(f.lockDays), payoutNote: f.payoutNote }, '已保存')) setEditing(false);
  };
  return (
    <Card
      className="hero-card"
      kicker="Internal Staking · Admin"
      title={p.name}
      right={
        p.poolWallet ? (
          <Seg<'on' | 'off'>
            label="开放充值"
            value={p.enabled ? 'on' : 'off'}
            onChange={(x) => !busy && void run({ enabled: x === 'on' }, x === 'on' ? '已开放充值' : '已暂停充值')}
            options={[
              { value: 'on', label: '开放' },
              { value: 'off', label: '暂停' },
            ]}
          />
        ) : (
          <span className="chip chip--warn">待设置</span>
        )
      }
    >
      <div className="glow-orb" />
      {!editing ? (
        <>
          <Facts p={p} />
          <div className="rows" style={{ marginTop: 8 }}>
            <div className="row">
              <span className="row__k">内部质押钱包</span>
              <span className="row__v">{p.poolWallet ? <Address address={p.poolWallet} /> : '—'}</span>
            </div>
            {p.rates && p.rates.length > 1 && (
              <div className="row">
                <span className="row__k">年化调整记录</span>
                <span className="row__v mono" style={{ fontSize: 11.5 }}>
                  {p.rates
                    .filter((r) => r.from > 0)
                    .slice(-3)
                    .map((r) => `${fmtDate(r.from * 1000, false)} → ${r.apr}%`)
                    .join('，')}
                </span>
              </div>
            )}
          </div>
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setEditing(true)}>
            <Pencil size={13} /> 修改设置
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="field">
            <label htmlFor="ip-pool">内部质押钱包（员工充值的收款地址，必须是单独的钱包，不能用公司钱包）</label>
            <input id="ip-pool" value={f.poolWallet} onChange={(e) => setF({ ...f, poolWallet: e.target.value.trim() })} placeholder="粘贴一个新钱包地址" spellCheck={false} autoCapitalize="off" style={{ fontFamily: 'var(--font-code)', fontSize: 12.5 }} />
          </div>
          <div className="grid-form">
            <div className="field">
              <label htmlFor="ip-name">名称</label>
              <input id="ip-name" value={f.name} maxLength={24} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ip-apr">年化分息 %</label>
              <input id="ip-apr" inputMode="decimal" value={f.apr} onChange={(e) => setF({ ...f, apr: e.target.value.replace(/[^\d.]/g, '') })} />
            </div>
            <div className="field">
              <label htmlFor="ip-min">最低充值（SOL）</label>
              <input id="ip-min" inputMode="decimal" value={f.minDeposit} onChange={(e) => setF({ ...f, minDeposit: e.target.value.replace(/[^\d.]/g, '') })} />
            </div>
            <div className="field">
              <label htmlFor="ip-lock">每笔锁定天数</label>
              <input id="ip-lock" inputMode="numeric" value={f.lockDays} onChange={(e) => setF({ ...f, lockDays: e.target.value.replace(/\D/g, '') })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="ip-note">发放规则（显示给员工）</label>
            <input id="ip-note" value={f.payoutNote} maxLength={60} onChange={(e) => setF({ ...f, payoutNote: e.target.value })} />
          </div>
          {err && <div className="error">{err}</div>}
          <div className="wm__actions">
            {p.poolWallet && (
              <button type="button" className="btn btn--ghost" onClick={() => setEditing(false)}>
                取消
              </button>
            )}
            <button type="submit" className="btn btn--solid" disabled={busy || !f.poolWallet}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      )}
      <p className="card__note">员工充值的 SOL 是公司欠员工的钱：进单独的内部质押钱包、单独记账，不计入公司资产，也不影响股东分红。年化调整只影响调整之后的分息。</p>
    </Card>
  );
}

function TotalsCard({ v }: { v: InternalView }) {
  const t = v.totals!;
  const pool = t.poolWalletSol + t.poolStakedSol;
  const cov = t.coverage;
  return (
    <Card kicker="Overview" title="资金总览" right={<span className="chip">{t.members} 位员工</span>}>
      <div className="stat3">
        <div>
          <span>员工本金合计</span>
          <b>{fmtSol(t.principal)} SOL</b>
          <em>
            <Money sol={t.principal} />
          </em>
        </div>
        <div>
          <span>待发分息</span>
          <b className="up">{fmtSol(t.unpaid)}</b>
          <em>已发 {fmtSol(t.paid)}</em>
        </div>
        <div>
          <span>每天新增分息</span>
          <b>+{fmtSol(t.daily)}</b>
          <em>
            <Money sol={t.daily} />
          </em>
        </div>
      </div>
      <div className="rows" style={{ marginTop: 10 }}>
        <div className="row">
          <span className="row__k">资金池（内部质押钱包）</span>
          <span className="row__v mono">
            {fmtSol(pool)} SOL
            <div className="muted" style={{ fontSize: 11 }}>
              钱包 {fmtSol(t.poolWalletSol)}
              {t.poolStakedSol > 0 ? ` + 质押 ${fmtSol(t.poolStakedSol)}` : ''}
            </div>
          </span>
        </div>
        <div className="row">
          <span className="row__k">覆盖率（资金池 ÷ 应付本金和分息）</span>
          <span className={`row__v mono ${cov === null ? '' : cov >= 1 ? 'up' : 'down'}`}>{cov === null ? '—' : fmtPct(cov, 0)}</span>
        </div>
      </div>
      {cov !== null && cov < 1 && <div className="banner" style={{ marginTop: 8 }}>资金池不够支付全部本金和分息（差 {fmtSol(t.principal + t.unpaid - pool)} SOL）。分息由公司钱包发放时不受影响，但员工同时赎回时需要补足。</div>}
      <p className="card__note">资金池里的 SOL 也可以拿去质押赚收益（在「个人质押」里连接内部质押钱包操作），质押中的部分同样算进资金池。</p>
    </Card>
  );
}

function MemberForm({ m, onDone }: { m?: InternalAccount; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState(m?.name ?? '');
  const [wallets, setWallets] = useState(m?.wallets.join('\n') ?? '');
  const [note, setNote] = useState(m?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <form
      className="sub-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr('');
        setBusy(true);
        try {
          await internalAdmin({ action: m ? 'update-member' : 'add-member', id: m?.id, name, wallets: wallets.split(/[\s,，;；]+/).filter(Boolean), note });
          toast(m ? '已保存' : `已添加 ${name}，登录码已生成`);
          onDone(true);
        } catch (er) {
          setErr((er as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="wm__title">{m ? `编辑 ${m.name}` : '添加员工'}</div>
      <div className="field">
        <label htmlFor="mf-name">名字</label>
        <input id="mf-name" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder="例如 王小明" />
      </div>
      <div className="field">
        <label htmlFor="mf-w">员工的钱包（充值从这里转出、分息和赎回转到这里；最多 3 个，每行一个）</label>
        <textarea id="mf-w" rows={2} value={wallets} onChange={(e) => setWallets(e.target.value)} spellCheck={false} autoCapitalize="off" placeholder="粘贴 Solana 钱包地址" />
      </div>
      <div className="field">
        <label htmlFor="mf-note">备注（只有管理员能看到）</label>
        <input id="mf-note" value={note} maxLength={60} onChange={(e) => setNote(e.target.value)} />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="wm__actions">
        <button type="button" className="btn btn--ghost" onClick={() => onDone(false)}>
          取消
        </button>
        <button type="submit" className="btn btn--solid" disabled={busy || !name.trim()}>
          {busy ? '保存中…' : m ? '保存' : '添加'}
        </button>
      </div>
    </form>
  );
}

function ManualForm({ m, onDone }: { m: InternalAccount; onDone: (saved: boolean) => void }) {
  const [type, setType] = useState<LedgerType>('deposit');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<'cny' | 'usd' | 'sol'>('sol');
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <form
      className="sub-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr('');
        setBusy(true);
        try {
          const ts = date === todayStr() ? Math.floor(Date.now() / 1000) : Math.floor(new Date(`${date}T12:00:00`).getTime() / 1000);
          await internalAdmin({ action: 'manual', mid: m.id, type, amount: Number(amount), currency, ts, note });
          toast(`已记录：${m.name} ${LEDGER_LABEL[type]} ${fmtMoney(Number(amount), currency)}`);
          onDone(true);
        } catch (er) {
          setErr((er as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="wm__title">给 {m.name} 补记一笔线下记录</div>
      <div className="field">
        <label>类型</label>
        <Seg<LedgerType>
          label="类型"
          value={type}
          onChange={setType}
          options={[
            { value: 'deposit', label: '充值' },
            { value: 'withdraw', label: '赎回' },
            { value: 'interest', label: '分息' },
          ]}
        />
      </div>
      <div className="grid-form">
        <div className="field">
          <label htmlFor="mm-amount">金额</label>
          <input id="mm-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="mm-date">日期</label>
          <input id="mm-date" type="date" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>币种（人民币 / 美元按当天的 SOL 价格折算成 SOL 记账）</label>
        <Seg<'cny' | 'usd' | 'sol'>
          label="币种"
          value={currency}
          onChange={setCurrency}
          options={[
            { value: 'sol', label: 'SOL' },
            { value: 'cny', label: '人民币 ¥' },
            { value: 'usd', label: '美元 $' },
          ]}
        />
      </div>
      <div className="field">
        <label htmlFor="mm-note">备注</label>
        <input id="mm-note" value={note} maxLength={60} onChange={(e) => setNote(e.target.value)} placeholder="例如 现金 / 银行转账" />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="wm__actions">
        <button type="button" className="btn btn--ghost" onClick={() => onDone(false)}>
          取消
        </button>
        <button type="submit" className="btn btn--solid" disabled={busy || !(Number(amount) > 0)}>
          记录
        </button>
      </div>
    </form>
  );
}

function MemberItem({ m, onChanged }: { m: InternalAccount; onChanged: () => void }) {
  const [mode, setMode] = useState<'' | 'edit' | 'manual' | 'records'>('');
  const [busy, setBusy] = useState(false);
  const run = async (body: Record<string, unknown>, ok: string, ask: string) => {
    if (!confirm(ask)) return;
    setBusy(true);
    try {
      await internalAdmin(body);
      toast(ok);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="holder">
      <div className="holder__top">
        <div className="holder__name">
          <UserRound size={15} />
          {m.name}
          {m.pendingRedeem > 0 && <span className="chip chip--warn">申请赎回 {fmtSol(m.pendingRedeem)}</span>}
        </div>
        <div className="holder__due">
          {fmtSol(m.principal)} SOL
          <div className="muted">待发分息 {fmtSol(m.unpaid)}</div>
        </div>
      </div>
      <div className="holder__meta">
        累计分息 {fmtSol(m.accrued)} · 已发 {fmtSol(m.paid)} · 可赎回 {fmtSol(m.available)}
        {m.locked > 0 ? ` · 锁定 ${fmtSol(m.locked)}` : ''}
      </div>
      <div className="holder__wallets">{m.wallets.length ? m.wallets.map((w) => <Address key={w} address={w} />) : <span className="muted">未登记钱包（只能线下记录）</span>}</div>
      <div className="holder__code">
        <KeyRound size={13} /> 登录码 <b className="mono">{fmtCode(m.code)}</b>
        <button type="button" className="chip" onClick={() => copyText(`VectorKeith 内部质押登录码：${fmtCode(m.code)}\n打开 ${location.origin} ，在「质押 → 内部质押」输入登录码即可充值和查看分息。`, '登录码已复制，可以直接发给员工')}>
          复制发给员工
        </button>
        <button type="button" className="chip" disabled={busy} onClick={() => void run({ action: 'regen', id: m.id }, '已生成新的登录码', `给 ${m.name} 重新生成登录码？旧的立即失效。`)}>
          <RefreshCw size={11} /> 重新生成
        </button>
      </div>
      {m.note && <div className="holder__meta muted">备注：{m.note}</div>}
      {mode === '' && (
        <div className="wm__actions">
          <button type="button" className="btn" onClick={() => setMode('records')}>
            记录 {m.records.length}
          </button>
          <button type="button" className="btn" onClick={() => setMode('manual')}>
            <Plus size={13} /> 线下记录
          </button>
          <button type="button" className="btn" onClick={() => setMode('edit')}>
            <Pencil size={13} />
          </button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void run({ action: 'remove-member', id: m.id }, `已删除 ${m.name}`, `删除员工 ${m.name}？（本金和待发分息必须先结清）`)}>
            <Trash2 size={13} />
          </button>
        </div>
      )}
      {mode === 'records' && (
        <div className="sub-form">
          <RecordList list={m.records} admin onChanged={onChanged} empty="还没有记录。" />
          <button type="button" className="btn btn--ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setMode('')}>
            收起
          </button>
        </div>
      )}
      {mode === 'edit' && <MemberForm m={m} onDone={(s) => (setMode(''), s && onChanged())} />}
      {mode === 'manual' && <ManualForm m={m} onDone={(s) => (setMode(''), s && onChanged())} />}
    </div>
  );
}

function PayoutCard({ v, onChanged }: { v: InternalView; onChanged: () => void }) {
  const members = (v.members ?? []).filter((m) => m.wallets.length);
  const s = useWalletSession();
  const companyWallets = useStore((st) => st.snap?.treasury.wallets);
  const [type, setType] = useState<'interest' | 'withdraw'>('interest');
  const [sel, setSel] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<{ kind: 'idle' | 'working' | 'error' | 'sent'; text?: string; sig?: string }>({ kind: 'idle' });
  const defaults = (t: 'interest' | 'withdraw') => Object.fromEntries(members.map((m) => [m.id, String(+(t === 'interest' ? m.unpaid : m.pendingRedeem).toFixed(6))]).filter(([, a]) => Number(a) > 0));
  const pick = Object.keys(sel).length ? sel : defaults(type);
  const items = Object.entries(pick)
    .map(([mid, a]) => ({ mid, sol: Number(a) }))
    .filter((x) => x.sol > 0);
  const total = items.reduce((t, x) => t + x.sol, 0);
  const isCompany = !!s.account && !!companyWallets?.some((w) => w.address === s.account!.address);
  const isPool = !!s.account && s.account.address === v.program.poolWallet;

  const go = async () => {
    if (!s.wallet || !s.account) return;
    if (!confirm(`从 ${shortAddr(s.account.address)} 发放${LEDGER_LABEL[type]}给 ${items.length} 位员工，共 ${fmtNum(total, 6)} SOL？`)) return;
    try {
      setPhase({ kind: 'working', text: '正在组装交易并在链上模拟…' });
      const prep: PreparedTransfer = await prepareInternal({ action: 'payout', owner: s.account.address, items: items.map((x) => ({ ...x, type })) });
      setPhase({ kind: 'working', text: `请在 ${s.wallet.name} 里确认：转给 ${prep.items.length} 个地址，共 ${fmtNum(total, 6)} SOL` });
      const sig = await signAndSend(s.wallet, s.account, base64ToBytes(prep.transaction));
      await internalSent(sig, prep.items);
      setPhase({ kind: 'sent', text: `已发放${LEDGER_LABEL[type]} ${fmtNum(total, 6)} SOL，到账后自动记到每位员工名下`, sig });
      setSel({});
      onChanged();
    } catch (e) {
      setPhase({ kind: 'error', text: isUserRejection(e) ? '你在钱包里取消了，没有转出任何 SOL' : (e as Error).message });
    }
  };

  return (
    <Card kicker="Payout" title="一键发放" right={<HandCoins size={16} style={{ color: 'var(--accent)' }} />}>
      <Seg<'interest' | 'withdraw'>
        label="发放类型"
        value={type}
        onChange={(t) => {
          setType(t);
          setSel({});
        }}
        options={[
          { value: 'interest', label: '发分息' },
          { value: 'withdraw', label: '处理赎回' },
        ]}
      />
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        {type === 'interest' ? '默认填每人的待发分息，可以改。' : '默认填每人申请赎回的数量，可以改。'}
      </div>
      {members.length ? (
        <div className="pay-list">
          {members.map((m) => {
            const val = pick[m.id] ?? '';
            return (
              <label key={m.id} className="pay-line">
                <input type="checkbox" checked={m.id in pick} onChange={(e) => setSel(() => {
                  const next = { ...pick };
                  if (e.target.checked) next[m.id] = String(+(type === 'interest' ? m.unpaid : m.pendingRedeem || m.available).toFixed(6));
                  else delete next[m.id];
                  return next;
                })} />
                <span className="pay-line__name">
                  {m.name}
                  <em>{type === 'interest' ? `待发 ${fmtSol(m.unpaid)}` : `申请 ${fmtSol(m.pendingRedeem)} · 可赎回 ${fmtSol(m.available)}`}</em>
                </span>
                <input className="pay-line__amt" inputMode="decimal" value={val} disabled={!(m.id in pick)} onChange={(e) => setSel({ ...pick, [m.id]: e.target.value.replace(/[^\d.]/g, '') })} aria-label={`${m.name} 发放数量`} />
                <span className="muted">SOL</span>
              </label>
            );
          })}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>还没有登记了钱包的员工。</div>
      )}
      <div className="row">
        <span className="row__k">合计 {items.length} 人</span>
        <span className="row__v mono">
          <b>{fmtNum(total, 6)} SOL</b> <Money sol={total} />
        </span>
      </div>
      <WalletBar s={s} busy={phase.kind === 'working'} tag={isCompany ? '公司钱包' : isPool ? '内部质押钱包' : undefined} />
      {s.account && (
        <button type="button" className="btn btn--solid" style={{ width: '100%', marginTop: 10 }} disabled={!items.length || items.length > 15 || phase.kind === 'working'} onClick={go}>
          用 {s.wallet?.name} 签名发放 {items.length} 笔
        </button>
      )}
      {items.length > 15 && <div className="error">一次最多 15 人，请分批勾选。</div>}
      {phase.kind === 'working' && <div className="addr-preview addr-preview--info" style={{ marginTop: 10 }}>{phase.text}</div>}
      {phase.kind === 'error' && <div className="error">{phase.text}</div>}
      {phase.kind === 'sent' && (
        <div className="addr-preview addr-preview--ok" style={{ marginTop: 10 }}>
          ✓ {phase.text}
          <a href={solscan.tx(phase.sig!)} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>
            查看 ›
          </a>
        </div>
      )}
      <p className="card__note">一笔交易转给多位员工，在你的钱包里签名一次即可。分息一般用公司钱包发，赎回一般用内部质押钱包发；到账后按这里选的类型自动记账，处理完的赎回申请记得点"已处理"。</p>
    </Card>
  );
}

function AdminView({ v, reload }: { v: InternalView; reload: () => void }) {
  const [adding, setAdding] = useState(false);
  const pending = (v.requests ?? []).filter((r) => r.status === 'pending');
  const act = async (id: string, status: 'done' | 'cancelled') => {
    try {
      await internalAdmin({ action: 'request', id, status });
      toast(status === 'done' ? '已标记处理完成' : '已拒绝');
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <>
      <ProgramCard v={v} onChanged={reload} />
      {v.program.poolWallet && <TotalsCard v={v} />}
      {pending.length > 0 && (
        <Card kicker="Requests" title="待处理的赎回申请" right={<span className="chip chip--warn">{pending.length} 笔</span>}>
          {pending.map((r) => (
            <div key={r.id} className="row" style={{ flexWrap: 'wrap' }}>
              <span className="row__k" style={{ color: 'var(--text-1)' }}>
                {r.name} · <b>{fmtSol(r.sol)} SOL</b>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {fmtShortDate(r.ts * 1000)}
                  {r.note ? ` · ${r.note}` : ''}
                </div>
              </span>
              <span className="row__v">
                <button type="button" className="chip chip--accent" onClick={() => void act(r.id, 'done')}>
                  已处理
                </button>{' '}
                <button type="button" className="chip" onClick={() => confirm('拒绝这笔赎回申请？') && void act(r.id, 'cancelled')}>
                  拒绝
                </button>
              </span>
            </div>
          ))}
          <p className="card__note">在下面"一键发放"选"处理赎回"把 SOL 转给员工，到账后点"已处理"。</p>
        </Card>
      )}
      <Card
        kicker="Members"
        title={`员工（${v.members?.length ?? 0} 位）`}
        right={
          !adding && (
            <button type="button" className="chip chip--accent" onClick={() => setAdding(true)}>
              <Plus size={11} /> 添加员工
            </button>
          )
        }
      >
        {adding && <MemberForm onDone={(s) => (setAdding(false), s && reload())} />}
        {!v.members?.length && !adding && <div className="muted" style={{ fontSize: 12.5 }}>还没有员工。添加后会生成登录码，发给员工即可。</div>}
        {v.members?.map((m) => (
          <MemberItem key={m.id} m={m} onChanged={reload} />
        ))}
      </Card>
      {v.program.poolWallet && <PayoutCard v={v} onChanged={reload} />}
      {(v.unassigned?.length ?? 0) > 0 && (
        <Card kicker="Unassigned" title="未认领的充值" right={<span className="chip chip--warn">{v.unassigned!.length} 笔</span>}>
          <RecordList list={v.unassigned!} admin members={v.members} onChanged={reload} empty="" />
          <p className="card__note">这些 SOL 转进了内部质押钱包，但转出地址不是任何员工登记的钱包。确认是谁的之后"认领给"对应员工；不是员工充值就选"不计入"。</p>
        </Card>
      )}
      <Card kicker="Ledger" title="全部记录" right={<span className="chip">{v.records?.length ?? 0} 笔</span>}>
        <RecordList list={v.records ?? []} admin members={v.members} onChanged={reload} empty="还没有记录。" />
        <p className="card__note">链上记录自动归类：员工钱包转进内部质押钱包 = 充值；内部质押钱包转给员工 = 赎回；公司钱包转给员工 = 分息。归类不对时可以改。</p>
      </Card>
    </>
  );
}

export function InternalTab() {
  const role = useStore((s) => s.access?.role ?? 'public');
  const { view, at, error, reload } = useInternal();
  if (!view) return error ? <div className="banner">{error}</div> : <div className="muted" style={{ textAlign: 'center', padding: 20 }}>加载中…</div>;
  if (role === 'admin') return <AdminView v={view} reload={reload} />;
  if (role === 'member') return <MemberView v={view} at={at} />;
  return <Intro v={view} />;
}
