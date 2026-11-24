// ───────────────────────────────────────────────────────────────
//  访问控制
//  · 模式：public = 知道网址就能看（默认）；code = 必须输入访问码
//  · 访问码五种：管理员密钥 → 管理员；股东查看码 → 股东（只看自己的分红）；员工登录码 → 员工（内部质押）；
//    模拟盘登录码 → 模拟盘的员工 / 客户（USVK 模拟交易）；通用访问密码 → 访客
//  · 登录后发一个签名令牌（HMAC-SHA256，180 天）。令牌里带版本号：
//    改访问密码 / 重新生成股东查看码 / 删除股东 / 换管理员密钥后，旧令牌立即失效
// ───────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { AccessInfo, AccessMode, AccessSettings, Role, SimKind } from '../shared/types';
import { JsonFile } from './store';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Principal {
  role: Role;
  sid?: string; // 股东 id
  token?: string;
}

/** 校验令牌时需要的股东信息 */
export interface HolderAuth {
  id: string;
  name: string;
  code: string; // 规范化后的查看码
  codeVer: number;
  kind?: SimKind; // 模拟盘账号：员工 / 客户
}

export interface HolderLookup {
  byId(id: string): HolderAuth | undefined;
  byCode(normalizedCode: string): HolderAuth | undefined;
}

interface AccessFile {
  mode: AccessMode;
  password: string;
  version: number; // 访客令牌的版本：改密码时 +1
}

const TOKEN_DAYS = 180;
const MAX_FAILS = 10; // 每个 IP 15 分钟内最多输错 10 次

/** 查看码规范化：忽略大小写、空格和横线（ABCD-EFGH = abcdefgh） */
export const normCode = (s: string) =>
  String(s ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function clientIp(req: http.IncomingMessage) {
  // Caddy 会覆盖客户端自带的 X-Forwarded-For，第一项就是真实 IP
  return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '')
    .split(',')[0]
    .trim();
}

export class Access {
  settings: AccessFile;
  private file: JsonFile<AccessFile>;
  private secret: Buffer;
  private adminVer: string;
  private fails = new Map<string, number[]>();

  /** 员工（内部质押）：和股东一样用 8 位登录码 */
  members: HolderLookup | null = null;
  /** USVK 模拟盘的账号：账号 + 密码，或 8 位登录码 */
  traders: (HolderLookup & { byPassword(user: unknown, pw: unknown): HolderAuth | undefined }) | null = null;

