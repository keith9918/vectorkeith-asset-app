// USVK 模拟盘 · 管理员：员工 / 客户账号（登录码、关联内部质押 = 额度）、重新开盘、修改交易密码
import { Copy, KeyRound, Pencil, RefreshCw, RotateCcw, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import type { SimAccountAdmin, SimView } from '../../../shared/types';
import { fmtDate, fmtInt, fmtSol } from '../lib/format';
import { KIND_LABEL, simAdmin } from '../lib/sim';
import { Card, Seg, copyText, toast } from './ui';

type Kind = 'staff' | 'client';

function MemberSelect({ v, value, onChange, id }: { v: SimView; value: string; onChange: (id: string) => void; id?: string }) {
  const members = v.admin?.members ?? [];
  return (
    <select id={id} className="sim-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">暂不关联（额度 0）</option>
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name} · 本金 {fmtSol(m.principal)} SOL
        </option>
      ))}
    </select>
  );
}

function shareText(name: string, code: string) {
  return `${name}，你的 USVK 模拟盘登录码：${code}\n打开 ${location.origin} → 右上角设置 → 我的身份 → 访问码 → 输入登录码。登录后在「模拟盘」里买卖（虚拟 SOL，额度 = 你在内部质押里的本金）。`;
}

function shareLogin(name: string, user: string, pw?: string) {
  return `${name}，你的 USVK 模拟盘账号：${user}${pw ? `，初始密码：${pw}` : ''}\n打开 ${location.origin} →「模拟盘」→ 输入账号密码登录（登录后可以自己改密码）。额度 = 你在内部质押里的本金。`;
}

function AccountRow({ a, v }: { a: SimAccountAdmin; v: SimView }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ name: a.name, kind: a.kind as Kind, memberId: a.memberId ?? '', note: a.note ?? '', username: a.username ?? '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (body: Record<string, unknown>, ok: string) => {
    setErr('');
    setBusy(true);
    try {
      const r = await simAdmin(body);
      toast(ok);
      return r;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sim-acc">
      <div className="sim-acc__top">
        <span className="sim-acc__name">
          {a.name} <span className={`chip sim-kind sim-kind--${a.kind}`}>{KIND_LABEL[a.kind]}</span>
        </span>
        <span className="mono sim-acc__code">
          {a.username ? `账号 ${a.username}` : (a.code ?? '—')}
          <button
            type="button"
            className="addr__btn"
            aria-label="复制登录方式和使用说明"
            onClick={() => (a.username ? copyText(shareLogin(a.name, a.username), '账号和说明已复制') : a.code && copyText(shareText(a.name, a.code), '登录码和说明已复制'))}
          >
            <Copy size={13} />
          </button>
        </span>
      </div>
      <div className="sim-acc__sub muted">
        {a.username && a.code ? `登录码 ${a.code} · ` : ''}
        {a.budgetSource === 'staking' ? `额度 ${fmtSol(a.budget)} SOL（内部质押：${a.linkedName}）` : '没关联内部质押 · 额度 0'} · 可用 {fmtSol(a.available)} · 持有 {fmtInt(a.tokens)} 枚
        {a.note ? ` · ${a.note}` : ''}
      </div>
      {editing ? (
        <div className="sub-form" style={{ marginTop: 8 }}>
          <div className="grid-form">
            <div className="field">
              <label htmlFor={`sn-${a.id}`}>名字</label>
              <input id={`sn-${a.id}`} value={f.name} maxLength={20} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </div>
            <div className="field">
              <label>类型</label>
              <Seg<Kind> label="类型" value={f.kind} onChange={(kind) => setF({ ...f, kind })} options={[{ value: 'staff', label: '员工' }, { value: 'client', label: '客户' }]} />
            </div>
          </div>
          <div className="field">
            <label htmlFor={`sm-${a.id}`}>关联内部质押（额度 = 他的本金）</label>
            <MemberSelect id={`sm-${a.id}`} v={v} value={f.memberId} onChange={(memberId) => setF({ ...f, memberId })} />
          </div>
          <div className="grid-form">
            <div className="field">
              <label htmlFor={`su-${a.id}`}>登录账号</label>
              <input id={`su-${a.id}`} value={f.username} maxLength={20} autoCapitalize="none" spellCheck={false} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="字母 / 数字" />
            </div>
            <div className="field">
              <label htmlFor={`sp-${a.id}`}>{a.hasPassword ? '新密码（不改就留空）' : '登录密码'}</label>
              <input id={`sp-${a.id}`} type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor={`so-${a.id}`}>备注（只有你能看到）</label>
            <input id={`so-${a.id}`} value={f.note} maxLength={60} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </div>
          <div className="wm__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setEditing(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--solid"
              disabled={busy}
              onClick={async () => {
                const { password, ...rest } = f;
                if (await run({ action: 'update', id: a.id, ...rest, ...(password ? { password } : {}) }, '已保存')) {
                  setEditing(false);
                  setF({ ...f, password: '' });
                }
              }}
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="sim-acc__actions">
          <button type="button" className="chip" onClick={() => setEditing(true)}>
            <Pencil size={11} /> 编辑
          </button>
          {a.username && (
            <button
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => {
                const pw = prompt(`给 ${a.name}（${a.username}）设一个新的登录密码（至少 6 位）。他正在用的设备会被退出登录。`);
                if (pw) void run({ action: 'setpw', id: a.id, password: pw }, '密码已重置');
              }}
            >
              <KeyRound size={11} /> 重置密码
            </button>
          )}
          <button
            type="button"
            className="chip"
            disabled={busy}
            onClick={() => confirm(a.code ? `给 ${a.name} 换一个新登录码？旧码立即失效。` : `给 ${a.name} 生成一个 8 位登录码？（账号密码照样能用）`) && void run({ action: 'regen', id: a.id }, '已生成新登录码')}
          >
            <RefreshCw size={11} /> {a.code ? '换登录码' : '生成登录码'}
          </button>
          <button type="button" className="chip" disabled={busy} onClick={() => confirm(`删除 ${a.name} 的模拟盘账号？`) && void run({ action: 'remove', id: a.id }, '已删除')}>
            <Trash2 size={11} /> 删除
          </button>
        </div>
      )}
      {err && <div className="error">{err}</div>}
    </div>
  );
}

