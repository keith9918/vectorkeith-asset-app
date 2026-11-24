// VectorKeith 资产 App —— 服务端入口：REST API + WebSocket 实时推送 + 前端静态托管
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { buildCandles, type Quote } from '../shared/candles';
import { DEFAULT_DIVIDEND_RATIO, DEFAULT_TOKEN_MINT, USVK_MINT } from '../shared/constants';
import type { ClientMessage, ServerMessage, SolRange } from '../shared/types';
import { Access, HttpError, clientIp } from './access';
import { Achievements, type Unlock } from './achievements';
import { Engine } from './engine';
import { Goal } from './goal';
import { computeReport } from './report';
import { Internal, type InternalEvent } from './internal';
import { Push } from './push';
import { Shareholders } from './shareholders';
import { SimMarket } from './sim';
import { SOL_RANGES, SolLevelFeed } from './sollevels';
import { Staking } from './staking';
import { isValidPubkey } from './solana';
import { Stables } from './stables';
import { Treasury } from './treasury';
import { VkChain } from './vkchain';
import type { RpcEndpoint } from './rpc';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* 没有 .env 文件时使用默认配置 */
}

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR ?? 'data');
const WEB_DIR = path.join(ROOT, 'dist', 'web');
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';

// RPC：可在 .env 里配置私有节点（如 Helius），公共节点作为回退
const httpEndpoints: RpcEndpoint[] = [];
const wsEndpoints: string[] = [];
if (process.env.RPC_URL) {
  httpEndpoints.push({ name: 'custom', url: process.env.RPC_URL, indexed: true });
  wsEndpoints.push(process.env.RPC_WS_URL ?? process.env.RPC_URL.replace(/^http/, 'ws'));
}
httpEndpoints.push(
  { name: 'solana-mainnet', url: 'https://api.mainnet-beta.solana.com', indexed: true },
  { name: 'publicnode', url: 'https://solana-rpc.publicnode.com', indexed: false },
);
wsEndpoints.push('wss://api.mainnet-beta.solana.com', 'wss://solana-rpc.publicnode.com');

const TOKEN_MINT = (process.env.TOKEN_MINT || DEFAULT_TOKEN_MINT).trim();
if (!isValidPubkey(TOKEN_MINT)) {
  console.error('请在 .env 里设置 TOKEN_MINT：要跟踪的 pump.fun 代币地址');
  process.exit(1);
}

const engine = new Engine({ dataDir: DATA_DIR, mint: TOKEN_MINT, http: httpEndpoints, ws: wsEndpoints, adminEnabled: ADMIN_KEY.length >= 6 });

// 公司资产 = 公司钱包里的 SOL（钱包名单在 App「设置」里由管理员维护，保存在 data/treasury/）
const DEFAULT_TREASURY_WALLETS: { address: string; label: string }[] = []; // 由管理员在 App「设置」里添加

/** 以前各个代币配置过的公司钱包：都是自己人地址，用来识别冒充它们的"地址投毒"（地址 → 名字） */
const OWN_LABELS: Map<string, string> = (() => {
  const out = new Map<string, string>();
  try {
    for (const d of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, d.name, 'config.json'), 'utf8'));
        for (const w of cfg.companyWallets ?? []) if (typeof w?.address === 'string') out.set(w.address, String(w.label ?? ''));
      } catch {
        /* 这个目录没有配置文件 */
      }
    }
  } catch {
    /* 数据目录还不存在 */
  }
  return out;
})();
const treasury = new Treasury({
  dataDir: DATA_DIR,
  rpc: engine.rpc,
  sock: engine.sock,
  prices: engine.prices,
  privateRpc: engine.hasPrivateRpc,
  defaultWallets: DEFAULT_TREASURY_WALLETS,
  defaultDividendRatio: DEFAULT_DIVIDEND_RATIO,
  rejectAddress: (a) =>
    a === engine.mint
      ? '这是代币合约地址，不是钱包地址'
      : a === engine.curveAddress || a === engine.poolAddress
        ? '这是池子地址，不能设为公司钱包'
        : null,
  knownSymbol: (mint) => (mint === engine.mint ? engine.token?.symbol || undefined : mint === USVK_MINT ? 'USVK' : undefined),
  extraKnown: () => [...OWN_LABELS.keys(), ...shareholders.allWallets(), ...internal.allWallets(), ...(internal.poolWallet ? [internal.poolWallet] : [])],
  stakedSol: () => staking.companyStakedSol(),
  includeStaked: () => staking.includeInAssets,
  stables: () => stables.view(),
  warn: (label, e) => console.warn('[treasury]', label, (e as Error)?.message ?? e),
});
// 公司钱包里的稳定币（官方 USDT / USDC）：计入公司总资产的显示，不计入分红；treasury.totalSol 仍然只是 SOL
const stables = new Stables({
  rpc: engine.rpc,
  wallets: () => treasury.walletConfigs(),
  symbolOf: (mint) => treasury.symbolOf(mint),
  warn: (label, e) => console.warn('[stables]', label, (e as Error)?.message ?? e),
});
stables.on('changed', () => {
  treasury.touch(); // 推送新快照给所有 App
  chain.mirrorChanged();
});
engine.configProvider = () => ({ companyWallets: treasury.walletConfigs(), dividendRatio: treasury.config.dividendRatio });
const goal = new Goal(DATA_DIR);
engine.extraSnapshot = () => ({ treasury: treasury.snapshot(), goal: goal.view() });
engine.setCompanyWallets(treasury.walletConfigs());

