// 批量拉取交易详情（两轮）：
//  1. publicnode：快（实测约 20 次/秒），但只保留最近几天的交易，更早的返回 null；
//  2. publicnode 没有的，交给 Solana 官方节点（有完整历史，但公共访问只能维持 ~0.8 次/秒）。
// 429 限流时退避后重试同一条；其他错误跳过这一条（留给下次续跑）。
import { sleep } from './http';
import { isRateLimited, type RpcHttp } from './rpc';

export interface FetchOptions {
  privateRpc: boolean;
  onTx: (sig: string, tx: any) => void | Promise<void>;
  onProgress?: (done: number, total: number) => void;
  warn: (label: string, e: unknown) => void;
}

const TX_OPTS = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' };

/** 返回没拉到的签名（下次续跑） */
export async function fetchTransactions(rpc: RpcHttp, sigs: string[], o: FetchOptions): Promise<string[]> {
  let done = 0;
  const total = sigs.length;

  if (o.privateRpc) {
    const left: string[] = [];
    for (let i = 0; i < sigs.length; i += 20) {
      const chunk = sigs.slice(i, i + 20);
      try {
        const txs = await rpc.batch<any>(chunk.map((s) => ['getTransaction', [s, TX_OPTS]]), { indexed: true });
        for (let k = 0; k < chunk.length; k++) {
          if (txs[k]) await o.onTx(chunk[k], txs[k]);
          else left.push(chunk[k]);
        }
      } catch (e) {
        o.warn('getTransaction 批量', e);
        left.push(...chunk);
      }
      done = Math.min(total, i + 20);
      o.onProgress?.(done, total);
    }
    return left;
  }

  const loop = async (list: string[], opts: { prefer?: string; indexed?: boolean }, basePace: number) => {
    const missing: string[] = [];
    let pace = basePace;
    let strikes = 0;
    for (let i = 0; i < list.length; ) {
      let tx: any;
      try {
        tx = await rpc.call('getTransaction', [list[i], TX_OPTS], opts);
      } catch (e) {
        if (!isRateLimited(e)) {
          o.warn(`getTransaction ${list[i].slice(0, 10)}…`, e);
          missing.push(list[i]);
          i++;
          continue;
        }
        strikes++;
        if (strikes > 6) {
          o.warn('getTransaction 持续限流（本轮暂停，稍后续跑）', e);
          return { missing: [...missing, ...list.slice(i)], aborted: true };
        }
        pace = Math.min(5_000, pace * 2 + 200);
        await sleep(3_000 * strikes);
        continue;
      }
      strikes = 0;
      if (tx) {
        await o.onTx(list[i], tx);
        o.onProgress?.(++done, total);
      } else missing.push(list[i]);
      i++;
      if (i < list.length) await sleep(pace);
    }
    return { missing, aborted: false };
  };

  const first = await loop(sigs, { prefer: 'publicnode' }, 100);
  if (!first.missing.length || first.aborted) return first.missing;
  const second = await loop(first.missing, { indexed: true }, 1_300);
  return second.missing;
}
