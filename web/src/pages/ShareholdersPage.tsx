import { Ban, ExternalLink, Gift, KeyRound, LogOut, Pencil, Plus, RefreshCw, Trash2, Undo2, UserRound, Users } from 'lucide-react';
import { useState } from 'react';
import type { Payout, Shareholder, ShareholderView } from '../../../shared/types';
import { useCur } from '../components/Shell';
import { Address, Card, copyText, Seg, toast } from '../components/ui';
import { solscan } from '../lib/api';
import { CUR_SYMBOL, fmtDate, fmtMoney, fmtNum, fmtPct, fmtShortDate, fmtSol, shortAddr, type Cur } from '../lib/format';
import { useSolTo } from '../lib/hooks';
import { setPrefs, usePrefs } from '../lib/prefs';
import { fmtCode, holderAdmin, payoutAdmin, useShareholders } from '../lib/shareholders';
import { loginWithCode, logout, useStore } from '../lib/store';
import { Loading } from './common';

const pctText = (v: number) => `${+v.toFixed(4)}%`;
const pad = (n: number) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 发放时的价值（按当时的 SOL 价格；人民币用现在的汇率换算） */
function valueAt(p: Payout, cur: Cur, usdCny: number) {
  if (cur === 'sol') return p.sol;
  return cur === 'usd' ? p.usd : p.usd * usdCny;
}

// ─── 分红池（所有人可见） ─────────────────────────────────────

function DividendPoolCard({ pool, ratio, showCalc }: { pool: number; ratio: number; showCalc: boolean }) {
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const prefs = usePrefs();
  const hold = Math.max(0, Math.min(100, Number(prefs.holdPct) || 0)) / 100;
  return (
    <Card
      className="hero-card"
      kicker="Shareholder Dividend"
      title={
        <>
          股东分红利息 <span className="chip chip--accent" style={{ marginLeft: 4, verticalAlign: 2 }}>总资产 × {fmtPct(ratio, 0)}</span>
        </>
      }
    >
      <div className="glow-orb" />
      <div className="hero-value">
        <small>{CUR_SYMBOL[primary]}</small>
        {fmtNum(pool * solTo[primary], 2)}
      </div>
      <div className="hero-sub">
        <span>
          <b>{fmtMoney(pool * solTo[secondary], secondary)}</b>
        </span>
        <span>
          <b>{fmtSol(pool)}</b> SOL
        </span>
      </div>
      {showCalc && (
        <div className="calc">
          <label htmlFor="hold-pct" className="dim" style={{ fontSize: 13 }}>
            持股比例
          </label>
          <input
            id="hold-pct"
            inputMode="decimal"
            value={prefs.holdPct}
            onChange={(e) => setPrefs({ holdPct: e.target.value.replace(/[^\d.]/g, '').slice(0, 7) })}
            aria-label="持股比例百分比"
          />
          <span className="dim">%</span>
          <span style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <span className="muted" style={{ fontSize: 12 }}>应得 </span>
            <b>{fmtMoney(pool * hold * solTo[primary], primary)}</b>
            <div className="muted" style={{ fontSize: 11.5 }}>
              {fmtMoney(pool * hold * solTo[secondary], secondary)} · {fmtSol(pool * hold)} SOL
            </div>
          </span>
        </div>
      )}
      <p className="card__note">
        分红池 = 公司总资产 × {fmtPct(ratio, 0)}，公司钱包有转入转出或 SOL 价格变动时实时变化。每位股东应得 = 分红池 × 持股比例。
      </p>
    </Card>
  );
}

// ─── 发放记录 ─────────────────────────────────────────────────

