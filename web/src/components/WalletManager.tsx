import { ClipboardPaste, LogOut, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { WalletPreview } from '../../../shared/types';
import { looksLikeAddress, nextWalletLabel, previewWallet, saveConfig, type ConfigPatch } from '../lib/admin';
import { fmtDate, fmtMoney, fmtNum, fmtPct, shortAddr } from '../lib/format';
import { useSolTo } from '../lib/hooks';
import { useStore } from '../lib/store';
import { useCur } from './Shell';
import { Address, toast } from './ui';

type PreviewState = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; data: WalletPreview } | { state: 'error'; error: string };

/** 公司钱包管理：公司资产 = 这些钱包里的 SOL */
export function WalletManager(props: { adminKey: string; prefill: string; onLogout: () => void }) {
  const snap = useStore((s) => s.snap);
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const [addr, setAddr] = useState(props.prefill);
  const [label, setLabel] = useState('');
  const [ratio, setRatio] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' });
  const addRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.prefill) return;
    setAddr(props.prefill);
    setTimeout(() => addRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
  }, [props.prefill]);

  // 输入地址后自动预览：余额、交易数量
  useEffect(() => {
    const a = addr.trim();
    if (!a) return setPreview({ state: 'idle' });
    if (!looksLikeAddress(a)) return setPreview({ state: 'error', error: '地址格式不对：Solana 钱包地址是 32–44 位的字母数字串' });
    setPreview({ state: 'loading' });
    let cancelled = false;
    const id = setTimeout(() => {
      previewWallet(a)
        .then((data) => !cancelled && setPreview({ state: 'ok', data }))
        .catch((e) => !cancelled && setPreview({ state: 'error', error: (e as Error).message }));
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [addr]);

  if (!snap) return null;
  const config = snap.config;
  const t = snap.treasury;
  const live = new Map(t.wallets.map((w) => [w.address, w]));
  const target = preview.state === 'ok' ? preview.data.address : '';
  const already = !!target && config.companyWallets.some((w) => w.address === target);
  const canAdd = preview.state === 'ok' && !already && !busy;

  const run = async (patch: ConfigPatch, ok: string) => {
    setErr('');
    setBusy(true);
    try {
      await saveConfig(patch, props.adminKey);
      toast(ok);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (preview.state !== 'ok') return;
    const l = label.trim() || nextWalletLabel(config);
    if (await run({ companyWallets: [...config.companyWallets, { address: preview.data.address, label: l }] }, `已添加 ${l}，公司资产已实时更新`)) {
      setAddr('');
      setLabel('');
      if (location.hash.includes('?')) location.hash = '#/settings';
    }
  };

  const remove = (address: string, l: string) => {
    const msg =
      config.companyWallets.length <= 1
        ? `把最后一个公司钱包 ${l} 移除？移除后公司总资产会显示为 0。`
        : `把 ${l}（${shortAddr(address, 6)}）移出公司钱包？它里面的 SOL 将不再计入公司资产。`;
    if (confirm(msg)) void run({ companyWallets: config.companyWallets.filter((w) => w.address !== address) }, `已移除 ${l}`);
  };

  const rename = (address: string, l: string) => {
    const name = prompt('新的钱包名称', l)?.trim();
    if (!name || name === l) return;
    void run({ companyWallets: config.companyWallets.map((w) => (w.address === address ? { ...w, label: name } : w)) }, '已改名');
  };

  const saveRatio = () => {
    const r = Number(ratio) / 100;
    if (!(r >= 0 && r <= 1)) return setErr('分红比例需在 0–100 之间');
    void run({ dividendRatio: r }, `分红比例已改为 ${fmtPct(r, 0)}`).then((ok) => ok && setRatio(''));
  };

  const paste = async () => {
    try {
      const v = (await navigator.clipboard.readText()).trim();
      if (v) setAddr(v);
    } catch {
      toast('请长按输入框粘贴');
    }
  };

  return (
    <div className="wm">
      {/* ─── 当前名单 ─── */}
      <div className="wm__section">
        <div className="wm__title">当前公司钱包（{config.companyWallets.length} 个）</div>
        {config.companyWallets.length === 0 && <div className="muted" style={{ fontSize: 12.5, padding: '6px 0' }}>还没有公司钱包，在下面添加。</div>}
        {config.companyWallets.map((w) => {
          const lw = live.get(w.address);
          const sol = lw && Number.isFinite(lw.sol) ? lw.sol : null;
          return (
            <div key={w.address} className="row">
              <div style={{ minWidth: 0 }}>
                <button type="button" className="wm__label" onClick={() => rename(w.address, w.label)} aria-label={`给 ${w.label} 改名`}>
                  {w.label} <Pencil size={11} />
                </button>
                <div>
                  <Address address={w.address} />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="mono dim" style={{ fontSize: 12, textAlign: 'right' }}>
                  {sol === null ? '读取中…' : `${fmtNum(sol, 4)} SOL`}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {sol === null ? '' : fmtMoney(sol * solTo[primary], primary)}
                  </div>
                </span>
                <button type="button" className="icon-btn" style={{ width: 32, height: 32 }} aria-label={`移除 ${w.label}`} disabled={busy} onClick={() => remove(w.address, w.label)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ─── 新增 ─── */}
      <div ref={addRef} className="wm__section">
        <div className="wm__title">
          <Plus size={15} /> 新增公司钱包
        </div>
        <div className="field" style={{ marginBottom: 8 }}>
          <label htmlFor="wm-addr">钱包地址</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id="wm-addr"
              value={addr}
              onChange={(e) => setAddr(e.target.value.trim())}
              placeholder="粘贴钱包地址"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              style={{ fontFamily: 'var(--font-code)', fontSize: 13 }}
            />
            <button type="button" className="icon-btn" style={{ height: 40, width: 40 }} aria-label="从剪贴板粘贴" onClick={paste}>
              <ClipboardPaste size={16} />
            </button>
          </div>
        </div>
        <div className="field" style={{ marginBottom: 8 }}>
          <label htmlFor="wm-label">名称（可不填）</label>
          <input id="wm-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={nextWalletLabel(config)} maxLength={24} />
        </div>

        {preview.state === 'loading' && <div className="addr-preview addr-preview--info">正在读取链上信息…</div>}
        {preview.state === 'error' && <div className="addr-preview addr-preview--warn">{preview.error}</div>}
        {preview.state === 'ok' && (
          <div className={`addr-preview ${already ? 'addr-preview--info' : 'addr-preview--ok'}`} role="status">
            {preview.data.note && <div>{preview.data.note}</div>}
            {already ? (
              <div>这个钱包已经是公司钱包。</div>
            ) : (
              <>
                <div>
                  钱包 <b>{shortAddr(preview.data.address, 6)}</b> 现有 <b>{fmtNum(preview.data.sol, 4)} SOL</b>（{fmtMoney(preview.data.sol * solTo[primary], primary)} · {fmtMoney(preview.data.sol * solTo[secondary], secondary)}）
                </div>
                <div className="muted">
                  {preview.data.txCount
                    ? `交易记录 ${preview.data.txCount >= 1000 ? '1000+' : preview.data.txCount} 笔${preview.data.firstTs && preview.data.txCount < 1000 ? `，最早 ${fmtDate(preview.data.firstTs * 1000, false)}` : ''}`
                    : '链上还没有交易记录'}
                </div>
                {!preview.data.isSystemAccount && <div>注意：这个地址不是普通钱包（由程序控制），确认无误再添加。</div>}
                <div className="muted">添加后，它里面的 SOL 会计入公司资产。</div>
              </>
            )}
          </div>
        )}
        <button type="button" className="btn btn--solid" style={{ width: '100%', marginTop: 10 }} disabled={!canAdd} onClick={add}>
          添加为公司钱包
        </button>
      </div>

      {/* ─── 分红 & 其他 ─── */}
      <div className="wm__section">
        <div className="field" style={{ marginBottom: 8 }}>
          <label htmlFor="ratio">股东分红比例（占总资产 %，当前 {fmtPct(config.dividendRatio, 0)}）</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input id="ratio" inputMode="decimal" placeholder={String(+(config.dividendRatio * 100).toFixed(4))} value={ratio} onChange={(e) => setRatio(e.target.value.replace(/[^\d.]/g, ''))} />
            <button type="button" className="btn" disabled={busy || !ratio} onClick={saveRatio}>
              保存
            </button>
          </div>
        </div>
        <button type="button" className="btn btn--ghost" onClick={props.onLogout}>
          <LogOut size={15} /> 退出管理
        </button>
      </div>

      {err && <div className="error">{err}</div>}
    </div>
  );
}
