import { Bell, BellOff, BellRing, Send, Share } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PushPrefs, PushSettings } from '../../../shared/types';
import { postJSON } from '../lib/api';
import { currentSubscription, disablePush, enablePush, pushStatus, pushSupport, testPush, updatePushPrefs } from '../lib/push';
import { useStore } from '../lib/store';
import { Card, toast } from './ui';

const DEFAULT_PREFS: PushPrefs = { flow: true, trade: false, poison: true, payout: true, badge: true };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

/** 手机推送提醒：开启 / 关闭、提醒类型、测试；管理员可设置提醒金额 */
export function PushCard({ isAdmin, adminKey }: { isAdmin: boolean; adminKey: string }) {
  const support = useMemo(pushSupport, []);
  const role = useStore((s) => s.access?.role ?? 'public');
  const [state, setState] = useState<'loading' | 'off' | 'on'>('loading');
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [prefs, setPrefsState] = useState<PushPrefs>(DEFAULT_PREFS);
  const [minSol, setMinSol] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rules, setRules] = useState<PushSettings | null>(null);
  const [minIn, setMinIn] = useState('');
  const [lowIn, setLowIn] = useState('');

  useEffect(() => {
    if (!support.ok) return setState('off');
    let cancelled = false;
    (async () => {
      try {
        const s = await withTimeout(currentSubscription(), 6000);
        if (!s) return !cancelled && setState('off');
        const st = await pushStatus(s.endpoint);
        if (cancelled) return;
        setSub(s);
        setMinSol(st.minSol);
        if (st.subscribed) {
          setPrefsState(st.prefs);
          setState('on');
        } else setState('off');
      } catch {
        if (!cancelled) setState('off');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [support.ok]);

  useEffect(() => {
    if (!isAdmin) return;
    postJSON<PushSettings>('/api/admin/push', {}, adminKey)
      .then((r) => {
        setRules(r);
        setMinIn(String(r.minSol));
        setLowIn(String(r.lowSol));
      })
      .catch(() => {});
  }, [isAdmin, adminKey, state]);

  const run = async (fn: () => Promise<void>) => {
    setErr('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    run(async () => {
      const r = await enablePush(prefs); // 第一步就是弹出通知权限（iPhone 要求在点击里直接发起）
      setSub(r.sub);
      setPrefsState(r.prefs);
      setState('on');
      toast('提醒已开启');
      testPush(r.sub.endpoint).catch(() => {});
    });

  const disable = () =>
    run(async () => {
      if (sub) await disablePush(sub);
      setSub(null);
      setState('off');
      toast('提醒已关闭');
    });

  const toggle = (k: keyof PushPrefs) =>
    run(async () => {
      if (!sub) return;
      const next = { ...prefs, [k]: !prefs[k] };
      setPrefsState(next);
      await updatePushPrefs(sub, next);
    });

  const saveRules = () =>
    run(async () => {
      const r = await postJSON<PushSettings>('/api/admin/push', { minSol: Number(minIn), lowSol: Number(lowIn || 0) }, adminKey);
      setRules(r);
      setMinSol(r.minSol);
      toast('提醒规则已保存');
    });

  const min = rules?.minSol ?? minSol;
  const minText = min === null ? '' : `（≥ ${min} SOL）`;
  const items: { k: keyof PushPrefs; label: string; hint: string }[] = [
    { k: 'flow', label: `公司钱包转入、转出${minText}`, hint: '包括总资产过低提醒' },
    { k: 'trade', label: `买卖代币${minText}`, hint: '公司钱包用 SOL 买入或卖出代币' },
    { k: 'poison', label: '地址投毒警告', hint: '有人冒充你常用的地址给公司钱包转账' },
    { k: 'badge', label: '解锁成就、达成目标', hint: '成就墙解锁新徽章、公司达成管理员设定的目标时' },
    {
      k: 'payout',
      label: role === 'holder' ? '我的分红到账' : role === 'member' ? '内部质押：充值 / 分息 / 赎回到账' : role === 'admin' ? '分红发放、员工充值、赎回申请' : '分红发放',
      hint: role === 'holder' ? '公司给你发分红时' : role === 'member' ? '你的充值到账、分息到账、赎回到账时' : role === 'admin' ? '发给股东的分红、员工充值到账、员工申请赎回' : '只有管理员、股东和员工本人会收到',
    },
  ];

  return (
    <Card
      kicker="Notifications"
      title="手机提醒"
      right={
        <span className={`chip ${state === 'on' ? 'chip--accent' : ''}`}>
          {state === 'on' ? <BellRing size={11} /> : <Bell size={11} />} {state === 'on' ? '已开启' : state === 'loading' ? '…' : '未开启'}
        </span>
      }
    >
      {!support.ok && support.reason === 'ios-install' && (
        <div className="steps">
          <p style={{ margin: '0 0 8px' }}>iPhone 要先把 App 添加到主屏幕，才能收到提醒（需要 iOS 16.4 或更新）：</p>
          <ol>
            <li>
              用 Safari 打开本页，点底部的 <Share size={13} style={{ verticalAlign: -2 }} />「分享」按钮
            </li>
            <li>选「添加到主屏幕」</li>
            <li>从主屏幕上的 VectorKeith 图标打开，回到这里点「开启提醒」</li>
          </ol>
        </div>
      )}
      {!support.ok && support.reason === 'unsupported' && <p className="card__note">这个浏览器不支持推送提醒。iPhone 请用 Safari 添加到主屏幕后打开；安卓请用 Chrome。</p>}
      {!support.ok && support.reason === 'insecure' && <p className="card__note">需要通过 https 网址打开 App 才能开启提醒。</p>}
      {!support.ok && support.reason === 'dev' && <p className="card__note">开发模式下不支持推送（部署后可用）。</p>}

      {support.ok && state === 'off' && (
        <>
          <p className="card__note" style={{ marginTop: 0 }}>
            公司钱包有大额转入转出、发现地址投毒、分红发放时，手机会收到通知（App 不用开着）。
          </p>
          <button type="button" className="btn btn--solid" style={{ width: '100%', marginTop: 10 }} disabled={busy} onClick={enable}>
            <Bell size={15} /> {busy ? '正在开启…' : '开启提醒'}
          </button>
        </>
      )}

      {support.ok && state === 'on' && (
        <>
          <div className="toggles">
            {items.map((it) => (
              <label key={it.k} className="toggle">
                <span>
                  {it.label}
                  <em>{it.hint}</em>
                </span>
                <input type="checkbox" role="switch" checked={prefs[it.k]} disabled={busy} onChange={() => toggle(it.k)} />
              </label>
            ))}
          </div>
          <div className="wm__actions">
            <button type="button" className="btn" disabled={busy} onClick={() => run(async () => (sub ? (await testPush(sub.endpoint), toast('测试通知已发出，几秒内会收到')) : undefined))}>
              <Send size={14} /> 发一条测试
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={disable}>
              <BellOff size={14} /> 关闭提醒
            </button>
          </div>
        </>
      )}

      {isAdmin && rules && (
        <div className="wm__section" style={{ marginTop: 14 }}>
          <div className="wm__title">提醒规则（管理员 · 已开启提醒的设备 {rules.subscribers} 台）</div>
          <div className="grid-form">
            <div className="field">
              <label htmlFor="push-min">单笔变动达到多少 SOL 才提醒</label>
              <input id="push-min" inputMode="decimal" value={minIn} onChange={(e) => setMinIn(e.target.value.replace(/[^\d.]/g, ''))} />
            </div>
            <div className="field">
              <label htmlFor="push-low">总资产低于多少 SOL 时提醒（0 = 不提醒）</label>
              <input id="push-low" inputMode="decimal" value={lowIn} onChange={(e) => setLowIn(e.target.value.replace(/[^\d.]/g, ''))} />
            </div>
          </div>
          <button type="button" className="btn" disabled={busy || (String(rules.minSol) === minIn && String(rules.lowSol) === (lowIn || '0'))} onClick={saveRules}>
            保存规则
          </button>
        </div>
      )}
      {err && <div className="error">{err}</div>}
    </Card>
  );
}