function PayoutList({ payouts, names, admin, onChanged }: { payouts: Payout[]; names: Map<string, string>; admin: boolean; onChanged?: () => void }) {
  const { primary } = useCur();
  const usdCny = useStore((s) => s.snap?.solPrice.usdCny ?? 7.1);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState('');
  const list = all ? payouts : payouts.slice(0, 12);

  const act = async (p: Payout, action: 'exclude' | 'include' | 'remove') => {
    if (action === 'remove' && !confirm(`删除这条手动记录（${names.get(p.sid) ?? ''} ${fmtSol(p.sol)} SOL）？`)) return;
    setBusy(p.id);
    try {
      await payoutAdmin({ action, id: p.id });
      toast(action === 'exclude' ? '已标记为不是分红' : action === 'include' ? '已算作分红' : '已删除');
      onChanged?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  if (!payouts.length) return <div className="muted" style={{ fontSize: 12.5, padding: '8px 0' }}>还没有发放记录。</div>;
  return (
    <>
      <div className="flows">
        {list.map((p) => {
          const sub =
            p.source === 'chain'
              ? `${fmtShortDate(p.ts * 1000)} · 链上${admin ? ` → ${shortAddr(p.to)}` : '到账'}`
              : `${fmtDate(p.ts * 1000, false)} · 线下${p.currency && p.currency !== 'sol' && p.amount ? ` ${fmtMoney(p.amount, p.currency)}` : ''}${p.note ? ` · ${p.note}` : ''}`;
          const body = (
            <>
              <span className="flow-row__icon up">
                <Gift size={15} />
              </span>
              <span className="flow-row__main">
                <span className="flow-row__title">
                  {admin ? (names.get(p.sid) ?? '股东') : '分红到账'}
                  {p.excluded && <span className="chip chip--warn" style={{ height: 18, fontSize: 10, padding: '0 5px' }}>不算分红</span>}
                </span>
                <span className="flow-row__sub">{sub}</span>
              </span>
              <span className="flow-row__amt">
                <span className={p.excluded ? 'muted' : 'up'}>+{fmtSol(p.sol)} SOL</span>
                <span className="muted">{fmtMoney(valueAt(p, primary, usdCny), primary)}</span>
              </span>
            </>
          );
          // 股东看自己的记录：整行点开链上详情（和资金流水一致）
          if (!admin) {
            return p.sig ? (
              <a key={p.id} className="payout" href={solscan.tx(p.sig)} target="_blank" rel="noreferrer">
                {body}
              </a>
            ) : (
              <div key={p.id} className="payout">
                {body}
              </div>
            );
          }
          return (
            <div key={p.id} className={`payout ${p.excluded ? 'payout--ex' : ''}`}>
              {body}
              <span className="payout__actions">
                {p.sig && (
                  <a className="chip" href={solscan.tx(p.sig)} target="_blank" rel="noreferrer">
                    <ExternalLink size={11} /> 详情
                  </a>
                )}
                {admin && p.source === 'chain' && (
                  <button type="button" className="chip" disabled={busy === p.id} onClick={() => act(p, p.excluded ? 'include' : 'exclude')}>
                    {p.excluded ? (
                      <>
                        <Undo2 size={11} /> 算作分红
                      </>
                    ) : (
                      <>
                        <Ban size={11} /> 不是分红
                      </>
                    )}
                  </button>
                )}
                {admin && p.source === 'manual' && (
                  <button type="button" className="chip" disabled={busy === p.id} onClick={() => act(p, 'remove')}>
                    <Trash2 size={11} /> 删除
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {payouts.length > 12 && (
        <button type="button" className="btn btn--ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setAll(!all)}>
          {all ? '收起' : `显示全部 ${payouts.length} 笔`}
        </button>
      )}
    </>
  );
}

// ─── 股东：我的分红 ───────────────────────────────────────────

function MyDividendCard({ view, pool }: { view: ShareholderView; pool: number }) {
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const usdCny = useStore((s) => s.snap?.solPrice.usdCny ?? 7.1);
  const me = view.holders[0];
  if (!me) return null;
  const due = (pool * me.pct) / 100;
  const paidSol = view.payouts.reduce((s, p) => s + p.sol, 0);
  const paidUsd = view.payouts.reduce((s, p) => s + p.usd, 0);
  return (
    <Card
      kicker="My Dividend"
      title={
        <>
          我的分红 <span className="chip chip--accent" style={{ marginLeft: 4, verticalAlign: 2 }}>{me.name}</span>
        </>
      }
      right={
        <button type="button" className="chip" onClick={() => void logout()}>
          <LogOut size={11} /> 退出
        </button>
      }
    >
      <div className="big-money">
        {fmtMoney(due * solTo[primary], primary)}
        <span className="dim">{fmtMoney(due * solTo[secondary], secondary)}</span>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        当前应得（分红池 × 你的 {pctText(me.pct)}）· {fmtSol(due)} SOL
      </div>
      <div className="rows" style={{ marginTop: 8 }}>
        <div className="row">
          <span className="row__k">持股比例</span>
          <span className="row__v mono">{pctText(me.pct)}</span>
        </div>
        <div className="row">
          <span className="row__k">累计已收到</span>
          <span className="row__v">
            <b className="mono">{fmtSol(paidSol)} SOL</b>
            <div className="muted" style={{ fontSize: 11.5 }}>
              发放时价值 {fmtMoney(primary === 'usd' ? paidUsd : paidUsd * usdCny, primary)} · {fmtMoney(primary === 'usd' ? paidUsd * usdCny : paidUsd, secondary)}
            </div>
          </span>
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <span className="row__k">收款钱包</span>
          <span className="row__v" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            {me.wallets.length ? me.wallets.map((w) => <Address key={w} address={w} />) : <span className="muted">未登记（找管理员添加）</span>}
          </span>
        </div>
      </div>
      <div className="wm__title" style={{ marginTop: 12 }}>
        到账记录（{view.payouts.length} 笔）
      </div>
      <PayoutList payouts={view.payouts} names={new Map()} admin={false} />
      <p className="card__note">
        公司钱包转到你收款钱包的 SOL 会自动记为分红到账；线下发放的由公司补记。应得分红按公司现在的总资产实时计算。
      </p>
    </Card>
  );
}

// ─── 未登录：股东用查看码登录 ─────────────────────────────────

function HolderLoginCard() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const info = await loginWithCode(code);
      toast(info.role === 'holder' ? `欢迎，${info.name}` : '已登录');
      setCode('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card kicker="Shareholder Login" title="股东查看自己的分红">
      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) void submit();
        }}
      >
        <input
          className="input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="查看码，例如 ABCD-EFGH"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          aria-label="股东查看码"
        />
        <button type="submit" className="btn btn--solid" style={{ height: 40 }} disabled={!code.trim() || busy}>
          查看
        </button>
      </form>
      {err && <div className="error">{err}</div>}
      <p className="card__note">用公司管理员发给你的查看码登录，就能看到你的应得分红和每一笔已到账的分红。</p>
    </Card>
  );
}

// ─── 合计（访客、管理员） ─────────────────────────────────────

function Totals({ view }: { view: ShareholderView }) {
  const { primary, secondary } = useCur();
  const usdCny = useStore((s) => s.snap?.solPrice.usdCny ?? 7.1);
  const usdTo = (cur: Cur) => (cur === 'usd' ? 1 : usdCny);
  return (
    <div className="stat3">
      <div>
        <span>股东</span>
        <b>{view.count} 位</b>
      </div>
      <div>
        <span>已登记持股</span>
        <b>{pctText(view.totalPct)}</b>
      </div>
      <div>
        <span>已发放分红</span>
        <b>{fmtSol(view.paidSol)} SOL</b>
        <em>
          {fmtMoney(view.paidUsd * usdTo(primary), primary)}
          <br />
          {fmtMoney(view.paidUsd * usdTo(secondary), secondary)}
        </em>
      </div>
    </div>
  );
}

// ─── 管理员：添加 / 编辑股东 ──────────────────────────────────

function HolderForm({ initial, freePct, onDone }: { initial?: Shareholder; freePct: number; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [pct, setPct] = useState(initial ? String(initial.pct) : '');
  const [wallets, setWallets] = useState(initial?.wallets.join('\n') ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const max = +(freePct + (initial?.pct ?? 0)).toFixed(4);

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await holderAdmin({
        action: initial ? 'update' : 'add',
        id: initial?.id,
        name: name.trim(),
        pct: Number(pct),
        wallets: wallets.split(/[\s,，;；]+/).filter(Boolean),
        note,
      });
      toast(initial ? '已保存' : `已添加 ${name.trim()}，查看码已生成`);
      onDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="sub-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="wm__title">{initial ? `编辑 ${initial.name}` : '添加股东'}</div>
      <div className="grid-form">
        <div className="field">
          <label htmlFor="hf-name">名字</label>
          <input id="hf-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="例如 张三" />
        </div>
        <div className="field">
          <label htmlFor="hf-pct">持股比例 %（最多 {max}）</label>
          <input id="hf-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value.replace(/[^\d.]/g, ''))} placeholder="例如 10" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="hf-wallets">收款钱包（可多个，每行一个；可以先不填）</label>
        <textarea id="hf-wallets" rows={2} value={wallets} onChange={(e) => setWallets(e.target.value)} placeholder="粘贴 Solana 钱包地址" spellCheck={false} autoCapitalize="off" />
      </div>
      <div className="field">
        <label htmlFor="hf-note">备注（只有管理员能看到）</label>
        <input id="hf-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} placeholder="可不填" />
      </div>
      <p className="card__note" style={{ marginTop: 0 }}>
        公司钱包转到收款钱包的 SOL 会自动记为分红发放。{initial ? '' : '添加后会生成一个查看码，发给股东，他输入后只能看到自己的分红。'}
      </p>
      {err && <div className="error">{err}</div>}
      <div className="wm__actions">
        <button type="button" className="btn btn--ghost" onClick={() => onDone(false)}>
          取消
        </button>
        <button type="submit" className="btn btn--solid" disabled={busy || !name.trim() || !(Number(pct) > 0)}>
          {busy ? '保存中…' : initial ? '保存' : '添加'}
        </button>
      </div>
    </form>
  );
}

// ─── 管理员：手动补记一笔发放 ─────────────────────────────────

function ManualPayoutForm({ holder, onDone }: { holder: Shareholder; onDone: (ok: boolean) => void }) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<'cny' | 'usd' | 'sol'>('cny');
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const ts = date === todayStr() ? Math.floor(Date.now() / 1000) : Math.floor(new Date(`${date}T12:00:00`).getTime() / 1000);
      await payoutAdmin({ action: 'add', sid: holder.id, amount: Number(amount), currency, ts, note });
      toast(`已记录：${holder.name} ${fmtMoney(Number(amount), currency)}`);
      onDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="sub-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="wm__title">给 {holder.name} 补记一笔线下发放</div>
      <div className="grid-form">
        <div className="field">
          <label htmlFor="mp-amount">金额</label>
          <input id="mp-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="例如 1000" />
        </div>
        <div className="field">
          <label htmlFor="mp-date">发放日期</label>
          <input id="mp-date" type="date" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>币种</label>
        <Seg<'cny' | 'usd' | 'sol'>
          label="币种"
          value={currency}
          onChange={setCurrency}
          options={[
            { value: 'cny', label: '人民币 ¥' },
            { value: 'usd', label: '美元 $' },
            { value: 'sol', label: 'SOL' },
          ]}
        />
      </div>
      <div className="field">
        <label htmlFor="mp-note">备注（可不填）</label>
        <input id="mp-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} placeholder="例如 银行转账" />
      </div>
      <p className="card__note" style={{ marginTop: 0 }}>
        链上从公司钱包转给股东的会自动记录，不用补记。这里只记线下发放（例如银行转账），按发放日的 SOL 价格折算。
      </p>
      {err && <div className="error">{err}</div>}
      <div className="wm__actions">
        <button type="button" className="btn btn--ghost" onClick={() => onDone(false)}>
          取消
        </button>
        <button type="submit" className="btn btn--solid" disabled={busy || !(Number(amount) > 0)}>
          {busy ? '保存中…' : '记录'}
        </button>
      </div>
    </form>
  );
}

// ─── 管理员：股东名册 ─────────────────────────────────────────

function HolderItem({ h, view, pool, onChanged }: { h: Shareholder; view: ShareholderView; pool: number; onChanged: () => void }) {
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const [mode, setMode] = useState<'' | 'edit' | 'pay'>('');
  const [busy, setBusy] = useState(false);
  const due = (pool * h.pct) / 100;
  const mine = view.payouts.filter((p) => p.sid === h.id && !p.excluded);
  const paid = mine.reduce((s, p) => s + p.sol, 0);
  const freePct = Math.max(0, 100 - view.totalPct);

  const run = async (body: Record<string, unknown>, ok: string, ask?: string) => {
    if (ask && !confirm(ask)) return;
    setBusy(true);
    try {
      await holderAdmin(body);
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
          {h.name}
          <span className="chip chip--accent">{pctText(h.pct)}</span>
        </div>
        <div className="holder__due">
          {fmtMoney(due * solTo[primary], primary)}
          <div className="muted">
            应得 · {fmtMoney(due * solTo[secondary], secondary)} · {fmtSol(due)} SOL
          </div>
        </div>
      </div>
      <div className="holder__meta">
        已收到 <b className="mono">{fmtSol(paid)} SOL</b>（{mine.length} 笔{mine[0] ? `，最近 ${fmtDate(mine[0].ts * 1000, false)}` : ''}）
      </div>
      <div className="holder__wallets">
        {h.wallets.length ? h.wallets.map((w) => <Address key={w} address={w} />) : <span className="muted">未登记收款钱包（发放只能手动记录）</span>}
      </div>
      <div className="holder__code">
        <KeyRound size={13} /> 查看码 <b className="mono">{fmtCode(h.code)}</b>
        <button type="button" className="chip" onClick={() => copyText(`VectorKeith 股东查看码：${fmtCode(h.code)}\n打开 ${location.origin} ，在「股东」页输入查看码即可查看你的分红。`, '查看码已复制，可以直接发给股东')}>
          复制发给股东
        </button>
        <button
          type="button"
          className="chip"
          disabled={busy}
          onClick={() => run({ action: 'regen', id: h.id }, '已生成新的查看码', `给 ${h.name} 重新生成查看码？旧的查看码会立即失效，已经登录的设备需要用新码重新登录。`)}
        >
          <RefreshCw size={11} /> 重新生成
        </button>
      </div>
      {h.note && <div className="holder__meta muted">备注：{h.note}</div>}
      {mode === '' && (
        <div className="wm__actions">
          <button type="button" className="btn" onClick={() => setMode('edit')}>
            <Pencil size={13} /> 编辑
          </button>
          <button type="button" className="btn" onClick={() => setMode('pay')}>
            <Plus size={13} /> 补记发放
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => run({ action: 'remove', id: h.id }, `已删除 ${h.name}`, `删除股东 ${h.name}？他的手动发放记录会一起删除，查看码立即失效（链上转账记录不受影响）。`)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
      {mode === 'edit' && (
        <HolderForm
          initial={h}
          freePct={freePct}
          onDone={(saved) => {
            setMode('');
            if (saved) onChanged();
          }}
        />
      )}
      {mode === 'pay' && (
        <ManualPayoutForm
          holder={h}
          onDone={(ok) => {
            setMode('');
            if (ok) onChanged();
          }}
        />
      )}
    </div>
  );
}

function AdminRegistry({ view, pool, onChanged }: { view: ShareholderView; pool: number; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const freePct = Math.max(0, 100 - view.totalPct);
  const names = new Map(view.holders.map((h) => [h.id, h.name]));
  return (
    <>
      <Card
        kicker="Shareholder Registry"
        title={`股东名册（${view.count} 位）`}
        right={
          !adding && (
            <button type="button" className="chip chip--accent" onClick={() => setAdding(true)}>
              <Plus size={11} /> 添加股东
            </button>
          )
        }
      >
        <Totals view={view} />
        {view.count > 0 && freePct > 0.00005 && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>还有 {pctText(freePct)} 的股份没有登记到具体股东。</div>}
        {adding && (
          <HolderForm
            freePct={freePct}
            onDone={(saved) => {
              setAdding(false);
              if (saved) onChanged();
            }}
          />
        )}
        {!view.holders.length && !adding && (
          <div className="empty">
            <Users size={22} />
            <div>还没有登记股东</div>
            <button type="button" className="btn btn--solid" onClick={() => setAdding(true)}>
              <Plus size={14} /> 添加第一位股东
            </button>
          </div>
        )}
        {view.holders.map((h) => (
          <HolderItem key={h.id} h={h} view={view} pool={pool} onChanged={onChanged} />
        ))}
        <p className="card__note">只有管理员能看到名册和查看码。把查看码发给股东，他在「股东」页输入后只能看到自己的分红，看不到别人的。</p>
      </Card>

      <Card kicker="Payouts" title="分红发放记录" right={<span className="chip">共 {view.payouts.length} 笔</span>}>
        <PayoutList payouts={view.payouts} names={names} admin onChanged={onChanged} />
        <p className="card__note">
          公司钱包转到股东收款钱包的 SOL 自动记为分红（链上）；转账其实不是分红（例如报销）时点"不是分红"。线下发放在股东名册里"补记发放"。
        </p>
      </Card>
    </>
  );
}

// ─── 页面 ─────────────────────────────────────────────────────

export function ShareholdersPage() {
  const snap = useStore((s) => s.snap);
  const role = useStore((s) => s.access?.role ?? 'public');
  const { view, error, reload } = useShareholders();
  if (!snap) return <Loading />;
  const t = snap.treasury;
  const pool = t.totalSol * t.dividendRatio;
  return (
    <>
      <DividendPoolCard pool={pool} ratio={t.dividendRatio} showCalc={role !== 'holder'} />
      {error && <div className="banner">{error}</div>}
      {role === 'public' && <HolderLoginCard />}
      {role === 'holder' && view && <MyDividendCard view={view} pool={pool} />}
      {role === 'viewer' && view && (
        <Card kicker="Shareholders" title="股东与分红发放">
          <Totals view={view} />
          <p className="card__note">股东用自己的查看码登录后，可以看到个人的应得分红和到账记录。</p>
        </Card>
      )}
      {role === 'admin' && view && <AdminRegistry view={view} pool={pool} onChanged={reload} />}
    </>
  );
}
