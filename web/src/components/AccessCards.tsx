import { Dices, LogIn, LogOut, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AccessMode, AccessSettings } from '../../../shared/types';
import { postJSON } from '../lib/api';
import { loginWithCode, loginWithPassword, useStore } from '../lib/store';
import { Card, Seg, toast } from './ui';

const ROLE_LABEL = { public: '未登录', viewer: '访客', holder: '股东', member: '员工', trader: '模拟盘', admin: '管理员' } as const;
const SIM_KIND = { staff: '模拟盘员工', client: '模拟盘客户', admin: '模拟盘管理员' } as const;

/** 我的身份：未登录时可用账号密码或访问码登录；已登录可退出 */
export function AccountCard({ onLogout }: { onLogout: () => void }) {
  const access = useStore((s) => s.access);
  const role = access?.role ?? 'public';
  const [mode, setMode] = useState<'pw' | 'code'>('pw');
  const [code, setCode] = useState('');
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const info = mode === 'pw' ? await loginWithPassword(user, pw) : await loginWithCode(code);
      toast(info.role === 'holder' || info.role === 'trader' ? `欢迎，${info.name}` : `已登录（${ROLE_LABEL[info.role]}）`);
      setCode('');
      setUser('');
      setPw('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const desc =
    role === 'admin'
      ? '可以管理公司钱包、股东名册和访问设置。'
      : role === 'holder'
        ? `股东 ${access?.name ?? ''}：可以在「股东」页看到自己的分红。`
        : role === 'member'
          ? `员工 ${access?.name ?? ''}：可以在「质押 → 内部质押」里充值、看分息、申请赎回。`
        : role === 'trader' && access?.kind === 'admin'
          ? 'admin 账号：可以管理 USVK 模拟盘（开账号、重置密码、买卖、重新开盘）。公司钱包、股东、内部质押等设置要用管理员密钥。'
        : role === 'trader'
          ? `${SIM_KIND[access?.kind ?? 'staff']} ${access?.name ?? ''}：可以在「模拟盘」里买卖 USVK（虚拟 SOL，额度 = 你在内部质押里的本金）。`
        : role === 'viewer'
          ? '用访问密码登录：可以看公司资产和分红合计。'
          : '模拟盘用账号 + 密码登录（admin、VK1–VK12…）；股东查看码、员工登录码、访问密码、管理员密钥选「访问码」。';

  return (
    <Card kicker="Account" title="我的身份" right={<span className={`chip ${role === 'public' ? '' : 'chip--accent'}`}>{role === 'holder' || role === 'member' ? `${ROLE_LABEL[role]} · ${access?.name ?? ''}` : role === 'trader' ? `${SIM_KIND[access?.kind ?? 'staff']} · ${access?.name ?? ''}` : ROLE_LABEL[role]}</span>}>
      <p className="card__note" style={{ marginTop: 0 }}>
        {desc}
      </p>
      {role === 'public' ? (
        <>
          <div style={{ marginTop: 10 }}>
            <Seg<'pw' | 'code'>
              label="登录方式"
              value={mode}
              onChange={(m) => {
                setMode(m);
                setErr('');
              }}
              options={[
                { value: 'pw', label: '账号密码' },
                { value: 'code', label: '访问码' },
              ]}
            />
          </div>
          {mode === 'pw' ? (
            <form
              className="sim-login"
              style={{ marginTop: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (user.trim() && pw) void submit();
              }}
            >
              <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="账号（admin / VK1…）" autoComplete="username" autoCapitalize="none" spellCheck={false} aria-label="账号" />
              <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="密码" autoComplete="current-password" aria-label="密码" />
              <button type="submit" className="btn btn--solid" style={{ height: 40 }} disabled={!user.trim() || !pw || busy}>
                <LogIn size={14} /> 登录
              </button>
            </form>
          ) : (
            <form
              style={{ display: 'flex', gap: 8, marginTop: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) void submit();
              }}
            >
              <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入查看码 / 访问码" autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-label="访问码" />
              <button type="submit" className="btn btn--solid" style={{ height: 40 }} disabled={!code.trim() || busy}>
                <LogIn size={14} /> 登录
              </button>
            </form>
          )}
        </>
      ) : (
        <button type="button" className="btn btn--ghost" style={{ marginTop: 10 }} onClick={onLogout}>
          <LogOut size={14} /> 退出登录
        </button>
      )}
      {err && <div className="error">{err}</div>}
    </Card>
  );
}

function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

/** 访问控制（管理员）：公开 / 需要访问码；通用访问密码 */
export function AccessSettingsCard({ adminKey }: { adminKey: string }) {
  const [cfg, setCfg] = useState<AccessSettings | null>(null);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    postJSON<AccessSettings>('/api/admin/access', {}, adminKey)
      .then((c) => {
        setCfg(c);
        setPw(c.password);
      })
      .catch((e) => setErr((e as Error).message));
  }, [adminKey]);

  const save = async (patch: Partial<AccessSettings>, ok: string) => {
    setErr('');
    setBusy(true);
    try {
      const c = await postJSON<AccessSettings>('/api/admin/access', patch, adminKey);
      setCfg(c);
      setPw(c.password);
      toast(ok);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setMode = (mode: AccessMode) => {
    if (!cfg || mode === cfg.mode) return;
    if (mode === 'code' && !confirm('开启后，打开 App 必须先输入访问码（股东查看码、访问密码或管理员密钥）。正在看 App 但没有登录的人会立即被要求输入。确定开启？')) return;
    void save({ mode }, mode === 'code' ? '已开启：需要访问码' : '已改为公开');
  };

  return (
    <Card
      kicker="Access"
      title="访问控制"
      right={
        <span className={`chip ${cfg?.mode === 'code' ? 'chip--accent' : 'chip--warn'}`}>
          <ShieldCheck size={11} /> {cfg ? (cfg.mode === 'code' ? '需要访问码' : '公开') : '…'}
        </span>
      }
    >
      {cfg && (
        <>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="row__k">谁能打开 App</span>
            <Seg<AccessMode>
              label="访问模式"
              value={cfg.mode}
              onChange={setMode}
              options={[
                { value: 'public', label: '知道网址就能看' },
                { value: 'code', label: '需要访问码' },
              ]}
            />
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="acc-pw">通用访问密码（给员工、合作方用；能看资产，看不到股东名单）</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input id="acc-pw" value={pw} onChange={(e) => setPw(e.target.value.trim())} placeholder="不设置" maxLength={64} autoComplete="off" spellCheck={false} style={{ fontFamily: 'var(--font-code)' }} />
              <button type="button" className="icon-btn" style={{ width: 40, height: 40, flex: 'none' }} aria-label="随机生成" onClick={() => setPw(randomPassword())}>
                <Dices size={16} />
              </button>
              <button type="button" className="btn" style={{ height: 40 }} disabled={busy || pw === cfg.password} onClick={() => save({ password: pw }, pw ? '访问密码已保存' : '已取消访问密码')}>
                保存
              </button>
            </div>
          </div>
          <p className="card__note">
            · 股东查看码在「股东」页给每位股东单独生成，股东只能看到自己的分红。
            <br />· 改访问密码或重新生成查看码后，用旧码登录的设备会立即退出。
            <br />· 管理员密钥本身也能当访问码使用。
            {cfg.mode === 'public' && (
              <>
                <br />· 现在是公开模式：知道网址的人都能看到公司资产（股东名单和查看码始终只有管理员能看到）。
              </>
            )}
          </p>
        </>
      )}
      {err && <div className="error">{err}</div>}
    </Card>
  );
}