// 股东名册 / 访问控制 / 推送提醒
const shareholders = new Shareholders(DATA_DIR, treasury, engine.prices);
const access = new Access(DATA_DIR, ADMIN_KEY, { byId: (id) => shareholders.auth(id), byCode: (c) => shareholders.authByCode(c) });
// 公司内部质押：员工充值的钱进单独的"内部质押钱包"，用另一个金库实例记流水（不计入公司资产、不推送给 App）
const poolTracker = new Treasury({
  dataDir: path.join(DATA_DIR, 'internal'),
  rpc: engine.rpc,
  sock: engine.sock,
  prices: engine.prices,
  privateRpc: engine.hasPrivateRpc,
  defaultWallets: [],
  defaultDividendRatio: 0,
  rejectAddress: (a) => (treasury.isCompanyWallet(a) ? '这是公司钱包：内部质押要用单独的钱包，员工的钱不能混进公司资产' : a === engine.mint ? '这是代币合约地址，不是钱包地址' : null),
  knownSymbol: (mint) => (mint === engine.mint ? engine.token?.symbol || undefined : undefined),
  extraKnown: () => [],
  logTag: 'internal',
  warn: (label, e) => console.warn('[internal]', label, (e as Error)?.message ?? e),
});
const internal = new Internal({
  dataDir: DATA_DIR,
  rpc: engine.rpc,
  prices: engine.prices,
  company: treasury,
  pool: poolTracker,
  poolStaked: async (w) => (await staking.positions([w])).stakedSol,
  isForbiddenWallet: (a) =>
    treasury.isCompanyWallet(a) ? '这是公司钱包，不能登记为员工钱包' : shareholders.allWallets().includes(a) ? '这是股东的收款钱包，不能同时登记为员工钱包' : null,
  warn: (label, e) => console.warn('[internal]', label, (e as Error)?.message ?? e),
});
access.members = { byId: (id) => internal.auth(id), byCode: (c) => internal.authByCode(c) };
// USVK 模拟盘（虚拟 SOL）：公司额度 = 公司总资产；员工 / 客户额度 = 内部质押本金
const sim = new SimMarket({ dataDir: DATA_DIR, companySol: () => treasury.totalSol, principals: () => internal.principals(), solUsd: () => engine.prices.price.usd });
access.traders = { byId: (id) => sim.authById(id), byCode: (c) => sim.authByCode(c), byPassword: (u, pw) => sim.authByPassword(u, pw) };
// 股东查看码、员工登录码、模拟盘登录码、管理员密钥、访问密码互相不能重复
shareholders.isReservedCode = (c) => access.isReservedCode(c) || !!internal.authByCode(c) || !!sim.authByCode(c);
internal.isReservedCode = (c) => access.isReservedCode(c) || !!shareholders.authByCode(c) || !!sim.authByCode(c);
sim.isReservedCode = (c) => access.isReservedCode(c) || !!shareholders.authByCode(c) || !!internal.authByCode(c);
shareholders.forbidWallet = (a) => (internal.allWallets().includes(a) ? '这是员工（内部质押）登记的钱包，不能同时作为股东收款地址' : a === internal.poolWallet ? '这是内部质押钱包，不能作为股东收款地址' : null);
// VK 链（公司自己的单节点测试网，节点在同一台服务器上、只监听本机）：区块浏览器 / App 内钱包 / 发行资产 / 水龙头 / 公开 RPC
const VKCHAIN_RPC = process.env.VKCHAIN_RPC ?? 'http://127.0.0.1:8899';
const chain = new VkChain({
  dataDir: DATA_DIR,
  rpcUrl: VKCHAIN_RPC,
  // WebSocket 端口 = RPC 端口 + 1（Solana 节点的约定）
  wsUrl: process.env.VKCHAIN_WS ?? VKCHAIN_RPC.replace(/^http/, 'ws').replace(/:(\d+)(?=\/|$)/, (_, port) => `:${Number(port) + 1}`),
  cgroupDir: process.env.VKCHAIN_CGROUP ?? '/sys/fs/cgroup/system.slice/vkchain.service',
  publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:8787',
  mirrorIcon: path.join(WEB_DIR, 'icons', 'icon-192.png'),
  warn: (label, e) => console.warn('[vkchain]', label, (e as Error)?.message ?? e),
});
// 公司资产凭证 cSOL：总量 = 「资产」页上的公司总资产（主网公司钱包的 SOL + 计入资产的质押），所有钱包余额读到后才开始同步
let treasuryBalanceReady = false;
chain.setMirrorSource({
  ready: () => treasuryBalanceReady && treasury.walletConfigs().length > 0,
  lamports: () => Math.round(treasury.totalSol * 1e9),
  wallets: () => treasury.walletConfigs().map((w) => ({ address: w.address, label: w.label })),
  stakedSol: () => treasury.stakedSol,
  stable: (symbol) => (stables.ready && treasury.walletConfigs().length > 0 ? stables.rawOf(symbol) : null),
});
const push = new Push(DATA_DIR, access, {
  solTo: () => ({ usd: engine.prices.price.usd, cny: engine.prices.price.usd * engine.prices.price.usdCny }),
  totalSol: () => treasury.totalSol,
  labelOf: (a) => treasury.walletConfigs().find((w) => w.address === a)?.label ?? shareholders.labelOf(a) ?? (OWN_LABELS.get(a) || undefined) ?? staking.validatorName(a),
  holderName: (sid) => shareholders.nameOf(sid),
  holderPaid: (sid) => shareholders.paidTo(sid),
  warn: (label, e) => console.warn('[push]', label, (e as Error)?.message ?? e),
});

