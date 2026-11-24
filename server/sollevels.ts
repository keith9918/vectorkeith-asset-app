// SOL 参考价位（"如果 SOL 涨到…"模拟器用）：历史最高、今年最高 / 最低（币安 K 线，取不到时用 CoinGecko），
// 以及公司钱包收到 SOL 时的加权平均价格、第一笔入账的价格（来自资金流水）
import type { SolCandle, SolCandles, SolLevels, SolRange, TreasuryActivity } from '../shared/types';
import { getJson } from './http';

type Market = Pick<SolLevels, 'ath' | 'yearHigh' | 'yearLow'>;

const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

async function klines(query: string): Promise<any[]> {
  for (const host of HOSTS) {
    try {
      const rows = await getJson<any[]>(`${host}/api/v3/klines?symbol=SOLUSDT&${query}`, 12_000);
      if (Array.isArray(rows) && rows.length) return rows;
    } catch {
      /* 换下一个 */
    }
  }
  return [];
}

/** 每个时间范围用多大的 K 线、缓存多久 */
const RANGES: Record<SolRange, { interval: string; sec: number; limit: number; ttl: number; cg: string }> = {
  '24h': { interval: '5m', sec: 300, limit: 288, ttl: 60_000, cg: '1' },
  '7d': { interval: '1h', sec: 3600, limit: 168, ttl: 5 * 60_000, cg: '7' },
  '30d': { interval: '4h', sec: 14400, limit: 180, ttl: 15 * 60_000, cg: '30' },
  '1y': { interval: '1d', sec: 86400, limit: 365, ttl: 3600_000, cg: '365' },
  all: { interval: '1w', sec: 604800, limit: 1000, ttl: 6 * 3600_000, cg: 'max' },
};
export const SOL_RANGES = Object.keys(RANGES) as SolRange[];

export class SolLevelFeed {
  private candleCache = new Map<SolRange, { at: number; data: SolCandles }>();
  private candleLoading = new Map<SolRange, Promise<SolCandles>>();

  /** SOL/USD K 线（币安；取不到时用 CoinGecko 的 OHLC，粒度会粗一些） */
  async candles(range: SolRange): Promise<SolCandles> {
    const cfg = RANGES[range];
    const hit = this.candleCache.get(range);
    if (hit && Date.now() - hit.at < cfg.ttl) return hit.data;
    let p = this.candleLoading.get(range);
    if (!p) {
      p = (async (): Promise<SolCandles> => {
        const rows = await klines(`interval=${cfg.interval}&limit=${cfg.limit}`);
        if (rows.length) {
          const candles: SolCandle[] = rows.map((r) => ({ t: Math.floor(Number(r[0]) / 1000), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));
          return { range, sec: cfg.sec, candles, source: 'Binance' };
        }
        const cg = await getJson<number[][]>(`https://api.coingecko.com/api/v3/coins/solana/ohlc?vs_currency=usd&days=${cfg.cg}`, 12_000);
        const candles = cg.map((r) => ({ t: Math.floor(r[0] / 1000), o: r[1], h: r[2], l: r[3], c: r[4] }));
        const sec = candles.length > 1 ? candles[1].t - candles[0].t : cfg.sec;
        return { range, sec, candles, source: 'CoinGecko' };
      })()
        .then((data) => {
          if (data.candles.length) this.candleCache.set(range, { at: Date.now(), data });
          return data;
        })
        .catch((e) => {
          if (hit) return hit.data; // 都失败时用旧数据
          throw e;
        })
        .finally(() => this.candleLoading.delete(range));
      this.candleLoading.set(range, p);
    }
    return p;
  }

  private cache: { at: number; data: Market } | null = null;
  private loading: Promise<Market> | null = null;

  private async fetchMarket(): Promise<Market> {
    const out: Market = {};
    // 历史最高：月 K 线的最高价
    const monthly = await klines('interval=1M&limit=1000');
    for (const r of monthly) {
      const high = Number(r[2]);
      if (!out.ath || high > out.ath.usd) out.ath = { usd: high, t: Math.floor(Number(r[0]) / 1000) };
    }
    // 今年最高 / 最低：日 K 线
    const jan1 = Date.UTC(new Date().getUTCFullYear(), 0, 1);
    const daily = await klines(`interval=1d&startTime=${jan1}&limit=1000`);
    for (const r of daily) {
      const t = Math.floor(Number(r[0]) / 1000);
      const high = Number(r[2]);
      const low = Number(r[3]);
      if (!out.yearHigh || high > out.yearHigh.usd) out.yearHigh = { usd: high, t };
      if (!out.yearLow || low < out.yearLow.usd) out.yearLow = { usd: low, t };
    }
    if (!out.ath) {
      try {
        const j = await getJson<any>('https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false&community_data=false&developer_data=false', 12_000);
        const usd = Number(j?.market_data?.ath?.usd);
        const t = Date.parse(j?.market_data?.ath_date?.usd ?? '');
        if (usd > 0) out.ath = { usd, t: Number.isFinite(t) ? Math.floor(t / 1000) : 0 };
      } catch {
        /* 取不到就不显示 */
      }
    }
    return out;
  }

  private async market(): Promise<Market> {
    if (this.cache && Date.now() - this.cache.at < 6 * 3600_000) return this.cache.data;
    this.loading ??= this.fetchMarket()
      .then((data) => {
        if (data.ath || data.yearHigh) this.cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async levels(now: number, activity: readonly TreasuryActivity[]): Promise<SolLevels> {
    const ins = activity.filter((a) => !a.failed && !a.dust && a.deltaSol > 0 && (a.kind === 'in' || a.kind === 'sell') && a.solUsd > 0);
    const w = ins.reduce((s, a) => s + a.deltaSol, 0);
    const m = await this.market();
    // 当前价可能比 K 线里的历史最高还高
    if (m.ath && now > m.ath.usd) m.ath = { usd: now, t: Math.floor(Date.now() / 1000) };
    return {
      now,
      ...m,
      avgIn: w > 0 ? ins.reduce((s, a) => s + a.deltaSol * a.solUsd, 0) / w : undefined,
      firstIn: ins[0] ? { usd: ins[0].solUsd, t: ins[0].ts } : undefined,
    };
  }
}