  constructor(
    dataDir: string,
    private adminKey: string,
    private holders: HolderLookup,
  ) {
    const dir = path.join(dataDir, 'access');
    this.file = new JsonFile(path.join(dir, 'config.json'), 0);
    const cfg = this.file.read();
    this.settings = {
      mode: cfg?.mode === 'code' ? 'code' : 'public',
      password: typeof cfg?.password === 'string' ? cfg.password : '',
      version: Number(cfg?.version) || 1,
    };
    if (!cfg) this.file.writeNow(this.settings);

    // 令牌签名密钥：首次启动随机生成，只保存在服务器上
    const keyFile = path.join(dir, 'secret.key');
    let secret: Buffer | null = null;
    try {
      secret = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    } catch {
      /* 第一次启动 */
    }
    if (!secret || secret.length < 32) {
      secret = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, secret.toString('hex'), { mode: 0o600 });
    }
    this.secret = secret;
    this.adminVer = crypto.createHash('sha256').update(`vk-admin:${adminKey}`).digest('hex').slice(0, 12);
  }

  get adminEnabled() {
    return this.adminKey.length >= 6;
  }

  isAdminKey(given: string) {
    return this.adminEnabled && !!given && safeEqual(given, this.adminKey);
  }

  /** 新的股东查看码不能和管理员密钥、访问密码撞上 */
  isReservedCode(normalized: string) {
    return (this.adminEnabled && normCode(this.adminKey) === normalized) || (!!this.settings.password && normCode(this.settings.password) === normalized);
  }

  // ─── 令牌 ────────────────────────────────────────────────────

  private sign(payload: string) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue(role: Exclude<Role, 'public'>, sid?: string): string {
    let v: string | number;
    if (role === 'admin') v = this.adminVer;
    else if (role === 'viewer') v = this.settings.version;
    else if (role === 'member') {
      const m = this.members?.byId(String(sid));
      if (!m) throw new HttpError(404, '员工不存在');
      v = m.codeVer;
    } else if (role === 'trader') {
      const t = this.traders?.byId(String(sid));
      if (!t) throw new HttpError(404, '模拟盘账号不存在');
      v = t.codeVer;
    } else {
      const h = this.holders.byId(String(sid));
      if (!h) throw new HttpError(404, '股东不存在');
      v = h.codeVer;
    }
    const payload = Buffer.from(JSON.stringify({ r: role, s: sid, v, e: Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400 })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /** 验证令牌；无效、过期、已撤销都当作没登录 */
  verify(token: string | null | undefined): Principal {
    const none: Principal = { role: 'public' };
    if (!token || token.length > 600) return none;
    const dot = token.indexOf('.');
    if (dot < 1) return none;
    const payload = token.slice(0, dot);
    if (!safeEqual(token.slice(dot + 1), this.sign(payload))) return none;
    let p: any;
    try {
      p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return none;
    }
    if (!(Number(p?.e) > Date.now() / 1000)) return none;
    if (p.r === 'admin') return this.adminEnabled && p.v === this.adminVer ? { role: 'admin', token } : none;
    if (p.r === 'viewer') return this.settings.password && p.v === this.settings.version ? { role: 'viewer', token } : none;
    if (p.r === 'holder') {
      const h = this.holders.byId(String(p.s));
      return h && p.v === h.codeVer ? { role: 'holder', sid: h.id, token } : none;
    }
    if (p.r === 'member') {
      const m = this.members?.byId(String(p.s));
      return m && p.v === m.codeVer ? { role: 'member', sid: m.id, token } : none;
    }
    if (p.r === 'trader') {
      const t = this.traders?.byId(String(p.s));
      return t && p.v === t.codeVer ? { role: 'trader', sid: t.id, token } : none;
    }
    return none;
  }

  /** 请求的身份：X-Admin-Key、Authorization: Bearer 令牌，或 ?token= */
  principal(req: http.IncomingMessage, url: URL): Principal {
    if (this.isAdminKey(String(req.headers['x-admin-key'] ?? ''))) return { role: 'admin' };
    const auth = String(req.headers.authorization ?? '');
    return this.verify(auth.startsWith('Bearer ') ? auth.slice(7).trim() : url.searchParams.get('token'));
  }

  canView(p: Principal) {
    return this.settings.mode === 'public' || p.role !== 'public';
  }

  info(p: Principal): AccessInfo {
    const h =
      p.role === 'holder' && p.sid
        ? this.holders.byId(p.sid)
        : p.role === 'member' && p.sid
          ? this.members?.byId(p.sid)
          : p.role === 'trader' && p.sid
            ? this.traders?.byId(p.sid)
            : undefined;
    return { mode: this.settings.mode, role: p.role, sid: h?.id, name: h?.name, kind: h?.kind, needLogin: !this.canView(p) };
  }

  /** 访问码登录（按 IP 限制输错次数，防止暴力猜码） */
  login(raw: unknown, ip: string, user?: unknown): { token: string; info: AccessInfo } {
    const now = Date.now();
    const recent = (this.fails.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= MAX_FAILS) throw new HttpError(429, '输错次数太多，请 15 分钟后再试');
    const code = String(raw ?? '').trim().slice(0, 100);
    let role: Exclude<Role, 'public'> | null = null;
    let sid: string | undefined;
    const username = String(user ?? '').trim();
    if (username) {
      // 账号 + 密码（模拟盘）
      const t = this.traders?.byPassword(username, raw);
      if (t) {
        role = 'trader';
        sid = t.id;
      }
    } else if (code && this.isAdminKey(code)) role = 'admin';
    else if (code) {
      const h = this.holders.byCode(normCode(code));
      const m = h ? undefined : this.members?.byCode(normCode(code));
      const t = h || m ? undefined : this.traders?.byCode(normCode(code));
      if (h) {
        role = 'holder';
        sid = h.id;
      } else if (m) {
        role = 'member';
        sid = m.id;
      } else if (t) {
        role = 'trader';
        sid = t.id;
      } else if (this.settings.password && safeEqual(code, this.settings.password)) role = 'viewer';
    }
    if (!role) {
      recent.push(now);
      this.fails.set(ip, recent);
      if (this.fails.size > 5000) this.fails.clear();
      const what = username ? '账号或密码不对' : '访问码不对';
      throw new HttpError(401, recent.length >= MAX_FAILS - 3 ? `${what}（再错 ${MAX_FAILS - recent.length} 次要等 15 分钟）` : what);
    }
    const token = this.issue(role, sid);
    return { token, info: this.info({ role, sid, token }) };
  }

  // ─── 管理 ───────────────────────────────────────────────────

  view(): AccessSettings {
    return { mode: this.settings.mode, password: this.settings.password };
  }

  update(input: { mode?: unknown; password?: unknown }): AccessSettings {
    if (input.password !== undefined) {
      const pw = String(input.password ?? '').trim();
      if (pw && pw.length < 4) throw new Error('访问密码至少 4 位');
      if (pw.length > 64) throw new Error('访问密码最多 64 位');
      if (pw && this.isAdminKey(pw)) throw new Error('访问密码不能和管理员密钥一样');
      if (pw && (this.holders.byCode(normCode(pw)) || this.members?.byCode(normCode(pw)) || this.traders?.byCode(normCode(pw)))) throw new Error('访问密码和某个查看码 / 登录码重复了，请换一个');
      if (pw !== this.settings.password) {
        this.settings.password = pw;
        this.settings.version++; // 旧密码登录的设备全部失效
      }
    }
    if (input.mode !== undefined) {
      if (input.mode !== 'public' && input.mode !== 'code') throw new Error('访问模式无效');
      this.settings.mode = input.mode;
    }
    this.file.writeNow(this.settings);
    return this.view();
  }
}
