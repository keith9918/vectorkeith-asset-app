// VK 链：App 内钱包（创建 / 导入 / 备份 / 领取 VK / 转账 / 收款）+ 发行资产（以及增发 / 销毁 / 放弃增发权）
import { Droplets, Eye, ImagePlus, KeyRound, QrCode, Send, ShieldCheck, Sparkles, Trash2, Upload, Wallet } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChainAddressView, ChainOverview, ChainToken } from '../../../shared/chain';
import {
  bumpChain,
  chainApi,
  chainLink,
  createWallet,
  fmtAmount,
  fmtVk,
  forgetWallet,
  importWallet,
  isAddress,
  markBackedUp,
  useChainAddress,
  useWallet,
  type LocalWallet,
} from '../lib/chain';
import { fmtAgo, shortAddr } from '../lib/format';
import { fx } from '../lib/fx';
import { useNow } from '../lib/hooks';
import { AddrLink, ConfirmPanel, CopyBtn, SignerStatus, TokenIcon, TxList, VkCoin, chainGo, useSigner } from './ChainBits';
import { Card, Seg, copyText, toast } from './ui';

// ─── 没有钱包：创建 / 导入 ───────────────────────────────────

function ImportForm({ onDone, replace }: { onDone?: () => void; replace?: boolean }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  return (
    <div style={{ marginTop: 12 }}>
      <div className="field">
        <label htmlFor="ch-import">私钥（Base58，Phantom / Solflare 导出的格式；或密钥文件里的数字数组）</label>
        <textarea id="ch-import" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴私钥" autoComplete="off" spellCheck={false} />
      </div>
      {err && (
        <div className="addr-preview addr-preview--warn" role="alert" style={{ marginBottom: 10 }}>
          {err}
        </div>
      )}
      <button
        type="button"
        className="btn btn--solid"
        disabled={!text.trim()}
        onClick={() => {
          if (replace && !confirm('导入后会替换这台设备上现在的钱包。现在的钱包如果没有备份私钥，将无法找回。继续吗？')) return;
          try {
            const w = importWallet(text);
            setText('');
            toast(`已导入 ${shortAddr(w.address, 4)}`);
            onDone?.();
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        <Upload size={15} /> 导入
      </button>
    </div>
  );
}

function NoWallet() {
  const [importing, setImporting] = useState(false);
  return (
    <Card className="hero-card" kicker="VK 链钱包" title="先创建一个钱包">
      <div className="glow-orb" aria-hidden />
      <ul className="ch-bullets">
        <li>用来领取 VK、转账、发行自己的资产；每笔交易的 gas 都用 VK 支付</li>
        <li>私钥只保存在这台设备的浏览器里，签名也在本机完成，服务器拿不到</li>
        <li>清除浏览器数据或换手机会丢失钱包：创建后请马上备份私钥</li>
      </ul>
      <div className="ch-actions" style={{ justifyContent: 'flex-start' }}>
        <button
          type="button"
          className="btn btn--solid"
          onClick={() => {
            const w = createWallet();
            toast(`钱包已创建 ${shortAddr(w.address, 4)}`);
          }}
        >
          <Wallet size={15} /> 创建新钱包
        </button>
        <button type="button" className="btn" aria-expanded={importing} onClick={() => setImporting((v) => !v)}>
          <Upload size={15} /> 导入已有钱包
        </button>
      </div>
      {importing && <ImportForm />}
    </Card>
  );
}

// ─── 转账 / 收款 / 备份 ──────────────────────────────────────

function SendForm({ w, av }: { w: LocalWallet; av: ChainAddressView | null }) {
  const s = useSigner();
  const [asset, setAsset] = useState('VK');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const tokens = (av?.tokens ?? []).filter((t) => t.amount > 0);
  const tok = tokens.find((t) => t.mint === asset);
  const bal = asset === 'VK' ? (av?.vk ?? 0) : (tok?.amount ?? 0);
  const max = asset === 'VK' ? Math.max(0, +(bal - 0.00001).toFixed(9)) : bal;
  const toOk = isAddress(to.trim());
  const amt = Number(amount);
  const canNext = toOk && amt > 0 && amt <= bal && !s.busy && !s.prep;
  return (
    <Card kicker="转账" title="发送 VK 或资产">
      <div className="ch-assetpick" role="group" aria-label="选择资产">
        <button type="button" aria-pressed={asset === 'VK'} onClick={() => setAsset('VK')}>
          <VkCoin size={18} /> VK
        </button>
        {tokens.map((t) => (
          <button key={t.mint} type="button" aria-pressed={asset === t.mint} onClick={() => setAsset(t.mint)}>
            <TokenIcon mint={t.mint} size={18} /> {t.symbol ?? shortAddr(t.mint, 3)}
          </button>
        ))}
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="ch-to">收款地址</label>
        <input id="ch-to" className="ch-mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="对方的 VK 链地址" autoComplete="off" spellCheck={false} />
        {to.trim() && !toOk && <span className="ch-hint ch-hint--bad">地址格式不对</span>}
      </div>
      <div className="field">
        <label htmlFor="ch-amt">
          数量 <span className="muted">（可用 {asset === 'VK' ? `${fmtVk(bal)} VK` : `${fmtAmount(bal, tok?.decimals)} ${tok?.symbol ?? ''}`}）</span>
        </label>
        <div className="ch-inline">
          <input id="ch-amt" className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" />
          <button type="button" className="btn btn--ghost" onClick={() => setAmount(String(max))} disabled={max <= 0}>
            全部
          </button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="ch-memo">备注（可选，会写在链上，所有人可见）</label>
        <input id="ch-memo" value={memo} maxLength={60} onChange={(e) => setMemo(e.target.value)} placeholder="例如：11 月奖励" />
      </div>
      {!s.prep && (
        <button type="button" className="btn btn--solid ch-wide" disabled={!canNext} onClick={() => void s.prepare({ kind: asset === 'VK' ? 'transfer' : 'token-transfer', to: to.trim(), amount, mint: asset === 'VK' ? undefined : asset, memo })}>
          <Send size={15} /> {s.busy ? '正在检查…' : '下一步'}
        </button>
      )}
      <ConfirmPanel s={s} title="确认转账" />
      <SignerStatus s={s} />
      {s.done && (
        <button
          type="button"
          className="btn btn--ghost"
          style={{ marginTop: 8 }}
          onClick={() => {
            s.reset();
            setAmount('');
            setMemo('');
          }}
        >
          再转一笔
        </button>
      )}
      <p className="card__note">每笔交易 gas 0.000005 VK；给从没收过这种资产的地址转账时，会顺便帮对方开一个账户（押金约 0.002 VK）。</p>
    </Card>
  );
}

function Receive({ w }: { w: LocalWallet }) {
  return (
    <Card kicker="收款" title="我的 VK 链地址">
      <button type="button" className="ch-bigaddr" onClick={() => void copyText(w.address, '地址已复制')}>
        {w.address}
      </button>
      <div className="ch-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn--solid" onClick={() => void copyText(w.address, '地址已复制')}>
          复制地址
        </button>
      </div>
      <p className="card__note">
        这是 VK 链上的地址。同一个地址在 Solana 主网上也存在（私钥相同），但两条链的资产互不相通：别人要在 VK 链上给你转账，才会到这里。
      </p>
    </Card>
  );
}

function Backup({ w }: { w: LocalWallet }) {
  const [shown, setShown] = useState(false);
  return (
    <Card kicker="备份" title="备份私钥">
      {!shown ? (
        <>
          <p className="ch-p">私钥就是这个钱包的全部：谁拿到私钥，谁就能动用钱包里的资产。请抄在纸上或存进密码管理器，不要发给任何人（包括客服）。</p>
          <button type="button" className="btn" onClick={() => setShown(true)}>
            <Eye size={15} /> 我明白，显示私钥
          </button>
        </>
      ) : (
        <>
          <div className="addr-preview addr-preview--warn ch-secret">{w.secret}</div>
          <div className="ch-actions" style={{ justifyContent: 'flex-start' }}>
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => {
                void copyText(w.secret, '私钥已复制，请妥善保存');
                markBackedUp();
              }}
            >
              复制私钥
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                markBackedUp();
                setShown(false);
                toast('已标记为已备份');
              }}
            >
              我已抄好
            </button>
          </div>
          <p className="card__note">这个私钥也可以导入 Phantom、Solflare 等钱包（网络选自定义 RPC，见「节点」页）。</p>
        </>
      )}
    </Card>
  );
}

