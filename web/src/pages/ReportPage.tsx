import { ChevronUp, Download, Image as ImageIcon, Share2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ReportData } from '../../../shared/types';
import { Mascot } from '../components/Mascot';
import { useCur } from '../components/Shell';
import { toast } from '../components/ui';
import { getJSON } from '../lib/api';
import { fmtMoney, fmtNum, fmtSol, type Cur } from '../lib/format';
import { go, useHashParam, useSolTo } from '../lib/hooks';

const pad = (n: number) => String(n).padStart(2, '0');
const md = (ms: number) => `${new Date(ms).getMonth() + 1} 月 ${new Date(ms).getDate()} 日`;
const mdStr = (d: string) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`;
const hm = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const multiple = (r: ReportData) => (r.first && r.first.sol > 0 ? r.end / r.first.sol : 0);

/** 滑到这一页时数字从 0 滚上去 */
function Count({ value, digits = 2, on }: { value: number; digits?: number; on: boolean }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!on) return setV(0);
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const f = Math.min(1, (now - start) / 1300);
      setV(value * (1 - (1 - f) ** 3));
      if (f < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, value]);
  return <>{fmtNum(v, digits)}</>;
}

function Growth({ r, on }: { r: ReportData; on: boolean }) {
  const pts = r.growth;
  if (pts.length < 2) return null;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const max = Math.max(...pts.map((p) => p.sol), 1e-9);
  const X = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * 300;
  const Y = (v: number) => 118 - (v / max) * 108;
  let d = `M0,${Y(pts[0].sol).toFixed(1)}`;
  for (const p of pts.slice(1)) d += `H${X(p.t).toFixed(1)}V${Y(p.sol).toFixed(1)}`;
  return (
    <svg className={`rp-growth ${on ? 'on' : ''}`} viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden>
      <path d={`${d}V120H0Z`} className="rp-growth__area" />
      <path d={d} className="rp-growth__line" pathLength={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type Slide = { key: string; cls: string; body: (on: boolean) => ReactNode };

// ─── 海报 ─────────────────────────────────────────────────────

const FONT = "'PingFang SC','HarmonyOS Sans SC','Noto Sans SC','Microsoft YaHei',system-ui,sans-serif";

function rrect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** 文字太长时缩小字号，保证放得下 */
function fit(c: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight: number) {
  let px = size;
  c.font = `${weight} ${px}px ${FONT}`;
  while (px > 20 && c.measureText(text).width > maxW) {
    px -= 4;
    c.font = `${weight} ${px}px ${FONT}`;
  }
}

async function drawPoster(r: ReportData, hide: boolean, toCur: (sol: number) => string): Promise<Blob> {
  const W = 1080;
  const H = 1920;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d')!;
  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0f3a72');
  bg.addColorStop(0.45, '#061a3a');
  bg.addColorStop(1, '#020a1a');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  for (const [x, y, rad, col] of [
    [880, 260, 360, 'rgba(34,211,238,0.16)'],
    [160, 1500, 420, 'rgba(144,133,233,0.12)'],
  ] as const) {
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }
  await document.fonts?.ready;
  try {
    const img = new Image();
    img.src = '/icons/icon-192.png';
    await img.decode();
    c.save();
    rrect(c, W / 2 - 75, 110, 150, 150, 34);
    c.clip();
    c.drawImage(img, W / 2 - 75, 110, 150, 150);
    c.restore();
  } catch {
    /* 没有图标也能画 */
  }
  c.textAlign = 'center';
  c.fillStyle = '#22d3ee';
  c.font = `700 50px ${FONT}`;
  c.fillText('V E C T O R K E I T H', W / 2, 340);
  c.fillStyle = '#ffffff';
  c.font = `800 104px ${FONT}`;
  c.fillText(`${r.year} 年度报告`, W / 2, 480);
  c.fillStyle = '#9fb8d9';
  c.font = `400 34px ${FONT}`;
  c.fillText(`截至 ${md(r.to * 1000)} · 数据全部来自 Solana 链上`, W / 2, 545);

  // 大数字
  rrect(c, 80, 610, W - 160, 330, 40);
  c.fillStyle = 'rgba(8,28,58,0.85)';
  c.fill();
  c.strokeStyle = 'rgba(56,189,248,0.35)';
  c.lineWidth = 2;
  c.stroke();
  c.fillStyle = '#9fb8d9';
  c.font = `400 38px ${FONT}`;
  c.fillText(hide ? '公司钱包里的 SOL，现在是' : '公司钱包里现在有', W / 2, 690);
  c.fillStyle = '#ffffff';
  const mult = multiple(r);
  const head = hide ? (mult >= 2 ? `第一笔的 ${fmtNum(mult, 0)} 倍` : `${r.txCount} 笔交易`) : `${fmtNum(r.end, 2)} SOL`;
  fit(c, head, W - 240, 128, 800);
  c.fillText(head, W / 2, 830);
  c.fillStyle = '#16e0a0';
  c.font = `600 44px ${FONT}`;
  c.fillText(hide ? '一步一步，从链上长出来' : `≈ ${toCur(r.end)}`, W / 2, 900);

  // 6 个格子
  const tiles: [string, string, string][] = [
    ['🧮', '全年交易', `${fmtNum(r.txCount, 0)} 笔`],
    ['🐋', '最大一笔到账', r.biggestIn ? (hide ? md(r.biggestIn.ts * 1000) : `+${fmtNum(r.biggestIn.sol, 2)} SOL`) : '—'],
    ['🔥', r.bestDay && !hide ? `最赚的一天 · ${Number(r.bestDay.date.slice(5, 7))}/${Number(r.bestDay.date.slice(8, 10))}` : '最赚的一天', r.bestDay ? (hide ? mdStr(r.bestDay.date) : `+${fmtNum(r.bestDay.net, 2)} SOL`) : '—'],
    ['🌙', '凌晨还在交易', `${r.night.count} 笔`],
    ['🛡️', '识破地址投毒', `${r.poison.count} 次`],
    ['🏆', '解锁成就', `${r.achievements.unlocked}/${r.achievements.total}`],
  ];
  tiles.forEach(([icon, k, v], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 80 + col * 470;
    const y = 990 + row * 230;
    rrect(c, x, y, 450, 205, 32);
    c.fillStyle = 'rgba(8,28,58,0.75)';
    c.fill();
    c.strokeStyle = 'rgba(56,189,248,0.2)';
    c.stroke();
    c.textAlign = 'left';
    c.font = `400 52px ${FONT}`;
    c.fillText(icon, x + 34, y + 78);
    c.fillStyle = '#9fb8d9';
    fit(c, k, 450 - 130, 32, 400);
    c.fillText(k, x + 110, y + 72);
    c.fillStyle = '#ffffff';
    fit(c, v, 450 - 68, 56, 700);
    c.fillText(v, x + 34, y + 160);
  });
  c.textAlign = 'center';
  c.fillStyle = '#7c98bf';
  c.font = `400 32px ${FONT}`;
  c.fillText(`${r.activeDays} 天有交易 · 第一笔 ${r.first ? md(r.first.ts * 1000) : '—'}`, W / 2, 1720);
  c.fillStyle = '#22d3ee';
  c.font = `600 34px ${FONT}`;
  c.fillText('VectorKeith 公司资产 App', W / 2, 1800);
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('生成失败'))), 'image/png'));
}

function Poster({ r, onClose }: { r: ReportData; onClose: () => void }) {
  const solTo = useSolTo();
  const { primary } = useCur();
  const [hide, setHide] = useState(false);
  const [url, setUrl] = useState('');
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    let alive = true;
    let u = '';
    void drawPoster(r, hide, (sol) => fmtMoney(sol * solTo[primary as Cur], primary)).then((b) => {
      if (!alive) return;
      u = URL.createObjectURL(b);
      setBlob(b);
      setUrl(u);
    });
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, hide]);
  const file = blob ? new File([blob], `VectorKeith-${r.year}-年度报告.png`, { type: 'image/png' }) : null;
  const canShare = !!file && !!navigator.canShare?.({ files: [file] });
  return (
    <div className="rp-poster" role="dialog" aria-label="年度报告海报">
      <button type="button" className="icon-btn rp-poster__x" aria-label="关闭" onClick={onClose}>
        <X size={18} />
      </button>
      {url ? <img src={url} alt={`VectorKeith ${r.year} 年度报告海报`} /> : <div className="rp-poster__wait">正在生成海报…</div>}
      <label className="checkbox" style={{ justifyContent: 'center' }}>
        <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
        隐藏具体金额（发朋友圈更安全）
      </label>
      <div className="wm__actions">
        {canShare && (
          <button type="button" className="btn btn--solid" onClick={() => navigator.share({ files: [file!], title: `VectorKeith ${r.year} 年度报告` }).catch(() => {})}>
            <Share2 size={15} /> 分享 / 保存
          </button>
        )}
        <a className="btn" href={url} download={`VectorKeith-${r.year}-年度报告.png`} onClick={() => toast('手机上也可以长按图片保存')}>
          <Download size={15} /> 下载图片
        </a>
      </div>
      <p className="rp-poster__tip">手机上长按图片可以直接保存到相册</p>
    </div>
  );
}

// ─── 页面 ─────────────────────────────────────────────────────

export function ReportPage() {
  const yearParam = Number(useHashParam('year')) || Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4));
  const [r, setR] = useState<ReportData | null>(null);
  const [err, setErr] = useState('');
  const [active, setActive] = useState(0);
  const [poster, setPoster] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  const money = (sol: number) => fmtMoney(sol * solTo[primary], primary);
  const usdTo = (usd: number, c: Cur) => fmtMoney(c === 'usd' ? usd : usd * (r?.usdCny ?? 7.1), c);

  useEffect(() => {
    setR(null);
    getJSON<ReportData>(`/api/report?year=${yearParam}`)
      .then(setR)
      .catch((e) => setErr((e as Error).message));
  }, [yearParam]);

  const slides = useMemo<Slide[]>(() => {
    if (!r) return [];
    const s: Slide[] = [];
    const mult = multiple(r);
    s.push({
      key: 'cover',
      cls: 'rp-s--cover',
      body: () => (
        <>
          <div className="rv rp-kicker">VECTORKEITH</div>
          <h1 className="rv rp-title" style={{ ['--d' as string]: '0.15s' }}>
            {r.year} 年度报告
          </h1>
          <p className="rv rp-p" style={{ ['--d' as string]: '0.35s' }}>
            这一年，公司钱包在链上发生了 <b>{fmtNum(r.txCount, 0)}</b> 笔交易，
            <br />有 <b>{r.activeDays}</b> 天都有动静
          </p>
          <div className="rv rp-bot" style={{ ['--d' as string]: '0.55s' }}>
            <Mascot motion="dance" size={120} />
          </div>
          <div className="rp-hint">
            <ChevronUp size={18} /> 向上滑动
          </div>
        </>
      ),
    });
    if (r.first) {
      const f = r.first;
      s.push({
        key: 'first',
        cls: 'rp-s--first',
        body: (on) => (
          <>
            <div className="rv rp-emoji">🌱</div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.1s' }}>
              <b>{md(f.ts * 1000)}</b> {hm(f.ts * 1000)}
              <br />
              公司钱包收到了第一笔 SOL
            </p>
            <div className="rv rp-big" style={{ ['--d' as string]: '0.3s' }}>
              +<Count value={f.sol} digits={f.sol < 1 ? 3 : 2} on={on} /> <small>SOL</small>
            </div>
            <p className="rv rp-p rp-dim" style={{ ['--d' as string]: '0.5s' }}>
              {f.fromLabel ? `来自 ${f.fromLabel} · ` : ''}那天 SOL 的价格是 ${fmtNum(f.solUsd, 2)}
            </p>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.7s' }}>
              一切，都从这一笔开始。
            </p>
          </>
        ),
      });
    }
    s.push({
      key: 'growth',
      cls: 'rp-s--growth',
      body: (on) => (
        <>
          <p className="rv rp-p">到今天，公司钱包里有</p>
          <div className="rv rp-big" style={{ ['--d' as string]: '0.15s' }}>
            <Count value={r.end} on={on} /> <small>SOL</small>
          </div>
          <p className="rv rp-p" style={{ ['--d' as string]: '0.3s' }}>
            ≈ <b>{money(r.end)}</b> · {fmtMoney(r.end * solTo[secondary], secondary)}
          </p>
          <div className="rv" style={{ ['--d' as string]: '0.4s', width: '100%' }}>
            <Growth r={r} on={on} />
          </div>
          {mult >= 2 && (
            <p className="rv rp-p" style={{ ['--d' as string]: '0.6s' }}>
              是第一笔的 <b className="rp-hl">{fmtNum(mult, 0)} 倍</b>
            </p>
          )}
          {r.peak && (
            <p className="rv rp-p rp-dim" style={{ ['--d' as string]: '0.75s' }}>
              {r.peak.sol <= r.end * 1.001 ? '📈 现在就是历史最高' : `最高到过 ${fmtNum(r.peak.sol, 2)} SOL（${md(r.peak.ts * 1000)}）`}
            </p>
          )}
        </>
      ),
    });
    if (r.biggestIn) {
      const b = r.biggestIn;
      s.push({
        key: 'whale',
        cls: 'rp-s--whale',
        body: (on) => (
          <>
            <div className="rv rp-emoji">🐋</div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.1s' }}>
              <b>{md(b.ts * 1000)}</b> {hm(b.ts * 1000)}
              <br />
              公司收到了今年最大的一笔转账
            </p>
            <div className="rv rp-big" style={{ ['--d' as string]: '0.3s' }}>
              +<Count value={b.sol} on={on} /> <small>SOL</small>
            </div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.5s' }}>
              按当时的价格 ≈ <b>{usdTo(b.usd, primary)}</b>
              {b.fromLabel ? (
                <>
                  <br />
                  来自 {b.fromLabel}
                </>
              ) : null}
            </p>
            {r.topSender && (
              <p className="rv rp-p rp-dim" style={{ ['--d' as string]: '0.7s' }}>
                今年转进来最多的是 {r.topSender.label}：{r.topSender.count} 笔，共 {fmtNum(r.topSender.sol, 2)} SOL
              </p>
            )}
          </>
        ),
      });
    }
    if (r.bestDay) {
      const d = r.bestDay;
      s.push({
        key: 'best',
        cls: 'rp-s--best',
        body: (on) => (
          <>
            <div className="rv rp-emoji">🔥</div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.1s' }}>
              <b>{mdStr(d.date)}</b>，是今年最赚的一天
            </p>
            <div className="rv rp-big" style={{ ['--d' as string]: '0.3s' }}>
              +<Count value={d.net} on={on} /> <small>SOL</small>
            </div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.5s' }}>
              净流入 ≈ {money(d.net)} · 这一天有 {d.count} 笔交易
            </p>
            {r.busiestDay && r.busiestDay.date !== d.date && (
              <p className="rv rp-p rp-dim" style={{ ['--d' as string]: '0.7s' }}>
                最忙的一天是 {mdStr(r.busiestDay.date)}：一天 {r.busiestDay.count} 笔交易
              </p>
            )}
          </>
        ),
      });
    }
    if (r.night.count > 0) {
      s.push({
        key: 'night',
        cls: 'rp-s--night',
        body: (on) => (
          <>
            <div className="rv rp-bot">
              <Mascot motion="yawn" size={110} />
            </div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.15s' }}>
              凌晨 0 点到 5 点，公司钱包还有
            </p>
            <div className="rv rp-big" style={{ ['--d' as string]: '0.3s' }}>
              <Count value={r.night.count} digits={0} on={on} /> <small>笔交易</small>
            </div>
            {r.night.latest && (
              <p className="rv rp-p" style={{ ['--d' as string]: '0.5s' }}>
                最晚的一次，在凌晨 <b>{r.night.latest}</b>
              </p>
            )}
            {r.topHour && (
              <p className="rv rp-p rp-dim" style={{ ['--d' as string]: '0.7s' }}>
                一天里最常交易的时间：{r.topHour.hour} 点（{r.topHour.count} 笔）
              </p>
            )}
            <p className="rv rp-p" style={{ ['--d' as string]: '0.85s' }}>
              🌙 辛苦了，夜猫子们
            </p>
          </>
        ),
      });
    }
    if (r.poison.count > 0) {
      s.push({
        key: 'guard',
        cls: 'rp-s--guard',
        body: (on) => (
          <>
            <div className="rv rp-emoji">🛡️</div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.1s' }}>
              骗子试图冒充公司常用的地址
            </p>
            <div className="rv rp-big" style={{ ['--d' as string]: '0.3s' }}>
              <Count value={r.poison.count} digits={0} on={on} /> <small>次</small>
            </div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.5s' }}>
              被冒充的有：{r.poison.imitated.join('、')}
            </p>
            <p className="rv rp-p rp-hl" style={{ ['--d' as string]: '0.7s' }}>
              全部被识破 ✓
            </p>
            <p className="rv rp-p rp-dim" style={{ ['--d' as string]: '0.85s' }}>
              转账时一定要核对完整地址，不要从交易记录里复制
            </p>
          </>
        ),
      });
    }
    const k = r.kinds;
    s.push({
      key: 'trade',
      cls: 'rp-s--trade',
      body: () => (
        <>
          <p className="rv rp-p">这一年，公司钱包</p>
          <div className="rv rp-grid" style={{ ['--d' as string]: '0.15s' }}>
            {(
              [
                ['in', '转入', '📥'],
                ['out', '转出', '📤'],
                ['buy', '买入代币', '🛒'],
                ['sell', '卖出代币', '💱'],
              ] as const
            ).map(([key, label, icon]) => (
              <div key={key}>
                <span>
                  {icon} {label}
                </span>
                <b>{k[key]?.count ?? 0} 次</b>
                <em>
                  {(k[key]?.sol ?? 0) >= 0 ? '+' : '−'}
                  {fmtNum(Math.abs(k[key]?.sol ?? 0), 2)} SOL
                </em>
              </div>
            ))}
          </div>
          {r.topToken && (
            <p className="rv rp-p" style={{ ['--d' as string]: '0.4s' }}>
              交易最多的代币是 <b>{r.topToken.symbol}</b>：买入 {r.topToken.buys} 次，卖出 {r.topToken.sells} 次
            </p>
          )}
          <p className="rv rp-p rp-dim" style={{ ['--d' as string]: '0.6s' }}>
            全年只付了 {fmtSol(r.fees)} SOL 网络费（≈ {money(r.fees)}），Solana 真便宜
          </p>
        </>
      ),
    });
    if (r.hodlDays >= 7) {
      s.push({
        key: 'hodl',
        cls: 'rp-s--hodl',
        body: (on) => (
          <>
            <div className="rv rp-emoji">🧘</div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.1s' }}>
              最长的一次，公司钱包连续
            </p>
            <div className="rv rp-big" style={{ ['--d' as string]: '0.3s' }}>
              <Count value={r.hodlDays} digits={0} on={on} /> <small>天</small>
            </div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.5s' }}>
              没有转出一个 SOL
            </p>
            <p className="rv rp-p rp-hl" style={{ ['--d' as string]: '0.7s' }}>
              稳如泰山
            </p>
          </>
        ),
      });
    }
    if (r.dividends && r.dividends.count > 0) {
      const d = r.dividends;
      s.push({
        key: 'div',
        cls: 'rp-s--div',
        body: (on) => (
          <>
            <div className="rv rp-emoji">🎁</div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.1s' }}>
              公司给股东发了 <b>{d.count}</b> 次分红，一共
            </p>
            <div className="rv rp-big" style={{ ['--d' as string]: '0.3s' }}>
              <Count value={d.sol} on={on} /> <small>SOL</small>
            </div>
            <p className="rv rp-p" style={{ ['--d' as string]: '0.5s' }}>
              ≈ {money(d.sol)}，感谢每一位股东
            </p>
          </>
        ),
      });
    }
    s.push({
      key: 'ach',
      cls: 'rp-s--ach',
      body: () => (
        <>
          <p className="rv rp-p">这一年，公司解锁了</p>
          <div className="rv rp-big" style={{ ['--d' as string]: '0.15s' }}>
            {r.achievements.unlocked}
            <small>/{r.achievements.total} 个成就</small>
          </div>
          <div className="rv rp-icons" style={{ ['--d' as string]: '0.3s' }}>
            {r.achievements.icons.map((ic, i) => (
              <span key={i} style={{ ['--i' as string]: String(i) }}>
                {ic}
              </span>
            ))}
          </div>
          <p className="rv rp-p rp-dim" style={{ ['--d' as string]: '0.6s' }}>
            还有 {r.achievements.total - r.achievements.unlocked} 个等着明年解锁
          </p>
        </>
      ),
    });
    s.push({
      key: 'end',
      cls: 'rp-s--end',
      body: () => (
        <>
          <div className="rv rp-bot">
            <Mascot motion="party" hat size={130} />
          </div>
          <h2 className="rv rp-title" style={{ ['--d' as string]: '0.15s' }}>
            {r.year}，谢谢陪伴
          </h2>
          <p className="rv rp-p" style={{ ['--d' as string]: '0.3s' }}>
            {fmtNum(r.txCount, 0)} 笔交易 · {fmtNum(r.end, 2)} SOL · {r.achievements.unlocked} 个成就
          </p>
          <div className="rv" style={{ ['--d' as string]: '0.45s', display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 320 }}>
            <button type="button" className="btn btn--solid" style={{ height: 46, fontSize: 15 }} onClick={() => setPoster(true)}>
              <ImageIcon size={17} /> 生成年度海报
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => go('explore')}>
              返回探索
            </button>
          </div>
        </>
      ),
    });
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, solTo, primary, secondary]);

  // 当前在第几页（用来触发每页的入场动画和数字滚动）
  useEffect(() => {
    const el = box.current;
    if (!el || !slides.length) return;
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) if (e.isIntersecting && e.intersectionRatio > 0.55) setActive(Number((e.target as HTMLElement).dataset.i));
      },
      { root: el, threshold: [0.55] },
    );
    el.querySelectorAll('.rp-s').forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [slides]);

  if (err) {
    return (
      <div className="rp">
        <div className="rp-s rp-s--cover">
          <p className="rp-p">年度报告加载失败：{err}</p>
          <button type="button" className="btn" onClick={() => go('explore')}>
            返回
          </button>
        </div>
      </div>
    );
  }
  if (!r) {
    return (
      <div className="rp">
        <div className="rp-s rp-s--cover on">
          <Mascot motion="idle" size={110} />
          <p className="rp-p">正在翻公司钱包这一年的账本…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rp">
      <div className="rp-top">
        {r.years.length > 1 && (
          <div className="seg" role="group" aria-label="年份">
            {r.years.map((y) => (
              <button key={y} type="button" aria-pressed={y === r.year} onClick={() => (location.hash = `#/report?year=${y}`)}>
                {y}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="icon-btn" aria-label="关闭年度报告" onClick={() => go('explore')}>
          <X size={18} />
        </button>
      </div>
      <div className="rp-dots" aria-hidden>
        {slides.map((s, i) => (
          <i key={s.key} className={i === active ? 'on' : ''} />
        ))}
      </div>
      <div className="rp-story" ref={box}>
        {slides.map((s, i) => (
          <section key={s.key} data-i={i} className={`rp-s ${s.cls} ${i === active ? 'on' : ''}`}>
            {s.body(i === active)}
          </section>
        ))}
      </div>
      {poster && <Poster r={r} onClose={() => setPoster(false)} />}
    </div>
  );
}