// 质押：公司质押中的 SOL 计入总资产（可在设置里关闭）
const staking = new Staking({
  dataDir: DATA_DIR,
  rpc: engine.rpc,
  prices: engine.prices,
  companyWallets: () => treasury.walletConfigs().map((w) => w.address),
  companyPrincipal: () => treasury.stakePrincipal(),
  warn: (label, e) => console.warn('[staking]', label, (e as Error)?.message ?? e),
});
staking.on('company', () => treasury.touch());
treasury.on('ingested', (list: { kind: string }[]) => {
  if (list.some((a) => a.kind === 'stake' || a.kind === 'unstake')) staking.touch();
});

// 成就墙 / SOL 参考价位
const achievements = new Achievements(DATA_DIR, treasury, shareholders, engine.prices);
const solLevels = new SolLevelFeed();

// ─── HTTP ─────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(json);
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

/** 简单限频：每个 IP 每个分组每分钟最多 max 次 */
const hits = new Map<string, number[]>();
function rateLimit(req: http.IncomingMessage, bucket: string, max = 12) {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= max) return false;
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return true;
}

/** App 的网址（推送的 VAPID 联系方式） */
function appOrigin(req: http.IncomingMessage) {
  const o = String(req.headers.origin ?? '');
  if (/^https?:\/\/[^/\s]+$/.test(o)) return o;
  return `https://${String(req.headers.host ?? 'localhost').split(',')[0].trim()}`;
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  if (!fs.existsSync(WEB_DIR)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<meta charset="utf-8"><body style="background:#020b1c;color:#9fb8d9;font-family:sans-serif;padding:24px">' +
        '<h2 style="color:#22d3ee">VectorKeith 服务已启动</h2><p>前端尚未构建：请运行 <code>npm run build</code>，或开发模式下访问 <a style="color:#22d3ee" href="http://localhost:5173">http://localhost:5173</a></p>',
    );
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, rel));
  const inside = file.startsWith(WEB_DIR + path.sep);
  const target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(WEB_DIR, 'index.html');
  const ext = path.extname(target).toLowerCase();
  const hashed = /[\\/]assets[\\/]/.test(target);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  // pipeline：客户端中途断开时会关闭文件句柄（.pipe() 不会，Windows 上文件会一直被占用）
  pipeline(fs.createReadStream(target), res, () => {});
}

