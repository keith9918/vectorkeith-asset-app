// 外部 HTTP 小工具：带超时的 JSON 请求
export async function getJson<T = any>(url: string, timeoutMs = 10_000, init: RequestInit = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function getBuffer(url: string, timeoutMs = 15_000): Promise<{ buf: Buffer; type: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? 'application/octet-stream' };
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