function AccountsCard({ v }: { v: SimView }) {
  const accounts = v.admin?.accounts ?? [];
  const members = v.admin?.members ?? [];
  const [f, setF] = useState({ name: '', kind: 'staff' as Kind, memberId: '', note: '', username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [made, setMade] = useState<{ name: string; code: string; username?: string; password?: string } | null>(null);
  const add = async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await simAdmin({ action: 'add', ...f });
      setMade({ name: f.name.trim(), code: r.code ?? '', username: f.username.trim().toLowerCase() || undefined, password: f.username.trim() ? f.password : undefined });
      setF({ name: '', kind: f.kind, memberId: '', note: '', username: '', password: '' });
      toast('已添加');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card kicker="Admin · Accounts" title="模拟盘账号（员工 / 客户）" right={<span className="chip chip--accent">{accounts.length} 个</span>}>
      {accounts.length === 0 && <p className="card__note" style={{ marginTop: 0 }}>还没有账号。在下面添加员工或内部客户，系统会生成 8 位登录码。</p>}
      {accounts.map((a) => (
        <AccountRow key={a.id} a={a} v={v} />
      ))}

      <div className="sub-form" style={{ marginTop: 12 }}>
        <div className="wm__title">
          <UserPlus size={14} /> 添加账号
        </div>
        <div className="grid-form">
          <div className="field">
            <label htmlFor="sim-new-name">名字</label>
            <input id="sim-new-name" value={f.name} maxLength={20} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="例如 张三" />
          </div>
          <div className="field">
            <label>类型</label>
            <Seg<Kind> label="类型" value={f.kind} onChange={(kind) => setF({ ...f, kind })} options={[{ value: 'staff', label: '员工' }, { value: 'client', label: '客户' }]} />
          </div>
        </div>
        <div className="grid-form">
          <div className="field">
            <label htmlFor="sim-new-user">登录账号（可不填）</label>
            <input id="sim-new-user" value={f.username} maxLength={20} autoCapitalize="none" spellCheck={false} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="例如 vk13" />
          </div>
          <div className="field">
            <label htmlFor="sim-new-pw">初始密码</label>
            <input id="sim-new-pw" type="text" autoComplete="off" value={f.password} disabled={!f.username.trim()} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="至少 6 位" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="sim-new-member">关联内部质押（额度 = 他的本金）</label>
          <MemberSelect id="sim-new-member" v={v} value={f.memberId} onChange={(memberId) => setF({ ...f, memberId })} />
        </div>
        <div className="field">
          <label htmlFor="sim-new-note">备注（可不填，只有你能看到）</label>
          <input id="sim-new-note" value={f.note} maxLength={60} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </div>
        <button type="button" className="btn btn--solid" style={{ width: '100%' }} disabled={busy || !f.name.trim() || (!!f.username.trim() && f.password.length < 6)} onClick={() => void add()}>
          添加账号
        </button>
        {err && <div className="error">{err}</div>}
        {made && (
          <div className="addr-preview addr-preview--ok" style={{ marginTop: 10 }}>
            {made.username ? (
              <div>
                {made.name} 的账号：<b className="mono">{made.username}</b>，初始密码：<b className="mono">{made.password}</b>
              </div>
            ) : null}
            <div>
              登录码：<b className="mono" style={{ fontSize: 16, letterSpacing: '0.08em' }}>{made.code}</b>
            </div>
            <button
              type="button"
              className="btn"
              style={{ marginTop: 8 }}
              onClick={() => (made.username ? copyText(shareLogin(made.name, made.username, made.password), '账号和说明已复制') : copyText(shareText(made.name, made.code), '登录码和说明已复制'))}
            >
              <Copy size={13} /> 复制登录方式和使用说明
            </button>
          </div>
        )}
      </div>
      <p className="card__note">
        员工 / 客户的额度 = 他在「质押 → 内部质押」里的本金（真 SOL 存在内部质押里、记在他名下、可以赎回；模拟盘里亏赚不动真钱）。
        {members.length === 0 ? (
          <>
            {' '}内部质押里还没有登记任何人：先去 <a href="#/staking">质押 → 内部质押</a> 登记他的钱包，他存入 SOL 后再在这里关联。
          </>
        ) : (
          ' 他存入或赎回本金后，额度会自动跟着变。'
        )}
      </p>
    </Card>
  );
}

function ResetCard({ v }: { v: SimView }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const reset = async () => {
    if (!confirm(`重新开盘：第 ${v.round} 轮的盘口、所有人的持仓和成交记录清零（本轮摘要会保存在"以前的轮次"里）。确定？`)) return;
    setErr('');
    setBusy(true);
    try {
      await simAdmin({ action: 'reset', password: pw });
      setPw('');
      toast('已重新开盘');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card kicker="Admin · Reset" title="重新开盘" right={<span className="chip">第 {v.round} 轮 · {fmtDate(v.startedAt, false)} 开盘</span>}>
      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (pw) void reset();
        }}
      >
        <input className="input" type="password" inputMode="numeric" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="交易密码" aria-label="交易密码" />
        <button type="submit" className="btn" disabled={!pw || busy}>
          <RotateCcw size={14} /> 重新开盘
        </button>
      </form>
      {err && <div className="error">{err}</div>}
      <p className="card__note">回到开盘价从 0 开始。账号和登录码保留，额度也照旧（按公司总资产 / 内部质押本金）。</p>
    </Card>
  );
}

function PasswordCard() {
  const [f, setF] = useState({ old: '', next: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    setBusy(true);
    try {
      await simAdmin({ action: 'password', ...f });
      setF({ old: '', next: '' });
      toast('交易密码已修改');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card kicker="Admin · Password" title="修改交易密码">
      <div className="grid-form">
        <div className="field">
          <label htmlFor="sim-pw-old">现在的密码</label>
          <input id="sim-pw-old" type="password" autoComplete="off" value={f.old} onChange={(e) => setF({ ...f, old: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="sim-pw-new">新密码（6–32 位）</label>
          <input id="sim-pw-new" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
        </div>
      </div>
      <button type="button" className="btn" disabled={busy || !f.old || f.next.length < 6} onClick={() => void save()}>
        <KeyRound size={14} /> 修改
      </button>
      {err && <div className="error">{err}</div>}
      <p className="card__note">只有公司（管理员）买卖和重新开盘要交易密码；员工 / 客户用登录码登录后直接买卖。</p>
    </Card>
  );
}

export function SimAdmin({ v }: { v: SimView }) {
  return (
    <>
      <AccountsCard v={v} />
      <ResetCard v={v} />
      <PasswordCard />
    </>
  );
}
