// 数字 / 金额 / 时间格式化
export type Cur = 'cny' | 'usd' | 'sol';

const SUBS = '₀₁₂₃₄₅₆₇₈₉';
const subscript = (n: number) => [...String(n)].map((d) => SUBS[Number(d)]).join('');

export function fmtNum(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtInt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

/** 极小数字的下标零写法：0.000003785 → 0.0₅3785（链上代币价格的通用写法） */
export function fmtTiny(v: number, sig = 4): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1) return sign + fmtNum(a, a >= 1000 ? 2 : 4);
  let exp = Math.floor(Math.log10(a));
  let digits = (a / 10 ** exp).toFixed(sig - 1);
  if (digits.startsWith('10')) {
    exp += 1;
    digits = (a / 10 ** exp).toFixed(sig - 1);
  }
  const zeros = -exp - 1;
  if (zeros >= 4) {
    const d = digits.replace('.', '').replace(/0+$/, '') || '0';
    return `${sign}0.0${subscript(zeros)}${d}`;
  }
  return sign + a.toFixed(Math.min(20, zeros + sig)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function fmtCompact(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(digits) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(digits) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(digits) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(digits) + 'K';
  return fmtNum(v, a >= 100 ? 0 : 2);
}

export function fmtSol(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return fmtNum(v, 2);
  if (a >= 0.001 || a === 0) return fmtNum(v, 4);
  return fmtTiny(v);
}

export const CUR_SYMBOL: Record<Cur, string> = { cny: '¥', usd: '$', sol: '' };
export const CUR_NAME: Record<Cur, string> = { cny: '人民币', usd: '美元', sol: 'SOL' };

/** 金额：¥ / $ / SOL。极小金额自动用下标零写法 */
export function fmtMoney(v: number, cur: Cur, opts: { compact?: boolean; digits?: number } = {}): string {
  if (!Number.isFinite(v)) return '—';
  if (cur === 'sol') return `${opts.compact ? fmtCompact(v) : fmtSol(v)} SOL`;
  const a = Math.abs(v);
  let body: string;
  if (opts.compact && a >= 1e4) body = fmtCompact(a);
  else if (a > 0 && a < 0.01) body = fmtTiny(a);
  else body = fmtNum(a, opts.digits ?? 2);
  return `${v < 0 ? '-' : ''}${CUR_SYMBOL[cur]}${body}`;
}

/** 单价：$0.0₅3798 / ¥0.0₄2534 / 0.0₇5253 SOL */
export function fmtPrice(v: number, cur: Cur): string {
  if (!Number.isFinite(v)) return '—';
  return cur === 'sol' ? `${fmtTiny(v)} SOL` : `${CUR_SYMBOL[cur]}${fmtTiny(v)}`;
}

/** v 为比例（0.1 = 10%） */
export function fmtPct(v: number, digits = 2, signed = false): string {
  if (!Number.isFinite(v)) return '—';
  const s = `${(v * 100).toFixed(digits)}%`;
  return signed && v > 0 ? `+${s}` : s;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function fmtClock(ms: number, withMs = false): string {
  const d = new Date(ms);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

export function fmtDate(ms: number, withTime = true): string {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day} ${fmtClock(ms)}` : day;
}

export function fmtShortDate(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${Math.floor(s)} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export const shortAddr = (a: string | null | undefined, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : '—');
