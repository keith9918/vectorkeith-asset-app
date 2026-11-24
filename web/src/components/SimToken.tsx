// USVK 模拟盘：代币信息卡片（「信息」页和模拟盘共用）
import type { ReactNode } from 'react';
import { curveFeeRate, simCirculating, simCircMcap, simLiquidity, simMcap, simPoolTokens, simPrice, simProgress, simSolToGraduate } from '../../../shared/sim';
import type { SimView } from '../../../shared/types';
import { fmtCompact, fmtDate, fmtInt, fmtNum, fmtPct, fmtPrice, fmtSol, fmtTiny } from '../lib/format';
import { useSolTo } from '../lib/hooks';
import { Dual, useCur } from './Shell';
import { Card } from './ui';

/** 进度往下取整：没买满之前不显示 100% */
export const floorPct = (v: number, done = false) => fmtPct(done ? 1 : Math.min(0.999, Math.floor(v * 1000) / 1000), 1);

/** 开盘价（SOL / 枚） */
export const openPrice = (v: SimView) => v.params.initVirtualSol / v.params.initVirtualTokens;

function Row({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row__k">{k}</span>
      <span className="row__v">{children}</span>
    </div>
  );
}

/** 市场数据：现价、流通市值、FDV、池子、持有人… */
export function SimMarketCard({ v }: { v: SimView }) {
  const { primary, secondary } = useCur();
  const solTo = useSolTo();
  const p = v.params;
  const s = v.pool;
  const price = simPrice(s);
  const circ = simCirculating(p, s);
  return (
    <Card kicker="Market Data" title="市场数据">
      <div className="rows">
        <Row k="现价">
          <span className="mono">
            {fmtPrice(price * solTo[primary], primary)} <span className="dim">· {fmtPrice(price * solTo[secondary], secondary)}</span>
          </span>
        </Row>
        <Row k="SOL 本位价">
          <span className="mono">{fmtTiny(price)} SOL</span>
        </Row>
        <Row k="比开盘">
          <span className={`mono ${price > openPrice(v) * 1.0001 ? 'up' : ''}`}>×{fmtNum(price / openPrice(v), 2)}</span>
        </Row>
        <Row k="市值（流通）">
          <span className="mono">
            <Dual sol={simCircMcap(p, s)} compact withSol />
          </span>
        </Row>
        <Row k="全流通市值 FDV">
          <span className="mono">
            <Dual sol={simMcap(p, s)} compact withSol />
          </span>
        </Row>
        <Row k="流通量">
          <span className="mono">
            {fmtInt(circ)} <span className="muted">（{fmtPct(circ / p.supply, 2)}）</span>
          </span>
        </Row>
        <Row k="池子">
          <span className="mono">
            {fmtSol(simLiquidity(s))} SOL / {fmtCompact(simPoolTokens(p, s))} 枚
          </span>
        </Row>
        <Row k="持有人">
          <span className="mono">{v.holderCount} 人</span>
        </Row>
        <Row k="累计成交">
          <span className="mono">
            {v.stats.trades} 笔 · {fmtSol(v.stats.volumeSol)} SOL
          </span>
        </Row>
        <Row k="历史最高市值">
          <span className="mono">{v.stats.athMcap ? <Dual sol={v.stats.athMcap} compact withSol /> : '—'}</span>
        </Row>
        <Row k="SOL 价格">
          <span className="mono">
            ¥{fmtNum(solTo.cny, 2)} · ${fmtNum(solTo.usd, 2)}
          </span>
        </Row>
      </div>
      <p className="card__note">市值 = 现价 × 大家手里的代币（流通市值），开盘没人买的时候是 0。FDV = 现价 × 总量 20 亿，pump.fun 显示的是这个口径，因为算上了内盘的虚拟储备，开盘就有约 28 SOL。</p>
    </Card>
  );
}

