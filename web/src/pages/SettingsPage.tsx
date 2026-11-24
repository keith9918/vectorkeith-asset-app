import { useEffect, useState } from 'react';
import { AccessSettingsCard, AccountCard } from '../components/AccessCards';
import { BurnTool } from '../components/BurnTool';
import { PushCard } from '../components/PushCard';
import { WalletManager } from '../components/WalletManager';
import { Address, Card, Seg, toast } from '../components/ui';
import { clearAdminKey, loadAdminKey, saveAdminKey } from '../lib/admin';
import { getServerBase, postJSON, setServerBase } from '../lib/api';
import { fmtPct, shortAddr } from '../lib/format';
import { speak, unlockAudio, unlockSpeech } from '../lib/fx';
import { useHashParam } from '../lib/hooks';
import { setPrefs, usePrefs } from '../lib/prefs';
import { adoptToken, logout as logoutAccess, reconnectNow, useStore } from '../lib/store';
import { Loading } from './common';

export function SettingsPage() {
  const prefs = usePrefs();
  const config = useStore((s) => s.snap?.config);
  const role = useStore((s) => s.access?.role ?? 'public');
  const prefill = useHashParam('add');
  const [adminKey, setAdminKey] = useState(loadAdminKey);
  const [remember, setRemember] = useState(true);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [server, setServer] = useState(getServerBase());

  const verify = async (silent = false) => {
    setErr('');
    setBusy(true);
    try {
      const r = await postJSON<{ ok: boolean; token?: string }>('/api/admin/verify', {}, adminKey);
      saveAdminKey(adminKey, remember);
      setVerified(true);
      // 同时换成管理员身份（股东页能看到名册；"需要访问码"模式下也能直接使用）
      if (r.token && role !== 'admin') adoptToken(r.token, remember);
      if (!silent) toast('已进入管理');
    } catch (e) {
      if (silent) clearAdminKey();
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 本机记住过密钥：打开设置页自动进入管理
  useEffect(() => {
    if (config?.adminEnabled && adminKey && !verified) void verify(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.adminEnabled]);

  if (!config) return <Loading />;

  // 用管理员令牌登录（例如在登录页输入了管理员密钥）也算管理员
  const isAdmin = verified || role === 'admin';

  const logout = () => {
    clearAdminKey();
    setAdminKey('');
    setVerified(false);
    if (role !== 'public') void logoutAccess();
    toast('已退出');
  };

  return (
    <>
      <AccountCard onLogout={logout} />

      <PushCard isAdmin={isAdmin} adminKey={adminKey} />

      <Card kicker="Display" title="显示偏好">
        <div className="rows">
          <div className="row">
            <span className="row__k">主显示货币</span>
            <Seg<'cny' | 'usd'>
              label="主显示货币"
              value={prefs.primary}
              onChange={(v) => setPrefs({ primary: v })}
              options={[
                { value: 'cny', label: '人民币 ¥' },
                { value: 'usd', label: '美元 $' },
              ]}
            />
          </div>
          <div className="row">
            <span className="row__k">涨跌颜色</span>
            <Seg<'greenUp' | 'redUp'>
              label="涨跌颜色"
              value={prefs.colors}
              onChange={(v) => setPrefs({ colors: v })}
              options={[
                { value: 'greenUp', label: '绿涨红跌' },
                { value: 'redUp', label: '红涨绿跌' },
              ]}
            />
          </div>
          <div className="row">
            <span className="row__k">到账特效</span>
            <Seg<'on' | 'off'> label="到账特效" value={prefs.fx ? 'on' : 'off'} onChange={(v) => setPrefs({ fx: v === 'on' })} options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]} />
          </div>
          <div className="row">
            <span className="row__k">首页吉祥物</span>
            <Seg<'on' | 'off'> label="吉祥物" value={prefs.mascot ? 'on' : 'off'} onChange={(v) => setPrefs({ mascot: v === 'on' })} options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]} />
          </div>
          <div className="row">
            <span className="row__k">到账语音播报</span>
            <Seg<'on' | 'off'>
              label="语音播报"
              value={prefs.voice ? 'on' : 'off'}
              onChange={(v) => {
                setPrefs({ voice: v === 'on' });
                if (v === 'on') {
                  unlockSpeech();
                  speak('语音播报已开启', true);
                }
              }}
              options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]}
            />
          </div>
          <div className="row">
            <span className="row__k">音效</span>
            <Seg<'on' | 'off'>
              label="音效"
              value={prefs.sound ? 'on' : 'off'}
              onChange={(v) => {
                setPrefs({ sound: v === 'on' });
                if (v === 'on') unlockAudio();
              }}
              options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]}
            />
          </div>
        </div>
        <p className="card__note">人民币和美元始终同时显示，这里只决定哪个作为大号主数字。到账特效和音效可以在「探索 → 特效实验室」里试。</p>
      </Card>

      <Card
        kicker="Company Wallets"
        title="公司钱包与分红"
        right={<span className="chip chip--accent">{isAdmin ? '管理中' : `分红 ${fmtPct(config.dividendRatio, 0)}`}</span>}
      >
        {isAdmin ? (
          <WalletManager adminKey={adminKey} prefill={prefill} onLogout={logout} />
        ) : (
          <>
            {prefill && (
              <div className="banner banner--info" style={{ marginBottom: 10 }}>
                要把 {shortAddr(prefill, 6)} 加为公司钱包，请先输入管理员密钥。
              </div>
            )}
            <div className="rows">
              {config.companyWallets.map((w) => (
                <div key={w.address} className="row">
                  <span className="row__k" style={{ color: 'var(--text-1)', fontWeight: 600 }}>
                    {w.label}
                  </span>
                  <Address address={w.address} />
                </div>
              ))}
            </div>
            <p className="card__note">
              公司钱包按地址锁定，由管理员自己添加：持仓排名会变，外部钱包也可能挤进前几名，按名次计算会算错。用新钱包买入后，进入管理即可把它加进来。
            </p>
            {config.adminEnabled ? (
              <>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <input
                    type="password"
                    placeholder="管理员密钥"
                    value={adminKey}
                    onChange={(e) => setAdminKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && adminKey && void verify()}
                    style={{ flex: 1, height: 40, padding: '0 10px', borderRadius: 10, border: '1px solid var(--line-strong)', background: 'rgba(2,10,26,.7)', minWidth: 0 }}
                    aria-label="管理员密钥"
                  />
                  <button type="button" className="btn btn--solid" style={{ height: 40 }} disabled={!adminKey || busy} onClick={() => verify()}>
                    进入管理
                  </button>
                </div>
                <label className="checkbox">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  在这台手机上记住密钥（自己的手机才勾选）
                </label>
              </>
            ) : (
              <p className="card__note">如需在 App 内修改，请在服务器 .env 中设置 ADMIN_KEY（至少 6 位）后重启服务。</p>
            )}
            {err && <div className="error">{err}</div>}
          </>
        )}
      </Card>

      {isAdmin && <AccessSettingsCard adminKey={adminKey} />}

      {isAdmin && <BurnTool />}

      <Card kicker="Server" title="数据服务器">
        <div className="field">
          <label htmlFor="server">服务器地址（留空 = 当前网址）</label>
          <input id="server" placeholder="https://your-server.com" value={server} onChange={(e) => setServer(e.target.value)} />
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setServerBase(server);
            reconnectNow();
            toast('已切换服务器');
          }}
        >
          保存并重连
        </button>
        <p className="card__note">打包成手机 App 或前后端分开部署时才需要填写。</p>
      </Card>

      <Card kicker="About" title="关于">
        <p className="card__note" style={{ marginTop: 0 }}>
          VectorKeith 公司资产 App v1.4 · 吉祥物、公司目标、办公室大屏、年度报告 · 数据直接来自 Solana 主网：成交来自 pump.fun 程序事件（logsSubscribe），池子与公司钱包余额来自账户订阅（accountSubscribe），持仓排名来自 getProgramAccounts；SOL 价格来自 Binance / Coinbase / Jupiter，人民币汇率来自 CoinGecko。
        </p>
      </Card>
    </>
  );
}
