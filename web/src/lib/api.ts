// API 地址：默认同源；打包成原生 App 或前后端分离部署时，可在「设置」里填服务器地址
import type { TokenInfo } from '../../../shared/types';

const SERVER_KEY = 'vk.server';

export function getServerBase(): string {
  let v = '';
  try {
    v = localStorage.getItem(SERVER_KEY) ?? '';
  } catch {
    /* ignore */
  }
  return (v || import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
}

export function setServerBase(url: string) {
  try {
    if (url) localStorage.setItem(SERVER_KEY, url.trim());
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    /* ignore */
  }
}

export const apiUrl = (path: string) => getServerBase() + path;

// ─── 登录令牌（输入访问码后服务器发的；"需要访问码"模式下所有数据请求都要带上） ───
const TOKEN_KEY = 'vk.token';

export function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** persist = false：只在本次打开期间有效（别人的手机上登录时用） */
export function saveToken(token: string, persist = true) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    if (persist) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式等情况下不保存 */
  }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function wsUrl(): string {
  const base = getServerBase();
  const token = loadToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  if (base) return base.replace(/^http/, 'ws') + '/ws' + q;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws${q}`;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public needLogin = false,
  ) {
    super(message);
  }
}

/** 服务器说"需要访问码"时通知状态仓库（由 store.ts 设置，避免循环引用） */
let needLoginHandler: (() => void) | null = null;
export function onNeedLogin(fn: () => void) {
  needLoginHandler = fn;
}

function headers(adminKey?: string, json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  const token = loadToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (adminKey) h['X-Admin-Key'] = adminKey;
  return h;
}

async function parse<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (json.needLogin) needLoginHandler?.();
    throw new ApiError(res.status, json.error ?? `请求失败 ${res.status}`, !!json.needLogin);
  }
  return json as T;
}

export async function getJSON<T>(path: string): Promise<T> {
  return parse<T>(await fetch(apiUrl(path), { headers: headers() }));
}

/** adminKey 可省略：管理员登录后的令牌本身也能调用管理接口 */
export async function postJSON<T>(path: string, body: unknown, adminKey = ''): Promise<T> {
  return parse<T>(await fetch(apiUrl(path), { method: 'POST', headers: headers(adminKey, true), body: JSON.stringify(body ?? {}) }));
}

export function tokenImage(token: TokenInfo | null | undefined): string {
  if (token?.image) return token.image.startsWith('/') ? apiUrl(token.image) : token.image;
  return '/icons/icon-192.png';
}

export const solscan = {
  account: (a: string) => `https://solscan.io/account/${a}`,
  token: (a: string) => `https://solscan.io/token/${a}`,
  tx: (s: string) => `https://solscan.io/tx/${s}`,
};
