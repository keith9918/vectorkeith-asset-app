import { Copy, ExternalLink } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { solscan } from '../lib/api';
import { shortAddr } from '../lib/format';

export function Card(props: {
  kicker?: string;
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
  id?: string;
}) {
  return (
    <section id={props.id} className={`card ${props.flush ? 'card--flush' : ''} ${props.className ?? ''}`}>
      {(props.kicker || props.title || props.right) && (
        <header className="card__head">
          <div>
            {props.kicker && <div className="kicker">{props.kicker}</div>}
            {props.title && <h2 className="card__title" style={{ margin: 0 }}>{props.title}</h2>}
          </div>
          {props.right}
        </header>
      )}
      {props.children}
    </section>
  );
}

export function Tile(props: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string; valueClass?: string }) {
  return (
    <div className={`tile ${props.className ?? ''}`}>
      <div className="tile__label">{props.label}</div>
      <div className={`tile__value ${props.valueClass ?? ''}`}>{props.value}</div>
      {props.sub !== undefined && <div className="tile__sub">{props.sub}</div>}
    </div>
  );
}

export function Seg<T extends string>(props: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Meter(props: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(1, props.value)) * 100;
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={props.label}>
      <div className="meter__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ChangeChip({ v, digits = 2 }: { v: number; digits?: number }) {
  if (!Number.isFinite(v)) return <span className="chip">—</span>;
  const cls = v > 0 ? 'chip--up' : v < 0 ? 'chip--down' : '';
  return (
    <span className={`chip ${cls} num`}>
      {v > 0 ? '▲ ' : v < 0 ? '▼ ' : ''}
      {(Math.abs(v) * 100).toFixed(digits)}%
    </span>
  );
}

// ─── 复制 & 提示 ──────────────────────────────────────────────

let toastSetter: ((m: string) => void) | null = null;
export function toast(msg: string) {
  toastSetter?.(msg);
}

export function ToastHost() {
  const [msg, setMsg] = useState('');
  useEffect(() => {
    toastSetter = setMsg;
    return () => {
      toastSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(''), 1600);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null;
}

/**
 * 旧式复制。用于非 HTTPS（例如手机通过局域网 http 访问）时 navigator.clipboard 不可用的情况。
 * iPhone Safari 要求 readonly + setSelectionRange 才能真正选中文本，否则 execCommand 会静默失败。
 */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', ''); // 不弹出键盘
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  window.getSelection()?.removeAllRanges();
  return ok;
}

export async function copyText(text: string, label = '已复制') {
  let ok = false;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (!ok) ok = legacyCopy(text);
  if (ok) toast(label);
  else window.prompt('自动复制失败，请长按下面的内容手动复制：', text);
}

export function Address(props: { address: string; n?: number; link?: 'account' | 'token' | 'tx'; full?: boolean; className?: string }) {
  const href = solscan[props.link ?? 'account'](props.address);
  return (
    <span className={`addr ${props.className ?? ''}`}>
      <span title={props.address}>{props.full ? props.address : shortAddr(props.address, props.n ?? 4)}</span>
      <button type="button" className="addr__btn" aria-label="复制地址" onClick={() => copyText(props.address, '地址已复制')}>
        <Copy size={13} />
      </button>
      <a className="addr__btn" href={href} target="_blank" rel="noreferrer" aria-label="在 Solscan 查看">
        <ExternalLink size={13} />
      </a>
    </span>
  );
}
