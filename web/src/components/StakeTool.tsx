import { Link2Off, Lock, Unlock, Wallet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { StakeAccountInfo, StakePositions, ValidatorInfo } from '../../../shared/types';
import { solscan } from '../lib/api';
import { fmtCompact, fmtMoney, fmtNum, fmtSol } from '../lib/format';
import { useSolTo } from '../lib/hooks';
import { fmtDuration, lookupStake, prepareStake, projectedEarnings, stakeSent, STATUS_SHORT } from '../lib/staking';
import { useStore } from '../lib/store';
import { base64ToBytes, connectWallet, disconnectWallet, isUserRejection, signAndSend, useWallets, walletBrowseLinks, type StdWallet, type WalletAccount } from '../lib/wallet';
import { useCur } from './Shell';
import { Address, Card, toast } from './ui';

type Phase = { kind: 'idle' } | { kind: 'working'; text: string } | { kind: 'sent'; sig: string; text: string } | { kind: 'error'; text: string };

const MIN_STAKE = 1;
const KEEP = 0.01; // 留在钱包里付网络费

export function ValidatorAvatar({ v, size = 30 }: { v?: ValidatorInfo; size?: number }) {
  const [bad, setBad] = useState(false);
  const letter = (v?.name ?? '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '?';
  return v?.image && !bad ? (
    <img className="val-av" src={v.image} alt="" width={size} height={size} loading="lazy" onError={() => setBad(true)} />
  ) : (
    <span className="val-av val-av--txt" style={{ width: size, height: size }}>
      {letter}
    </span>
  );
}

/** 已有质押账户：解除质押 / 提取 */
export function StakeAccountRow({ a, onAction, busy, me }: { a: StakeAccountInfo; onAction?: (a: StakeAccountInfo, action: 'deactivate' | 'withdraw') => void; busy?: boolean; me?: string }) {
  const { primary } = useCur();
  const solTo = useSolTo();
  // 只显示连接的钱包有权限做的操作：解除质押要"质押权限"，提取要"提取权限"
  const canDeactivate = (a.status === 'active' || a.status === 'activating') && (!me || a.staker === me);
  const canWithdraw = a.withdrawable >= 0.001 && (!me || a.owner === me);
  return (
    <div className="stake-row">
      <ValidatorAvatar v={a.validator} />
      <div className="stake-row__main">
        <div className="stake-row__title">
          {a.validator?.name ?? '未委托'}
          <span className={`chip stake-st stake-st--${a.status}`}>{STATUS_SHORT[a.status]}</span>
        </div>
        <div className="stake-row__sub">
          <a href={solscan.account(a.address)} target="_blank" rel="noreferrer">
            {a.address.slice(0, 4)}…{a.address.slice(-4)}
          </a>
          {a.apr !== undefined ? ` · 年化 ${fmtNum(a.apr, 2)}%` : a.validator?.apy ? ` · 预计年化 ${fmtNum(a.validator.apy, 2)}%` : ''}
          {a.lastReward ? ` · 上期 +${fmtSol(a.lastReward.sol)}` : ''}
        </div>
        {onAction && me && a.staker !== me && a.owner === me && (a.status === 'active' || a.status === 'activating') && (
          <div className="stake-row__sub">质押权限在另一个钱包（{a.staker.slice(0, 4)}…{a.staker.slice(-4)}），要用那个钱包来解除</div>
        )}
        {onAction && (canDeactivate || canWithdraw) && (
          <div className="payout__actions" style={{ marginTop: 6 }}>
            {canDeactivate && (
              <button type="button" className="chip" disabled={busy} onClick={() => onAction(a, 'deactivate')}>
                <Unlock size={11} /> 解除质押
              </button>
            )}
            {canWithdraw && (
              <button type="button" className="chip chip--accent" disabled={busy} onClick={() => onAction(a, 'withdraw')}>
                提取 {fmtSol(a.withdrawable)} SOL
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flow-row__amt">
        <span>{fmtSol(a.sol)} SOL</span>
        <span className="muted">{fmtMoney(a.sol * solTo[primary], primary)}</span>
      </div>
    </div>
  );
}

/** 连接钱包质押：签名在用户自己的钱包里完成，App 和服务器接触不到私钥 */
export function StakeTool(props: { validators: ValidatorInfo[]; epochSec: number; endsInSec: number; companyMode?: boolean; title?: string }) {
  const wallets = useWallets();
  const solTo = useSolTo();
  const { primary, secondary } = useCur();
  // 选择器必须返回稳定的引用（每次 map 出新数组会让 React 无限重渲染），在组件里再转换
  const treasuryWallets = useStore((s) => s.snap?.treasury.wallets);
  const companyWallets = useMemo(() => (treasuryWallets ?? []).map((w) => w.address), [treasuryWallets]);
  const [wallet, setWallet] = useState<StdWallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [pos, setPos] = useState<StakePositions | null>(null);
  const [amount, setAmount] = useState('');
  const [vote, setVote] = useState(props.validators[0]?.vote ?? '');
  const [showAll, setShowAll] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    if (!vote && props.validators[0]) setVote(props.validators[0].vote);
  }, [props.validators, vote]);

  const refresh = async (fresh = false) => {
    if (!account) return;
    try {
      setPos(await lookupStake(account.address, fresh));
    } catch (e) {
      setPhase({ kind: 'error', text: (e as Error).message });
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.address]);

  const connect = async (w: StdWallet) => {
    setPhase({ kind: 'working', text: `正在连接 ${w.name}…` });
    try {
      const acc = await connectWallet(w);
      setWallet(w);
      setAccount(acc);
      setPhase({ kind: 'idle' });
    } catch (e) {
      setPhase({ kind: 'error', text: isUserRejection(e) ? '你在钱包里取消了连接' : `连接失败：${(e as Error).message}` });
    }
  };
  const disconnect = async () => {
    if (wallet) await disconnectWallet(wallet);
    setWallet(null);
    setAccount(null);
    setPos(null);
    setAmount('');
    setAgreed(false);
    setPhase({ kind: 'idle' });
  };

  const run = async (body: Record<string, unknown>, confirmText: string, doneText: string) => {
    if (!wallet || !account) return;
    try {
      setPhase({ kind: 'working', text: '正在组装交易并在链上模拟…' });
      const prep = await prepareStake({ ...body, owner: account.address });
      setPhase({ kind: 'working', text: `请在 ${wallet.name} 里确认：${confirmText}` });
      const sig = await signAndSend(wallet, account, base64ToBytes(prep.transaction));
      void stakeSent(account.address);
      setPhase({ kind: 'sent', sig, text: doneText });
      setAmount('');
      setAgreed(false);
      toast(doneText);
      setTimeout(() => void refresh(true), 6_000);
      setTimeout(() => void refresh(true), 20_000);
    } catch (e) {
      setPhase({ kind: 'error', text: isUserRejection(e) ? '你在钱包里取消了，没有任何变化' : (e as Error).message });
    }
  };

  const v = props.validators.find((x) => x.vote === vote);
  const n = Number(amount);
  const max = pos ? Math.max(0, pos.walletSol - KEEP - 0.0017) : 0;
  const valid = amount !== '' && n >= MIN_STAKE && n <= max + 1e-9;
  const apy = v?.apy ?? 0;
  const yearly = valid && apy ? projectedEarnings(n, apy, 365, props.epochSec) : 0;
  const perEpoch = valid && apy ? projectedEarnings(n, apy, props.epochSec / 86400, props.epochSec) : 0;
  const isCompany = !!account && companyWallets.includes(account.address);
  const busy = phase.kind === 'working';
  const list = showAll ? props.validators : props.validators.slice(0, 5);
  const here = `${location.origin}/#/staking`;

  const doStake = () => {
    if (!v) return;
    if (!confirm(`质押 ${fmtNum(n, 4)} SOL 给 ${v.name}？\n预计年化 ${fmtNum(apy, 2)}%，每年约 +${fmtSol(yearly)} SOL。\n随时可以解除，解除后约 1 期（${fmtDuration(props.epochSec)}）冷却后提取。`)) return;
    void run({ action: 'stake', vote: v.vote, amount: String(Math.floor(n * 1e9) / 1e9) }, `质押 ${fmtNum(n, 4)} SOL（另付押金约 0.00167 SOL）`, `已质押 ${fmtNum(n, 4)} SOL，下一期开始生效`);
  };
  const onAction = (a: StakeAccountInfo, action: 'deactivate' | 'withdraw') => {
    if (action === 'deactivate') {
      if (!confirm(`解除这笔 ${fmtSol(a.delegated)} SOL 的质押？\n解除后从下一期开始不再产生收益，冷却约 1 期（${fmtDuration(props.epochSec)}）后可以提取回钱包。`)) return;
      void run({ action, stake: a.address }, `解除质押 ${fmtSol(a.delegated)} SOL`, '已解除质押，冷却完成后就能提取');
    } else {
      void run({ action, stake: a.address }, `提取 ${fmtSol(a.withdrawable)} SOL 回钱包`, `已提取 ${fmtSol(a.withdrawable)} SOL 回钱包`);
    }
  };

  return (
    <Card kicker="Stake" title={props.title ?? '连接钱包质押'} right={<Lock size={16} style={{ color: 'var(--accent)' }} />}>
      {!account ? (
        wallets.length ? (
          <>
            <p className="card__note" style={{ marginTop: 0 }}>
              质押是把 SOL 委托给验证者帮网络记账，每期（约 {fmtDuration(props.epochSec)}）自动发收益。钱一直在你自己的质押账户里，验证者拿不走；签名在你的钱包里完成，App 接触不到私钥。
            </p>
            <div className="wm__actions" style={{ flexWrap: 'wrap' }}>
              {wallets.map((w) => (
                <button key={w.name} type="button" className="btn" disabled={busy} onClick={() => connect(w)}>
                  {w.icon ? <img src={w.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} /> : <Wallet size={15} />} 连接 {w.name}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="addr-preview addr-preview--info">当前浏览器里没有 Solana 钱包。手机上请用钱包 App 打开本页面，电脑上安装 Phantom 插件后刷新。</div>
            <div className="wm__actions">
              {walletBrowseLinks(here).map((l) => (
                <a key={l.name} className="btn" href={l.href}>
                  在 {l.name} 中打开
                </a>
              ))}
            </div>
          </>
        )
      ) : (
        <>
          <div className="rows">
            <div className="row">
              <span className="row__k">已连接 {wallet?.name}</span>
              <span className="row__v" style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {isCompany && <span className="chip chip--accent">公司钱包</span>}
                <Address address={account.address} />
              </span>
            </div>
            <div className="row">
              <span className="row__k">可用 SOL</span>
              <span className="row__v mono">{pos ? `${fmtSol(pos.walletSol)} SOL` : '读取中…'}</span>
            </div>
            {pos && pos.stakedSol > 0 && (
              <div className="row">
                <span className="row__k">已质押</span>
                <span className="row__v mono">
                  {fmtSol(pos.stakedSol)} SOL{pos.apy ? ` · 年化 ${fmtNum(pos.apy, 2)}%` : ''}
                </span>
              </div>
            )}
          </div>
          {props.companyMode && !isCompany && (
            <div className="addr-preview addr-preview--warn" style={{ marginTop: 8 }}>
              这个钱包不是公司钱包：用它质押的 SOL 不会计入公司资产（属于个人质押）。
            </div>
          )}
          {pos?.accounts.length ? (
            <div style={{ marginTop: 10 }}>
              {pos.accounts.map((a) => (
                <StakeAccountRow key={a.address} a={a} onAction={onAction} busy={busy} me={account.address} />
              ))}
            </div>
          ) : null}

          <div className="wm__title" style={{ marginTop: 14 }}>
            新的质押
          </div>
          <div className="field" style={{ marginBottom: 8 }}>
            <label htmlFor="stake-amount">质押数量（最少 {MIN_STAKE} SOL）</label>
            <input
              id="stake-amount"
              inputMode="decimal"
              placeholder="输入 SOL 数量"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^\d.]/g, ''));
                setAgreed(false);
              }}
            />
          </div>
          <div className="sim-chips">
            {[MIN_STAKE, max / 2, max].map((x, i) => (
              <button key={i} type="button" className="chip" disabled={x < MIN_STAKE} onClick={() => (setAmount(String(Math.floor(x * 1e4) / 1e4)), setAgreed(false))}>
                {i === 0 ? '1 SOL' : i === 1 ? `一半 ${fmtNum(x, 2)}` : `全部 ${fmtNum(x, 2)}（留 ${KEEP} 付手续费）`}
              </button>
            ))}
          </div>
          {amount !== '' && !valid && <div className="error">{n < MIN_STAKE ? `最少质押 ${MIN_STAKE} SOL（链上规定）` : '超过了钱包里可用的 SOL'}</div>}

          <div className="wm__title" style={{ marginTop: 14 }}>
            选择验证者
          </div>
          <div className="val-list" role="radiogroup" aria-label="验证者">
            {list.map((x) => (
              <button key={x.vote} type="button" role="radio" aria-checked={vote === x.vote} className={`val-opt ${vote === x.vote ? 'val-opt--on' : ''}`} onClick={() => setVote(x.vote)}>
                <ValidatorAvatar v={x} />
                <span className="val-opt__main">
                  <span className="val-opt__name">{x.name}</span>
                  <span className="val-opt__sub">
                    佣金 {x.commission}% · {x.stake ? fmtCompact(x.stake, 1) : '—'} SOL{x.uptime ? ` · 在线 ${+x.uptime.toFixed(1)}%` : ''}
                  </span>
                </span>
                <span className="val-opt__apy">{x.apy ? `${fmtNum(x.apy, 2)}%` : '—'}</span>
              </button>
            ))}
          </div>
          {props.validators.length > 5 && (
            <button type="button" className="btn btn--ghost" style={{ width: '100%', marginTop: 6 }} onClick={() => setShowAll(!showAll)}>
              {showAll ? '收起' : `显示全部 ${props.validators.length} 个推荐验证者`}
            </button>
          )}

          {valid && v && (
            <div className="addr-preview addr-preview--ok" style={{ marginTop: 12 }}>
              <div>
                质押 <b>{fmtNum(n, 4)} SOL</b> 给 <b>{v.name}</b>，预计年化 <b>{fmtNum(apy, 2)}%</b>
              </div>
              <div>
                每期（约 {fmtDuration(props.epochSec)}）+{fmtSol(perEpoch)} SOL · 每年约 <b>+{fmtSol(yearly)} SOL</b>（{fmtMoney(yearly * solTo[primary], primary)} · {fmtMoney(yearly * solTo[secondary], secondary)}）
              </div>
              <div className="muted">
                约 {fmtDuration(props.endsInSec)}后下一期开始生效，收益自动复投；另需押金约 0.00167 SOL（取回时退还）。随时可以解除，冷却约 1 期后提取。
              </div>
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={agreed} disabled={!valid} onChange={(e) => setAgreed(e.target.checked)} />
            我知道解除质押后要等约 1 期（{fmtDuration(props.epochSec)}）才能取回
          </label>
          <button type="button" className="btn btn--solid" style={{ width: '100%', marginTop: 10 }} disabled={busy || !valid || !agreed || !v} onClick={doStake}>
            <Lock size={15} /> 用 {wallet?.name} 签名质押
          </button>
          <button type="button" className="btn btn--ghost" style={{ width: '100%', marginTop: 8 }} disabled={busy} onClick={disconnect}>
            <Link2Off size={15} /> 断开钱包
          </button>
        </>
      )}

      {phase.kind === 'working' && (
        <div className="addr-preview addr-preview--info" style={{ marginTop: 10 }} role="status">
          {phase.text}
        </div>
      )}
      {phase.kind === 'error' && <div className="error">{phase.text}</div>}
      {phase.kind === 'sent' && (
        <div className="addr-preview addr-preview--ok" style={{ marginTop: 10 }} role="status">
          ✓ {phase.text}
          <a href={solscan.tx(phase.sig)} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>
            在 Solscan 查看 ›
          </a>
        </div>
      )}
    </Card>
  );
}
