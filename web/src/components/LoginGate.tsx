import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { useState } from 'react';
import { loginWithCode, loginWithPassword } from '../lib/store';
import { Seg } from './ui';

/** "需要访问码"模式下没登录时显示：账号 + 密码（模拟盘），或股东查看码 / 员工登录码 / 访问密码 / 管理员密钥 */
export function LoginGate() {
  const [mode, setMode] = useState<'pw' | 'code'>('pw');
  const [code, setCode] = useState('');
  const [user, setUser] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ready = mode === 'pw' ? !!user.trim() && !!code : !!code.trim();

  const submit = async () => {
    if (!ready || busy) return;
    setErr('');
    setBusy(true);
    try {
      if (mode === 'pw') await loginWithPassword(user, code, remember);
      else await loginWithCode(code, remember);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <section className="card gate__card">
        <img className="gate__logo" src="/icons/icon-192.png" alt="" />
        <div className="header__name" style={{ fontSize: 17 }}>
          VECTORKEITH
        </div>
        <h1 className="gate__title">
          <LockKeyhole size={16} /> 公司资产 · 内部查看
        </h1>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 6 }}>
          <Seg<'pw' | 'code'>
            label="登录方式"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setCode('');
              setErr('');
            }}
            options={[
              { value: 'pw', label: '账号密码' },
              { value: 'code', label: '访问码' },
            ]}
          />
        </div>
        <p className="gate__note">
          {mode === 'pw' ? '模拟盘账号：公司用 admin，员工用 VK1–VK12 等，由公司管理员开通。' : '股东查看码、员工登录码、模拟盘登录码、访问密码都可以，由公司管理员提供。'}
        </p>
        <form
          className="gate__form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {mode === 'pw' && (
            <div className="gate__input">
              <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="账号" autoComplete="username" autoCapitalize="none" spellCheck={false} aria-label="账号" autoFocus />
            </div>
          )}
          <div className="gate__input">
            <input
              type={show ? 'text' : 'password'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={mode === 'pw' ? '密码' : '访问码'}
              autoComplete="current-password"
              autoCapitalize={mode === 'pw' ? 'none' : 'characters'}
              spellCheck={false}
              aria-label={mode === 'pw' ? '密码' : '访问码'}
              autoFocus={mode === 'code'}
            />
            <button type="button" className="addr__btn" aria-label={show ? '隐藏' : '显示'} onClick={() => setShow(!show)}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <button type="submit" className="btn btn--solid" style={{ width: '100%', height: 42 }} disabled={!ready || busy}>
            {busy ? '验证中…' : '进入'}
          </button>
          <label className="checkbox" style={{ justifyContent: 'center' }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            在这台手机上保持登录（自己的手机才勾选）
          </label>
          {err && (
            <div className="error" role="alert" style={{ textAlign: 'center' }}>
              {err}
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