/** 代币的全部参数 */
export function SimTokenCard({ v }: { v: SimView }) {
  const p = v.params;
  const s = v.pool;
  const open = openPrice(v);
  const reserved = p.supply - p.initRealTokens;
  const gradSol = simSolToGraduate({ phase: 'curve', vSol: p.initVirtualSol, vTok: p.initVirtualTokens, rSol: 0, rTok: p.initRealTokens, poolSol: 0, poolTok: 0 });
  const gradPrice = (p.initVirtualSol + gradSol) / (p.initVirtualTokens - p.initRealTokens);
  const bps = (b: number) => fmtPct(b / 10_000, 2);
  return (
    <Card kicker="Token" title="代币信息">
      <div className="rows">
        <Row k="名称 / 代号">
          <b>USVK</b> <span className="muted">/ {p.symbol}</span>
        </Row>
        <Row k="总量">
          <span className="mono">{fmtInt(p.supply)}</span> <span className="muted">（20 亿，固定）</span>
        </Row>
        <Row k="精度">{p.decimals} 位小数</Row>
        <Row k="合约地址">
          <span className="chip chip--warn">模拟盘，未上链</span>
        </Row>
        <Row k="发行方">VectorKeith（公司）</Row>
        <Row k="铸币权限 / 冻结权限">
          <span className="ok">已放弃</span> <span className="muted">（不能增发、不能冻结）</span>
        </Row>
        <Row k="发行方式">pump.fun 规则：内盘 bonding curve → 毕业迁移 PumpSwap</Row>
        <Row k="开盘时间">
          {fmtDate(v.startedAt)} <span className="muted">· 第 {v.round} 轮</span>
        </Row>
        <Row k="开盘价">
          <span className="mono">{fmtTiny(open)} SOL</span>
        </Row>
        <Row k="开盘市值">
          <span className="mono">0</span> <span className="muted">（还没人持有；FDV {fmtNum(open * p.supply, 2)} SOL）</span>
        </Row>
        <Row k="内盘可卖">
          <span className="mono">{fmtInt(p.initRealTokens)}</span> <span className="muted">（{fmtPct(p.initRealTokens / p.supply, 2)}）</span>
        </Row>
        <Row k="预留给外盘池子">
          <span className="mono">{fmtInt(reserved)}</span> <span className="muted">（{fmtPct(reserved / p.supply, 2)}，毕业时和内盘的 SOL 一起进池子）</span>
        </Row>
        <Row k="内盘虚拟储备">
          <span className="mono">
            {fmtNum(p.initVirtualSol, 0)} SOL / {fmtInt(p.initVirtualTokens)} 枚
          </span>
        </Row>
        <Row k="毕业门槛">
          <span className="mono">
            进池 {fmtNum(gradSol, 2)} SOL（含手续费 {fmtNum(gradSol * (1 + curveFeeRate(p)), 2)} SOL）
          </span>
        </Row>
        <Row k="毕业时市值">
          <span className="mono">
            <Dual sol={gradPrice * p.initRealTokens} compact withSol />
          </span>{' '}
          <span className="muted">（FDV {fmtNum(gradPrice * p.supply, 0)} SOL）</span>
        </Row>
        <Row k="内盘手续费">
          {bps(p.curveProtocolBps + p.curveCreatorBps)} <span className="muted">（协议 {bps(p.curveProtocolBps)} + 创作者 {bps(p.curveCreatorBps)}）</span>
        </Row>
        <Row k="外盘手续费">
          {bps(p.ammLpBps + p.ammProtocolBps + p.ammCreatorBps)}{' '}
          <span className="muted">
            （LP {bps(p.ammLpBps)} + 协议 {bps(p.ammProtocolBps)} + 创作者 {bps(p.ammCreatorBps)}）
          </span>
        </Row>
        <Row k="现在阶段">{s.phase === 'curve' ? `内盘（已卖出 ${floorPct(simProgress(p, s))}）` : `外盘 PumpSwap${v.graduatedAt ? `（${fmtDate(v.graduatedAt)} 毕业）` : ''}`}</Row>
        <Row k="创作者费累计（归公司）">
          <span className="mono">{fmtSol(v.stats.creatorFees)} SOL</span>
        </Row>
        <Row k="协议费 / LP 费累计">
          <span className="mono">
            {fmtSol(v.stats.protocolFees)} / {fmtSol(v.stats.lpFees)} SOL
          </span>
        </Row>
      </div>
      <p className="card__note">
        pump.fun 原版总量 10 亿；这里总量 20 亿，虚拟代币储备和可卖数量按比例放大、虚拟 SOL 储备不变，所以毕业要的 SOL 和真实 pump.fun 一样。手续费按 pump.fun 的标准费率。
      </p>
    </Card>
  );
}