// ─── 钱包首页 ────────────────────────────────────────────────

function WalletHome({ w, ov }: { w: LocalWallet; ov: ChainOverview | null }) {
  const { data: av, error } = useChainAddress(w.address, 6000);
  const [panel, setPanel] = useState<'' | 'send' | 'receive' | 'backup' | 'manage'>('');
  const [claiming, setClaiming] = useState(false);
  const now = useNow(1000);
  const nextAt = av?.faucetNextAt ?? 0;
  const faucetOn = !!ov?.faucet.enabled;
  const once = !!ov?.faucet.once;
  const claimedOnce = once && !!av?.faucetClaimed;
  const wait = nextAt > now ? nextAt - now : 0;
  const claim = async () => {
    setClaiming(true);
    try {
      const r = await chainApi.faucet(w.address);
      toast(`已到账 ${r.amount} VK`);
      fx.rain(40);
      bumpChain();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setClaiming(false);
    }
  };
  const toggle = (p: typeof panel) => setPanel((cur) => (cur === p ? '' : p));
  const totalMin = Math.ceil(wait / 60_000);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  const waitText = hh ? `${hh} 小时${mm ? ` ${mm} 分` : ''}后再领` : `${mm} 分钟后再领`;
  return (
    <>
      <Card className="hero-card" kicker="我的 VK 链钱包" right={<span className="chip chip--accent">VK Chain</span>}>
        <div className="glow-orb" aria-hidden />
        <div className="ch-walletaddr">
          <a className="ch-mono" href={chainLink.address(w.address)}>
            {shortAddr(w.address, 6)}
          </a>
          <CopyBtn text={w.address} label="地址已复制" />
        </div>
        <div className="hero-value num">
          {av ? fmtVk(av.vk) : '—'}
          <small> VK</small>
        </div>
        <div className="hero-sub">
          <span>
            资产 <b>{av ? av.tokens.length : '—'}</b> 种
          </span>
          <span>
            交易 <b>{av ? av.txs.length : '—'}</b> 笔
          </span>
          <span className="muted">VK 用来付 gas，不能兑换现金</span>
        </div>
        {error && <div className="addr-preview addr-preview--warn" style={{ marginTop: 10 }}>{error}</div>}
        <div className="ch-wbtns">
          <button type="button" className="ch-wbtn ch-wbtn--faucet" disabled={!faucetOn || claiming || wait > 0 || claimedOnce || !av} onClick={() => void claim()}>
            <Droplets size={18} />
            <span>{claiming ? '发放中…' : claimedOnce ? '已领过' : wait > 0 ? waitText : `领取 ${ov?.faucet.amount ?? 1} VK`}</span>
          </button>
          <button type="button" className="ch-wbtn" aria-pressed={panel === 'send'} onClick={() => toggle('send')}>
            <Send size={18} />
            <span>转账</span>
          </button>
          <button type="button" className="ch-wbtn" aria-pressed={panel === 'receive'} onClick={() => toggle('receive')}>
            <QrCode size={18} />
            <span>收款</span>
          </button>
          <button type="button" className="ch-wbtn" aria-pressed={panel === 'backup'} onClick={() => toggle('backup')}>
            <KeyRound size={18} />
            <span>备份</span>
          </button>
        </div>
        {!faucetOn && ov && <p className="card__note">水龙头暂停发放中（管理员可在「节点」页开启）。</p>}
        {faucetOn && once && ov && (
          <p className="card__note">
            每个新钱包可以领一次 {ov.faucet.amount} VK，够付约 {Math.floor(ov.faucet.amount / ov.feePerSig).toLocaleString()} 笔交易的 gas；需要更多 VK 请找管理员发放。
          </p>
        )}
      </Card>
      {!w.backedUp && panel !== 'backup' && (
        <div className="banner">
          <ShieldCheck size={16} style={{ flex: 'none', marginTop: 1 }} />
          <span>
            还没有备份私钥：清除浏览器数据或换手机，这个钱包就找不回了。{' '}
            <button type="button" className="ch-link" onClick={() => setPanel('backup')}>
              立即备份
            </button>
          </span>
        </div>
      )}
      {panel === 'send' && <SendForm w={w} av={av} />}
      {panel === 'receive' && <Receive w={w} />}
      {panel === 'backup' && <Backup w={w} />}
      <Card kicker="资产" title="钱包里的资产">
        <div className="ch-toklist">
          <div className="ch-tokrow">
            <VkCoin />
            <span className="ch-tokrow__name">
              <b>VK</b>
              <span className="muted">VK 链原生币 · 付 gas</span>
            </span>
            <span className="ch-tokrow__amt num">{av ? fmtVk(av.vk) : '—'}</span>
          </div>
          {av?.tokens.map((t) => (
            <a key={t.account} className="ch-tokrow" href={chainLink.address(t.mint)}>
              <TokenIcon mint={t.mint} />
              <span className="ch-tokrow__name">
                <b>{t.symbol ?? shortAddr(t.mint, 4)}</b>
                <span className="muted">{t.name ?? '资产'}</span>
              </span>
              <span className="ch-tokrow__amt num">{fmtAmount(t.amount, t.decimals)}</span>
            </a>
          ))}
        </div>
        {av && !av.tokens.length && (
          <p className="card__note">
            还没有其他资产。可以去{' '}
            <button type="button" className="ch-link" onClick={() => chainGo('issue')}>
              发行资产
            </button>{' '}
            发一个自己的币。
          </p>
        )}
      </Card>
      <Card kicker="记录" title="交易记录">
        <TxList txs={av?.txs ?? []} me={w.address} empty={av ? '还没有交易：先领取一点 VK 吧' : '加载中…'} />
      </Card>
      <Card kicker="钱包管理" title="切换 / 删除">
        <div className="ch-actions" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="btn" aria-expanded={panel === 'manage'} onClick={() => toggle('manage')}>
            <Upload size={15} /> 导入其他钱包
          </button>
          <button
            type="button"
            className="btn btn--ghost ch-danger"
            onClick={() => {
              const msg = w.backedUp
                ? '确定从这台设备上删除这个钱包吗？以后可以用备份的私钥重新导入。'
                : '这个钱包还没有备份私钥！删除后将永远无法找回里面的资产。确定删除吗？';
              if (confirm(msg) && (w.backedUp || confirm('再确认一次：删除没有备份的钱包？'))) {
                forgetWallet();
                toast('钱包已从这台设备删除');
              }
            }}
          >
            <Trash2 size={15} /> 删除钱包
          </button>
        </div>
        {panel === 'manage' && <ImportForm replace onDone={() => setPanel('')} />}
        <p className="card__note">
          钱包创建于 {new Date(w.createdAt).toLocaleString('zh-CN', { hour12: false })}，只保存在这台设备的浏览器里。
        </p>
      </Card>
    </>
  );
}