/** 访问设置或股东查看码变了：断开已经没有权限的连接，并通知所有 App 重新检查身份 */
function onAccessChanged() {
  for (const c of wss.clients) if (!access.canView(access.verify((c as any).token))) c.close(4401, 'login required');
  broadcast({ t: 'access' });
}

async function adminShareholder(b: any) {
  switch (b?.action) {
    case 'add':
      return { ok: true, id: await shareholders.add(b) };
    case 'update':
      await shareholders.update(b.id, b);
      break;
    case 'remove':
      shareholders.remove(b.id);
      onAccessChanged(); // 这位股东的登录立即失效
      break;
    case 'regen':
      shareholders.regenerate(b.id);
      onAccessChanged();
      break;
    default:
      throw new Error('未知操作');
  }
  return { ok: true };
}

async function adminPayout(b: any) {
  switch (b?.action) {
    case 'add':
      return { ok: true, id: await shareholders.addManual(b) };
    case 'remove':
      shareholders.removeManual(b.id);
      break;
    case 'exclude':
    case 'include':
      shareholders.setExcluded(b.id, b.action === 'exclude');
      break;
    default:
      throw new Error('未知操作');
  }
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  try {
    // VK 链公开接口（RPC 代理 / 资产元数据 / 图标）：外部钱包也会访问，不需要登录
    if (p.startsWith('/chain/') && (await chain.handlePublic(req, res, p, clientIp(req), appOrigin(req)))) return;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Authorization',
      });
      return res.end();
    }
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method Not Allowed' });
      return serveStatic(req, res, p);
    }
    const who = access.principal(req, url);
    const post = () => {
      if (req.method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
      return readBody(req);
    };

    // ─── 不需要登录 ───
    if (p === '/api/health') return send(res, 200, { ok: true, status: engine.status });
    if (p === '/api/access') return send(res, 200, access.info(who));
    if (p === '/api/auth/login') {
      const b = await post();
      return send(res, 200, b?.user ? access.login(b.password, clientIp(req), b.user) : access.login(b?.code, clientIp(req)));
    }
    if (p === '/api/push/key') return send(res, 200, { publicKey: push.publicKey });
    if (p === '/api/push/resubscribe') {
      // Service Worker 自动更换订阅时调用（拿不到登录令牌，以原订阅地址作为凭证）
      push.resubscribe(await post());
      return send(res, 200, { ok: true });
    }
    if (p === '/api/token/image') {
      if (engine.imageFile && fs.existsSync(engine.imageFile)) {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(engine.imageFile).toLowerCase()] ?? 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
        return pipeline(fs.createReadStream(engine.imageFile), res, () => {});
      }
      return send(res, 404, { error: '图片未缓存' });
    }

    // ─── 管理员 ───
    if (p.startsWith('/api/admin/')) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method Not Allowed' });
      if (!access.adminEnabled) return send(res, 403, { error: '服务器未启用管理功能（未设置 ADMIN_KEY）' });
      if (who.role !== 'admin') return send(res, 401, { error: '管理员密钥错误' });
      const body = await readBody(req);
      if (p === '/api/admin/verify') return send(res, 200, { ok: true, token: who.token ?? access.issue('admin') });
      if (p === '/api/admin/config') {
        await treasury.updateConfig(body);
        engine.setCompanyWallets(treasury.walletConfigs()); // 同时推送新配置给所有 App
        return send(res, 200, engine.getConfig());
      }
      if (p === '/api/admin/shareholder') return send(res, 200, await adminShareholder(body));
      if (p === '/api/admin/payout') return send(res, 200, await adminPayout(body));
      if (p === '/api/admin/access') {
        const changed = body.mode !== undefined || body.password !== undefined;
        const r = access.update(body);
        if (changed) onAccessChanged();
        return send(res, 200, r);
      }
      if (p === '/api/admin/push') return send(res, 200, push.updateSettings(body));
      if (p === '/api/admin/internal') {
        const r = await internal.admin(body);
        if (body.action === 'remove-member' || body.action === 'regen') onAccessChanged(); // 这位员工的登录立即失效
        return send(res, 200, r);
      }
      if (p === '/api/admin/goal') return send(res, 200, goal.set(body, treasury.totalSol));
      if (p === '/api/admin/sim') {
        const r = sim.admin(body, clientIp(req));
        if (r.revoke) onAccessChanged(); // 这个模拟盘账号的登录立即失效
        return send(res, 200, r);
      }
      if (p === '/api/admin/chain') return send(res, 200, body?.action === 'view' ? await chain.adminView() : await chain.admin(body));
      if (p === '/api/admin/staking') {
        if (typeof body.includeInAssets === 'boolean') staking.setIncludeInAssets(body.includeInAssets);
        return send(res, 200, { includeInAssets: staking.includeInAssets });
      }
      return send(res, 404, { error: 'Not Found' });
    }

    // ─── 以下需要查看权限（访问模式为"需要访问码"时必须先登录） ───
    if (!access.canView(who)) return send(res, 401, { error: '需要输入访问码', needLogin: true });
    if (p === '/api/snapshot') return send(res, 200, engine.getSnapshot());
    if (p === '/api/trades') {
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') ?? 1000)));
      return send(res, 200, engine.trades.slice(-limit));
    }
    if (p === '/api/candles') {
      const tf = Math.max(1, Math.min(86400, Number(url.searchParams.get('tf') ?? 60)));
      const q = url.searchParams.get('quote');
      const quote: Quote = q === 'sol' ? 'sol' : q === 'cny' ? 'cny' : 'usd';
      const limit = Math.min(10000, Math.max(1, Number(url.searchParams.get('limit') ?? 3000)));
      const fx = { solUsd: engine.prices.price.usd, usdCny: engine.prices.price.usdCny };
      return send(res, 200, buildCandles(engine.trades, tf, quote, fx).slice(-limit));
    }
    if (p === '/api/company/history') return send(res, 200, engine.companyHistory());
    if (p === '/api/treasury/history') return send(res, 200, treasury.history());
    if (p === '/api/shareholders') return send(res, 200, shareholders.view(who));
    if (p === '/api/achievements') return send(res, 200, achievements.view());
    if (p === '/api/report') {
      const year = Number(url.searchParams.get('year')) || Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4));
      if (!(year >= 2020 && year <= 2100)) return send(res, 400, { error: '年份无效' });
      const labels = new Map<string, string>([...OWN_LABELS].filter(([, l]) => l));
      for (const w of treasury.walletConfigs()) labels.set(w.address, w.label);
      return send(
        res,
        200,
        computeReport(year, {
          activity: treasury.allActivity(),
          history: treasury.history(),
          poison: treasury.poisonEvents(),
          payouts: who.role === 'public' ? undefined : shareholders.payouts(),
          achievements: achievements.view(),
          labelOf: (a) => labels.get(a) ?? staking.validatorName(a),
          symbolOf: (m) => treasury.symbolOf(m),
          usdCny: engine.prices.price.usdCny,
          solUsd: engine.prices.price.usd,
        }),
      );
    }
    if (p === '/api/sim') return send(res, 200, sim.view(who));
    if (p === '/api/sim/admin') {
      // 模拟盘管理：管理员密钥，或 admin 账号（只能管模拟盘）
      const body = await post();
      if (!sim.isSimAdmin(who)) return send(res, 403, { error: '只有模拟盘管理员能操作' });
      const r = sim.admin(body, clientIp(req));
      if (r.revoke) onAccessChanged();
      return send(res, 200, r);
    }
    if (p === '/api/sim/password') {
      // 自己改登录密码：旧的登录全部失效，这台设备换一个新令牌
      const body = await post();
      const { id } = sim.changeOwnPassword(who, body, clientIp(req));
      onAccessChanged();
      return send(res, 200, { ok: true, token: who.role === 'trader' ? access.issue('trader', id) : undefined });
    }
    if (p === '/api/sim/trades') return send(res, 200, sim.ticks(who, Number(url.searchParams.get('after')) || 0));
    if (p === '/api/sim/trade') {
      const body = await post();
      if (!rateLimit(req, 'sim-trade', 40)) return send(res, 429, { error: '操作太频繁，请稍后再试' });
      return send(res, 200, sim.trade(who, body));
    }
    if (p.startsWith('/api/chain/')) {
      // VK 链：浏览器数据（GET）/ 组装、广播交易、水龙头（POST，按 IP 限频）
      const body = req.method === 'POST' ? await readBody(req, 512 * 1024) : undefined; // 发行资产时可能带图标
      if (body && !rateLimit(req, p === '/api/chain/faucet' ? 'chain-faucet' : 'chain-tx', p === '/api/chain/faucet' ? 6 : 40)) return send(res, 429, { error: '操作太频繁，请稍后再试' });
      if (!body && p !== '/api/chain/overview' && !rateLimit(req, 'chain-q', 600)) return send(res, 429, { error: '查询太频繁，请稍后再试' });
      return send(res, 200, await chain.api(p, url.searchParams, body, clientIp(req), appOrigin(req)));
    }
    if (p === '/api/sol/levels') return send(res, 200, await solLevels.levels(engine.prices.price.usd, treasury.allActivity()));
    if (p === '/api/staking') return send(res, 200, await staking.view());
    if (p === '/api/internal') return send(res, 200, await internal.view(who));
    if (p === '/api/internal/prepare') {
      // 员工充值 / 管理员一键发放：只组装未签名交易并在链上模拟
      const body = await post();
      if (!rateLimit(req, 'chain')) return send(res, 429, { error: '操作太频繁，请稍后再试' });
      return send(res, 200, await internal.prepare(who, body));
    }
    if (p === '/api/internal/sent') return send(res, 200, internal.sent(who, await post()));
    if (p === '/api/internal/redeem') {
      const body = await post();
      if (!rateLimit(req, 'redeem', 6)) return send(res, 429, { error: '操作太频繁，请稍后再试' });
      return send(res, 200, internal.requestRedeem(who, body));
    }
    if (p === '/api/stake/wallet') {
      // 查询任意钱包的质押（只读）
      const address = String(url.searchParams.get('address') ?? '').trim();
      if (!isValidPubkey(address)) return send(res, 400, { error: '钱包地址无效' });
      if (!rateLimit(req, 'stake-q', 20)) return send(res, 429, { error: '查询太频繁，请稍后再试' });
      return send(res, 200, await staking.positions([address], url.searchParams.get('fresh') === '1'));
    }
    if (p === '/api/stake/holders') {
      // 股东个人质押：管理员看全部，股东只看自己（按名册里登记的收款钱包）
      if (who.role !== 'admin' && who.role !== 'holder') return send(res, 403, { error: '股东或管理员登录后才能查看' });
      const holders = shareholders.view(who).holders.filter((h) => h.wallets.length);
      const out = [];
      for (const h of holders) out.push({ sid: h.id, name: h.name, pct: h.pct, wallets: h.wallets, positions: await staking.positions(h.wallets) });
      return send(res, 200, out);
    }
    if (p === '/api/stake/prepare') {
      // 只组装未签名交易并在链上模拟；签名在用户自己的钱包里完成
      const body = await post();
      if (!rateLimit(req, 'chain')) return send(res, 429, { error: '操作太频繁，请稍后再试' });
      return send(res, 200, await staking.prepare(body));
    }
    if (p === '/api/stake/sent') {
      const body = await post();
      if (rateLimit(req, 'stake-sent', 10) && isValidPubkey(String(body.owner ?? ''))) staking.touch(String(body.owner));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/sol/candles') {
      const range = url.searchParams.get('range') as SolRange;
      if (!SOL_RANGES.includes(range)) return send(res, 400, { error: '时间范围无效' });
      return send(res, 200, await solLevels.candles(range));
    }
    if (p === '/api/wallet/preview') {
      // 管理员添加公司钱包前预览：余额、交易数量（按 IP 限频）
      if (!rateLimit(req, 'chain')) return send(res, 429, { error: '操作太频繁，请稍后再试' });
      return send(res, 200, await treasury.previewWallet(url.searchParams.get('address')));
    }
    if (p === '/api/burn/prepare') {
      // 只组装未签名的交易（签名在用户自己的钱包里完成）；每次会查链 + 模拟，按 IP 限频防止耗尽 RPC 额度
      const body = await post();
      if (!rateLimit(req, 'chain')) return send(res, 429, { error: '操作太频繁，请稍后再试' });
      return send(res, 200, await engine.prepareBurn(body.owner, body.amount));
    }
    if (p === '/api/push/subscribe') {
      const body = await post();
      if (!rateLimit(req, 'push')) return send(res, 429, { error: '操作太频繁，请稍后再试' });
      return send(res, 200, push.subscribe(body, who, appOrigin(req), String(body.device ?? '').slice(0, 40) || undefined));
    }
    if (p === '/api/push/unsubscribe') {
      push.unsubscribe((await post()).endpoint);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/push/status') return send(res, 200, push.status(url.searchParams.get('endpoint')));
    if (p === '/api/push/test') {
      const body = await post();
      if (!rateLimit(req, 'push-test', 6)) return send(res, 429, { error: '测试太频繁，请稍后再试' });
      await push.test(body.endpoint);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not Found' });
  } catch (e) {
    return send(res, e instanceof HttpError ? e.status : 400, { error: (e as Error).message });
  }
});

