// SOL 价格：实时（多源回退）+ 历史分钟价（给历史成交标注当时的美元价）+ 美元兑人民币汇率
import { WSOL_MINT } from '../shared/constants';
import type { SolPrice } from '../shared/types';
import { getJson } from './http';

type Source = [name: string, fetcher: () => Promise<number>];

// 按顺序尝试。api.binance.com 对美国 IP 返回 451，data-api.binance.vision（公开行情域名）全球可用
const USD_SOURCES: Source[] = [
  ['Binance', async () => Number((await getJson('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT')).price)],
  ['Binance', async () => Number((await getJson('https://data-api.binance.vision/api/v3/ticker/price?symbol=SOLUSDT')).price)],
  ['Coinbase', async () => Number((await getJson('https://api.coinbase.com/v2/prices/SOL-USD/spot')).data.amount)],
  ['Jupiter', async () => Number((await getJson(`https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`))[WSOL_MINT].usdPrice)],
  ['CoinGecko', async () => Number((await getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')).solana.usd)],
];

/** 失败的数据源暂停一段时间再试，避免每轮都先请求一个被地区封锁的接口 */
const SOURCE_COOLDOWN_MS = 10 * 60_000;

const CNY_SOURCES: Source[] = [
  [
    'CoinGecko',
    async () => {
      const j = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,cny');
      return Number(j.solana.cny) / Number(j.solana.usd);
    },
  ],
  ['ER-API', async () => Number((await getJson('https://open.er-api.com/v6/latest/USD')).rates.CNY)],
];

export class SolPriceFeed {
  price: SolPrice = { usd: 0, usdCny: 7.1, source: '—', updatedAt: 0 };
  onUpdate: ((p: SolPrice) => void) | null = null;
  private minute = new Map<number, number>(); // 分钟起点(ms) → 收盘价
  private hour = new Map<number, number>();
  private timers: NodeJS.Timeout[] = [];
  private cooldownUntil = new Map<number, number>(); // USD_SOURCES 下标 → 暂停到何时

  async start() {
    await Promise.allSettled([this.refreshUsd(), this.refreshCny()]);
    this.timers.push(setInterval(() => void this.refreshUsd(), 8_000));
    this.timers.push(setInterval(() => void this.refreshCny(), 10 * 60_000));
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  private async refreshUsd() {
    const now = Date.now();
    for (let i = 0; i < USD_SOURCES.length; i++) {
      if ((this.cooldownUntil.get(i) ?? 0) > now) continue;
      const [name, fn] = USD_SOURCES[i];
      try {
        const v = await fn();
        if (!(v > 0)) throw new Error('无效价格');
        const changed = v !== this.price.usd;
        this.price = { ...this.price, usd: v, source: name, updatedAt: Date.now() };
        this.minute.set(Math.floor(Date.now() / 60_000) * 60_000, v);
        if (changed) this.onUpdate?.(this.price);
        return;
      } catch {
        this.cooldownUntil.set(i, now + SOURCE_COOLDOWN_MS); // 换下一个源
      }
    }
    this.cooldownUntil.clear(); // 全部失败：下一轮全部重新尝试
  }

  private async refreshCny() {
    for (const [, fn] of CNY_SOURCES) {
      try {
        const v = await fn();
        if (v > 3 && v < 15) {
          this.price = { ...this.price, usdCny: v };
          this.onUpdate?.(this.price);
          return;
        }
      } catch {
        /* 换下一个源 */
      }
    }
  }

  /** 拉取 [fromSec, toSec] 的历史 SOL/USD（≤3 天用 1 分钟 K，更长用 1 小时 K） */
  async loadHistory(fromSec: number, toSec: number) {
    if (!(toSec >= fromSec)) return;
    const useHour = toSec - fromSec > 3 * 86400;
    const step = useHour ? 3_600_000 : 60_000;
    const map = useHour ? this.hour : this.minute;
    let start = Math.floor((fromSec * 1000) / step) * step;
    const end = toSec * 1000 + step;
    for (let guard = 0; start <= end && guard < 60; guard++) {
      // 已有缓存则跳过
      let cached = true;
      for (let t = start; t <= Math.min(end, start + step * 999); t += step) {
        if (!map.has(t)) {
          cached = false;
          break;
        }
      }
      if (cached) {
        start += step * 1000;
        continue;
      }
      let rows: any[] = [];
      for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
        try {
          rows = await getJson(`${host}/api/v3/klines?symbol=SOLUSDT&interval=${useHour ? '1h' : '1m'}&startTime=${start}&endTime=${end}&limit=1000`, 12_000);
          break;
        } catch {
          rows = [];
        }
      }
      if (!rows.length) break;
      for (const r of rows) map.set(Number(r[0]), Number(r[4]));
      start = Number(rows[rows.length - 1][0]) + step;
      if (rows.length < 1000) break;
    }
  }

  /** 某时刻的 SOL/USD；没有历史数据时返回 0 */
  usdAt(tsSec: number): number {
    const ms = tsSec * 1000;
    const m = this.minute.get(Math.floor(ms / 60_000) * 60_000);
    if (m) return m;
    const h = this.hour.get(Math.floor(ms / 3_600_000) * 3_600_000);
    if (h) return h;
    // 最近 10 分钟内的分钟价
    for (let k = 1; k <= 10; k++) {
      const v = this.minute.get(Math.floor(ms / 60_000) * 60_000 - k * 60_000);
      if (v) return v;
    }
    return 0;
  }
}