export function WalletTab({ ov }: { ov: ChainOverview | null }) {
  const w = useWallet();
  return w ? <WalletHome w={w} ov={ov} /> : <NoWallet />;
}

// ─── 发行资产 ────────────────────────────────────────────────

async function resizeImage(file: File, size = 128): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持图片处理');
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    // 能编码 WebP 就用 WebP（体积小得多）；iPhone Safari 不支持编码 WebP，会自动退回 PNG
    const webp = c.toDataURL('image/webp', 0.9);
    return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function IssueForm({ w }: { w: LocalWallet }) {
  const s = useSigner();
  const { data: av } = useChainAddress(w.address, 10_000);
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [supply, setSupply] = useState('1000000');
  const [decimals, setDecimals] = useState<'0' | '2' | '6' | '9'>('2');
  const [fixed, setFixed] = useState<'keep' | 'fixed'>('keep');
  const [icon, setIcon] = useState('');
  const [desc, setDesc] = useState('');
  const [created, setCreated] = useState<{ mint: string; name: string; symbol: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nameBytes = new TextEncoder().encode(name.trim()).length;
  const symOk = /^[A-Z0-9]{1,10}$/.test(symbol);
  const supOk = /^\d+(\.\d+)?$/.test(supply) && Number(supply) > 0 && (supply.split('.')[1]?.length ?? 0) <= Number(decimals);
  const lowVk = av != null && av.vk < 0.01;
  const ok = name.trim() && nameBytes <= 32 && symOk && supOk && !s.busy && !s.prep;
  const submit = () =>
    void s.prepare({ kind: 'token-create', name: name.trim(), symbol, supply, decimals: Number(decimals), fixed: fixed === 'fixed', icon: icon || undefined, description: desc.trim() || undefined });
  const confirmIt = async () => {
    const mint = s.prep?.mint;
    const r = await s.confirm();
    if (r && mint) {
      setCreated({ mint, name: name.trim(), symbol });
      fx.rain(70);
      setName('');
      setSymbol('');
      setIcon('');
      setDesc('');
    }
    return r;
  };
  return (
    <Card className="hero-card" kicker="发行资产 · Token-2022" title="一键发行你自己的币">
      <div className="glow-orb" aria-hidden />
      {created && (
        <div className="ch-created">
          <TokenIcon mint={created.mint} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="ch-created__t">
              {created.name}（{created.symbol}）发行成功 🎉
            </div>
            <div className="muted ch-mono" style={{ fontSize: 12 }}>
              资产地址 {shortAddr(created.mint, 6)} <CopyBtn text={created.mint} label="资产地址已复制" />
            </div>
            <a className="ch-link" href={chainLink.address(created.mint)}>
              查看资产页 →
            </a>
          </div>
        </div>
      )}
      <div className="ch-issue">
        <button type="button" className="ch-iconpick" onClick={() => fileRef.current?.click()} aria-label="上传图标">
          {icon ? <img src={icon} alt="" /> : <span>{symbol ? symbol.slice(0, 2) : <ImagePlus size={22} />}</span>}
          <em>{icon ? '换图标' : '上传图标'}</em>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              setIcon(await resizeImage(f));
            } catch {
              toast('这张图片读不出来，换一张试试');
            }
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="field">
            <label htmlFor="ch-name">名称（最多约 10 个汉字）</label>
            <input id="ch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：VectorKeith 积分" />
            {nameBytes > 32 && <span className="ch-hint ch-hint--bad">名称太长了</span>}
          </div>
          <div className="field">
            <label htmlFor="ch-sym">符号（1–10 个英文字母或数字）</label>
            <input id="ch-sym" className="ch-mono" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))} placeholder="例如：VKP" />
          </div>
        </div>
      </div>
      <div className="field">
        <label htmlFor="ch-sup">发行总量</label>
        <input id="ch-sup" className="input num" inputMode="decimal" value={supply} onChange={(e) => setSupply(e.target.value.replace(/[^\d.]/g, ''))} />
        {supply && !supOk && <span className="ch-hint ch-hint--bad">总量格式不对（小数位不能超过下面选的位数）</span>}
      </div>
      <div className="ch-optrow">
        <span className="muted">小数位</span>
        <Seg
          value={decimals}
          onChange={setDecimals}
          label="小数位"
          options={[
            { value: '0', label: '0（整数）' },
            { value: '2', label: '2' },
            { value: '6', label: '6' },
            { value: '9', label: '9' },
          ]}
        />
      </div>
      <div className="ch-optrow">
        <span className="muted">增发</span>
        <Seg
          value={fixed}
          onChange={setFixed}
          label="增发权限"
          options={[
            { value: 'keep', label: '保留增发权' },
            { value: 'fixed', label: '固定总量' },
          ]}
        />
      </div>
      <div className="field" style={{ marginTop: 4 }}>
        <label htmlFor="ch-desc">简介（可选）</label>
        <input id="ch-desc" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} placeholder="例如：员工内部奖励积分" />
      </div>
      {lowVk && (
        <div className="banner" style={{ marginBottom: 10 }}>
          <Droplets size={16} style={{ flex: 'none', marginTop: 1 }} />
          <span>
            钱包里的 VK 不够付发行费用（约 0.006 VK）。先去{' '}
            <button type="button" className="ch-link" onClick={() => chainGo('wallet')}>
              钱包
            </button>{' '}
            领取 VK。
          </span>
        </div>
      )}
      {!s.prep && (
        <button type="button" className="btn btn--solid ch-wide" disabled={!ok} onClick={submit}>
          <Sparkles size={15} /> {s.busy ? '正在检查…' : '下一步：确认发行'}
        </button>
      )}
      {s.prep && (
        <div className="ch-confirmwrap">
          <ConfirmPanel s={{ ...s, confirm: confirmIt }} title="确认发行" />
        </div>
      )}
      <SignerStatus s={s} />
      <p className="card__note">
        名称、符号和图标链接直接写进链上的资产账户（Token-2022 元数据扩展），外部钱包也能读到。发行费用约 0.006 VK：其中 0.0056 VK 是两个账户的押金（以后关闭账户可退回），gas 0.000005 VK。
        {fixed === 'fixed' ? ' 选了"固定总量"：发行后立即放弃增发权，以后谁都不能再增发。' : ' 保留增发权：以后可以在下方「我发行的资产」里增发，或随时放弃增发权。'}
      </p>
    </Card>
  );
}

