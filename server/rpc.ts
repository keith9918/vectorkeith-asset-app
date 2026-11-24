// Solana JSON-RPC：HTTP（限流 + 重试 + 多节点回退）与 WebSocket（自动重连 + 自动重订阅）
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export interface RpcEndpoint {
  name: string;
  url: string;
  /** 是否支持索引类请求（getProgramAccounts / getSignaturesForAddress 等） */
  indexed: boolean;
}

export class RpcError extends Error {
  constructor(
    message: string,
    public code?: number,
    public status?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isRateLimited(e: unknown) {
  return e instanceof RpcError && (e.status === 429 || e.code === 429 || e.code === -32429 || /too many/i.test(e.message));
}

export class RpcHttp {
  private inflight = 0;
  private waiters: (() => void)[] = [];
  private lastOk = new Map<string, number>();
  constructor(
    public endpoints: RpcEndpoint[],
    private maxConcurrent = 4,
  ) {}

  private async acquire() {
    if (this.inflight < this.maxConcurrent) {
      this.inflight++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.inflight++;
  }
  private release() {
    this.inflight--;
    this.waiters.shift()?.();
  }

  get primary() {
    return this.endpoints[0];
  }

  private async post(ep: RpcEndpoint, body: unknown, timeoutMs = 20_000): Promise<any> {
    await this.acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new RpcError(`HTTP ${res.status}: ${text.slice(0, 120)}`, undefined, res.status);
      }
      if (!res.ok && !Array.isArray(json) && json?.error) {
        throw new RpcError(json.error.message ?? `HTTP ${res.status}`, json.error.code, res.status);
      }
      if (!res.ok && !Array.isArray(json)) throw new RpcError(`HTTP ${res.status}`, undefined, res.status);
      this.lastOk.set(ep.name, Date.now());
      return json;
    } finally {
      clearTimeout(timer);
      this.release();
    }
  }

  /** indexed：只用支持索引类请求的节点；prefer：把指定名字的节点排到最前面（其余节点作为回退） */
  private pick(indexed?: boolean, prefer?: string) {
    const list = indexed ? this.endpoints.filter((e) => e.indexed) : this.endpoints;
    return prefer ? [...list.filter((e) => e.name === prefer), ...list.filter((e) => e.name !== prefer)] : list;
  }

  async call<T = any>(method: string, params: unknown[] = [], opts: { indexed?: boolean; timeoutMs?: number; prefer?: string } = {}): Promise<T> {
    let lastErr: unknown = new RpcError('无可用 RPC 节点');
    for (const ep of this.pick(opts.indexed, opts.prefer)) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const json = await this.post(ep, { jsonrpc: '2.0', id: 1, method, params }, opts.timeoutMs);
          if (json.error) throw new RpcError(json.error.message, json.error.code);
          return json.result as T;
        } catch (e) {
          lastErr = e;
          if (isRateLimited(e)) {
            await sleep(600 * 2 ** attempt + Math.random() * 300);
            continue;
          }
          if (e instanceof RpcError && e.code !== undefined && e.code !== -32603) break; // 业务错误：换节点
          if (attempt < 1) {
            await sleep(400);
            continue;
          }
          break;
        }
      }
    }
    throw lastErr;
  }

  /** JSON-RPC 批量请求；返回与 calls 等长的结果数组（失败项为 undefined） */
  async batch<T = any>(calls: [string, unknown[]][], opts: { indexed?: boolean } = {}): Promise<(T | undefined)[]> {
    if (!calls.length) return [];
    const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
    let lastErr: unknown;
    for (const ep of this.pick(opts.indexed)) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const json = await this.post(ep, body, 30_000);
          if (!Array.isArray(json)) {
            if (json?.error) throw new RpcError(json.error.message, json.error.code);
            throw new RpcError('批量请求返回格式异常');
          }
          const out: (T | undefined)[] = new Array(calls.length).fill(undefined);
          let limited = 0;
          for (const item of json) {
            if (item.error) {
              if (item.error.code === 429) limited++;
              continue;
            }
            out[item.id] = item.result;
          }
          if (limited === calls.length) throw new RpcError('Too many requests', 429);
          return out;
        } catch (e) {
          lastErr = e;
          if (isRateLimited(e)) {
            await sleep(800 * 2 ** attempt);
            continue;
          }
          break;
        }
      }
    }
    throw lastErr;
  }
}

