// 管理员：密钥存储（可选"在本机记住"）+ 公司钱包配置
import type { AppConfig, WalletPreview } from '../../../shared/types';
import { getJSON, postJSON } from './api';

const KEY = 'vk.admin';

export function loadAdminKey(): string {
  try {
    return localStorage.getItem(KEY) ?? sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveAdminKey(key: string, remember: boolean) {
  try {
    sessionStorage.setItem(KEY, key);
    if (remember) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
  } catch {
    /* 隐私模式等情况下不保存 */
  }
}

export function clearAdminKey() {
  try {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export type ConfigPatch = Partial<Pick<AppConfig, 'companyWallets' | 'dividendRatio'>>;

/** 保存配置；服务器会把新配置实时推送给所有已打开的 App */
export function saveConfig(patch: ConfigPatch, adminKey: string) {
  return postJSON<AppConfig>('/api/admin/config', patch, adminKey);
}

/** 添加前预览：余额、交易数量 */
export function previewWallet(address: string) {
  return getJSON<WalletPreview>(`/api/wallet/preview?address=${encodeURIComponent(address.trim())}`);
}

/** 下一个未使用的默认名称 */
export function nextWalletLabel(config: AppConfig): string {
  const used = new Set(config.companyWallets.map((w) => w.label));
  if (!used.has('公司钱包')) return '公司钱包';
  for (let n = 2; ; n++) if (!used.has(`公司钱包 ${n}`)) return `公司钱包 ${n}`;
}

export function looksLikeAddress(s: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
}