function TokenAdmin({ t, w, bal }: { t: ChainToken; w: LocalWallet; bal: number }) {
  const s = useSigner();
  const canMint = t.mintAuthority === w.address;
  const [action, setAction] = useState<'mint' | 'burn' | 'renounce'>(canMint ? 'mint' : 'burn');
  const [amount, setAmount] = useState('');
  const opts = [
    ...(canMint ? [{ value: 'mint' as const, label: '增发' }] : []),
    { value: 'burn' as const, label: '销毁' },
    ...(canMint ? [{ value: 'renounce' as const, label: '放弃增发权' }] : []),
  ];
  return (
    <div className="ch-tokadmin">
      <Seg value={action} onChange={(v) => (setAction(v), s.reset())} options={opts} label="操作" />
      {action !== 'renounce' ? (
        <div className="ch-inline" style={{ marginTop: 10 }}>
          <input className="input num" inputMode="decimal" value={amount} placeholder={action === 'mint' ? '增发数量' : `销毁数量（持有 ${fmtAmount(bal, t.decimals)}）`} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          {!s.prep && (
            <button type="button" className="btn btn--solid" disabled={!(Number(amount) > 0) || s.busy} onClick={() => void s.prepare({ kind: action === 'mint' ? 'token-mint' : 'token-burn', mint: t.mint, amount })}>
              下一步
            </button>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <p className="ch-p">放弃后总量永久固定，任何人（包括你）都不能再增发。这个操作不能撤销。</p>
          {!s.prep && (
            <button type="button" className="btn ch-danger" disabled={s.busy} onClick={() => void s.prepare({ kind: 'token-renounce', mint: t.mint })}>
              下一步
            </button>
          )}
        </div>
      )}
      <ConfirmPanel s={s} />
      <SignerStatus s={s} />
    </div>
  );
}

function MyAssets({ w, ov }: { w: LocalWallet; ov: ChainOverview | null }) {
  const { data: av } = useChainAddress(w.address, 10_000);
  const [open, setOpen] = useState('');
  const mine = (ov?.tokens ?? []).filter((t) => t.creator === w.address || t.mintAuthority === w.address);
  return (
    <Card kicker="我发行的资产" title={mine.length ? `${mine.length} 种` : '还没有'}>
      {!mine.length && <div className="empty">发行成功后会显示在这里，可以增发、销毁或放弃增发权</div>}
      <div className="ch-toklist">
        {mine.map((t) => {
          const bal = av?.tokens.find((x) => x.mint === t.mint)?.amount ?? 0;
          return (
            <div key={t.mint}>
              <div className="ch-tokrow">
                <TokenIcon mint={t.mint} />
                <a className="ch-tokrow__name" href={chainLink.address(t.mint)}>
                  <b>
                    {t.name}（{t.symbol}）
                  </b>
                  <span className="muted">
                    总量 {fmtAmount(t.supply, t.decimals)} · 持有人 {t.holders ?? '—'} · {t.mintAuthority ? '可增发' : '固定总量'}
                  </span>
                </a>
                <button type="button" className="btn btn--ghost" aria-expanded={open === t.mint} onClick={() => setOpen((o) => (o === t.mint ? '' : t.mint))}>
                  管理
                </button>
              </div>
              {open === t.mint && <TokenAdmin t={t} w={w} bal={bal} />}
            </div>
          );
        })}
      </div>
      {mine.length > 0 && <p className="card__note">发给别人：在「钱包 → 转账」里选这个资产。最近发行于 {fmtAgo((mine[0].createdAt ?? 0) * 1000)}。</p>}
    </Card>
  );
}

export function IssueTab({ ov }: { ov: ChainOverview | null }) {
  const w = useWallet();
  if (!w)
    return (
      <Card className="hero-card" kicker="发行资产" title="先创建一个钱包">
        <div className="glow-orb" aria-hidden />
        <p className="ch-p">发行的资产会发到你的钱包里，发行费用（约 0.006 VK）也从钱包里扣。</p>
        <button type="button" className="btn btn--solid" onClick={() => chainGo('wallet')}>
          <Wallet size={15} /> 去创建钱包
        </button>
      </Card>
    );
  return (
    <>
      <IssueForm w={w} />
      <MyAssets w={w} ov={ov} />
      <Card kicker="说明" title="发行出来的是什么">
        <ul className="ch-bullets">
          <li>VK 链上的标准资产（Solana Token-2022 标准），和主网上的代币是同一种技术</li>
          <li>可以用来做公司积分、纪念币、内部凭证等；转账、增发、销毁都在链上留痕，所有人可查</li>
          <li>
            VK 和链上资产都没有市场价格，也不能和 Solana 主网上的资产互换；不要拿来卖钱、换人民币或对外募资（内地法律禁止发币融资），对外使用前请先咨询律师
          </li>
        </ul>
        <p className="card__note">
          在浏览器里查看：<AddrLink a={w.address} label="我的钱包地址" />
        </p>
      </Card>
    </>
  );
}
