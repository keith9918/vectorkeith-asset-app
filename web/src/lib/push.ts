// 手机推送提醒（Web Push）：iPhone 需要先把 App 添加到主屏幕（iOS 16.4 及以上），安卓 / 电脑浏览器直接可用
import type { PushPrefs } from '../../../shared/types';
import { getJSON, postJSON } from './api';

export type PushSupport = { ok: true } | { ok: false; reason: 'ios-install' | 'unsupported' | 'insecure' | 'dev' };

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  if (!import.meta.env.PROD) return { ok: false, reason: 'dev' };
  if (isIOS() && !isStandalone()) return { ok: false, reason: 'ios-install' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { ok: false, reason: 'unsupported' };
  return { ok: true };
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows 电脑';
  if (/Macintosh/.test(ua)) return 'Mac';
  return '浏览器';
}

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array) {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  if (!(await navigator.serviceWorker.getRegistration())) await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  return (await registration()).pushManager.getSubscription();
}

/** 开启提醒：必须在用户点击里直接调用（iPhone 要求先弹出通知权限） */
export async function enablePush(prefs?: Partial<PushPrefs>): Promise<{ sub: PushSubscription; prefs: PushPrefs }> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(perm === 'denied' ? '通知权限被拒绝了：请到手机「设置 → 通知」里找到 VectorKeith，打开"允许通知"后再试' : '需要允许通知才能开启提醒');
  }
  const reg = await registration();
  const { publicKey } = await getJSON<{ publicKey: string }>('/api/push/key');
  const key = b64uToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe(); // 服务器换过密钥：旧订阅收不到，重新订阅
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const r = await postJSON<{ prefs: PushPrefs }>('/api/push/subscribe', { subscription: sub.toJSON(), prefs, device: deviceName() });
  return { sub, prefs: r.prefs };
}

export async function updatePushPrefs(sub: PushSubscription, prefs: PushPrefs) {
  return postJSON<{ prefs: PushPrefs }>('/api/push/subscribe', { subscription: sub.toJSON(), prefs, device: deviceName() });
}

export async function disablePush(sub: PushSubscription) {
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  await postJSON('/api/push/unsubscribe', { endpoint }).catch(() => {});
}

export function pushStatus(endpoint: string) {
  return getJSON<{ subscribed: boolean; prefs: PushPrefs; minSol: number }>(`/api/push/status?endpoint=${encodeURIComponent(endpoint)}`);
}

export function testPush(endpoint: string) {
  return postJSON('/api/push/test', { endpoint });
}