// ─── WebSocket 订阅 ─────────────────────────────────────────────

type SubMethod = 'accountSubscribe' | 'logsSubscribe' | 'slotSubscribe';
const UNSUB: Record<SubMethod, string> = {
  accountSubscribe: 'accountUnsubscribe',
  logsSubscribe: 'logsUnsubscribe',
  slotSubscribe: 'slotUnsubscribe',
};

interface Sub {
  key: number;
  method: SubMethod;
  params: unknown[];
  cb: (result: any) => void;
  serverId: number | null;
}

/**
 * 断线自动重连（指数退避 + 轮换节点），重连后自动恢复全部订阅。
 * 心跳：WS ping + slot 看门狗（主网约 400ms 一个 slot，15 秒没收到就判定僵死）。
 */
export class RpcSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private subs = new Map<number, Sub>();
  private byServerId = new Map<number, Sub>();
  private pending = new Map<number, Sub>();
  private nextKey = 1;
  private nextReqId = 1000;
  private urlIndex = 0;
  private retry = 0;
  private lastMessageAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private stopped = false;
  connected = false;

  constructor(private urls: string[]) {
    super();
  }

  get currentUrl() {
    return this.urls[this.urlIndex % this.urls.length];
  }

  start() {
    this.stopped = false;
    this.open();
    this.watchdog = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt > 15_000) {
        this.emit('log', `WS 超过 15s 无数据，重连 ${this.currentUrl}`);
        this.ws.terminate();
      } else {
        try {
          this.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 5_000);
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.terminate();
  }

  private open() {
    const url = this.currentUrl;
    const ws = new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.retry = 0;
      this.lastMessageAt = Date.now();
      this.byServerId.clear();
      this.pending.clear();
      this.emit('open', url);
      for (const sub of this.subs.values()) this.sendSubscribe(sub);
    });
    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const sub = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          this.emit('log', `订阅失败 ${sub.method}: ${msg.error.message}`);
          return;
        }
        if (!this.subs.has(sub.key)) {
          // 等待确认期间已被取消
          this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id: this.nextReqId++, method: UNSUB[sub.method], params: [msg.result] }));
          return;
        }
        sub.serverId = msg.result;
        this.byServerId.set(msg.result, sub);
        return;
      }
      if (msg.method && msg.params?.subscription !== undefined) {
        const sub = this.byServerId.get(msg.params.subscription);
        if (sub) {
          try {
            sub.cb(msg.params.result);
          } catch (e) {
            this.emit('log', `订阅回调异常: ${(e as Error).message}`);
          }
        }
      }
    });
    ws.on('pong', () => {
      this.lastMessageAt = Date.now();
    });
    ws.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.byServerId.clear();
      this.pending.clear();
      if (was) this.emit('close', url);
      if (this.stopped) return;
      this.retry++;
      if (this.retry % 2 === 0) this.urlIndex++; // 连续失败则轮换节点
      const delay = Math.min(15_000, 500 * 2 ** Math.min(this.retry, 5));
      setTimeout(() => this.open(), delay);
    });
    ws.on('error', (e) => {
      this.emit('log', `WS 错误 ${url}: ${e.message}`);
    });
  }

  private sendSubscribe(sub: Sub) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = this.nextReqId++;
    this.pending.set(id, sub);
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: sub.method, params: sub.params }));
  }

  subscribe(method: SubMethod, params: unknown[], cb: (result: any) => void): number {
    const sub: Sub = { key: this.nextKey++, method, params, cb, serverId: null };
    this.subs.set(sub.key, sub);
    this.sendSubscribe(sub);
    return sub.key;
  }

  unsubscribe(key: number) {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.subs.delete(key);
    if (sub.serverId !== null) {
      this.byServerId.delete(sub.serverId);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: this.nextReqId++, method: UNSUB[sub.method], params: [sub.serverId] }));
      }
    }
  }
}