// ─── WebSocket 推送 ───────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/chain/rpc') return chain.handleUpgrade(req, socket, head, clientIp(req)); // VK 链 WebSocket 订阅（外部钱包）
  if (pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
  if (!access.canView(access.verify(token))) {
    ws.close(4401, 'login required'); // App 收到 4401 会显示输入访问码的页面
    return;
  }
  (ws as any).token = token;
  (ws as any).isAlive = true;
  ws.on('pong', () => ((ws as any).isAlive = true));
  ws.send(JSON.stringify({ t: 'snapshot', data: engine.getSnapshot() } satisfies ServerMessage));
  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', id: msg.id, serverTime: Date.now() } satisfies ServerMessage));
  });
});

const broadcast = (msg: ServerMessage) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState !== WebSocket.OPEN) continue;
    // 背压保护：慢客户端只跳过高频的 slot 心跳
    if (msg.t === 'slot' && c.bufferedAmount > 256 * 1024) continue;
    c.send(data);
  }
};
engine.on('message', broadcast);
treasury.on('message', broadcast);
shareholders.on('changed', (rev: number) => broadcast({ t: 'shareholders', rev }));
internal.on('changed', (rev: number) => {
  broadcast({ t: 'internal', rev });
  sim.touch(); // 内部质押本金变了 = 模拟盘额度变了
});
sim.on('changed', (rev: number) => broadcast({ t: 'sim', rev }));
internal.on('events', (list: InternalEvent[]) => push.onInternal(list));
shareholders.on('payouts', (list) => push.onPayouts(list));
treasury.on('activity', (list) => {
  push.onActivity(list);
  if (list.some((a: { tokens: unknown[] }) => a.tokens.length)) stables.touch();
});
treasury.on('balance', (total: number) => {
  push.onBalance(total);
  goal.check(total);
  treasuryBalanceReady = true;
  chain.mirrorChanged(); // VK 链上的公司资产凭证（cSOL）跟着同步
});
staking.on('company', () => setTimeout(() => goal.check(treasury.totalSol), 500));
staking.on('company', () => chain.mirrorChanged());
goal.on('changed', (reached: boolean, total?: number) => {
  broadcast({ t: 'goal', goal: goal.view(), reached });
  if (reached) push.onGoal(goal.view()!, total ?? treasury.totalSol);
});
achievements.on('changed', (rev: number, fresh: Unlock[]) => {
  broadcast({ t: 'achievements', rev, unlocked: fresh.map((u) => u.key) });
  if (fresh.length) {
    console.log(`[achievements] 解锁：${fresh.map((u) => u.key).join(', ')}`);
    push.onUnlock(fresh);
  }
});

setInterval(() => {
  for (const c of wss.clients) {
    if (!(c as any).isAlive) {
      c.terminate();
      continue;
    }
    (c as any).isAlive = false;
    c.ping();
  }
}, 20_000);

// ─── 启动 ─────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log(`\n  ▸ VectorKeith 链上资产服务  http://localhost:${PORT}`);
  console.log(`  ▸ RPC: ${httpEndpoints.map((e) => e.name).join(' → ')}   管理功能: ${ADMIN_KEY.length >= 6 ? '已启用' : '未启用'}   访问模式: ${access.settings.mode === 'code' ? '需要访问码' : '公开'}   股东 ${shareholders.count} 位\n`);
});

chain.start();
engine
  .start()
  .then(() => treasury.start())
  .then(() => staking.start())
  .then(() => poolTracker.start())
  .then(() => stables.start())
  .then(() => achievements.recheck())
  .catch((e) => console.error('[engine] 启动失败', e));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    treasury.stop();
    stables.stop();
    staking.stop();
    poolTracker.stop();
    chain.stop();
    engine.stop();
    process.exit(0);
  });
}
