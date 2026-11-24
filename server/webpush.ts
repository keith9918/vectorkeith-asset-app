// ───────────────────────────────────────────────────────────────
//  Web Push 协议（只用 Node 自带 crypto，不依赖第三方库）
//  · RFC 8291：消息端到端加密（aes128gcm）——推送服务（苹果 / 谷歌 / 微软 / Mozilla）看不到内容
//  · RFC 8292：VAPID 身份签名（ES256 JWT）——证明消息来自本服务器
// ───────────────────────────────────────────────────────────────
import crypto from 'node:crypto';

export interface VapidKeys {
  publicKey: string; // base64url，65 字节未压缩 P-256 公钥（前端订阅时用）
  privateKey: string; // PKCS#8 PEM
}

export interface PushTarget {
  endpoint: string;
  p256dh: string; // base64url
  auth: string; // base64url
}

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: raw.toString('base64url'), privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string };
}

/** VAPID JWT：aud = 推送服务的 origin，exp ≤ 24 小时，sub = 联系方式（网址或 mailto:） */
export function vapidJwt(audience: string, subject: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: audience, exp: nowSec + 12 * 3600, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

/**
 * RFC 8291 加密。返回请求体：salt(16) | rs(4) | idlen(1) | 服务器临时公钥(65) | 密文+tag。
 * test 参数只在测试时用来固定随机数。
 */
export function encryptPayload(plaintext: Buffer, p256dh: string, auth: string, test?: { salt: Buffer; ecdh: crypto.ECDH }): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('订阅公钥无效');
  if (authSecret.length < 16) throw new Error('订阅密钥无效');
  if (plaintext.length > 3800) throw new Error('推送内容太长');
  let ecdh = test?.ecdh;
  if (!ecdh) {
    ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey(); // 65 字节未压缩
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hkdf(shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]), 32);
  const salt = test?.salt ?? crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 单条记录：明文后加 0x02（最后一条记录的分隔符），不填充
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** 只允许发往正规推送服务（防止有人把内网地址登记成"订阅"让服务器去请求） */
const PUSH_HOSTS = ['.googleapis.com', '.push.apple.com', '.notify.windows.com', '.push.services.mozilla.com'];
export function isPushEndpoint(endpoint: string) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((h) => `.${u.hostname}`.endsWith(h));
  } catch {
    return false;
  }
}

/** 发送一条推送，返回推送服务的 HTTP 状态码（201 = 成功；404 / 410 = 订阅已失效） */
export async function sendPush(
  target: PushTarget,
  payload: object,
  vapid: VapidKeys,
  subject: string,
  opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {},
): Promise<{ status: number; text: string }> {
  if (!isPushEndpoint(target.endpoint)) return { status: 400, text: '不是推送服务地址' };
  const body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), target.p256dh, target.auth);
  const res = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(opts.ttl ?? 86400),
      Urgency: opts.urgency ?? 'normal',
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      Authorization: `vapid t=${vapidJwt(new URL(target.endpoint).origin, subject, vapid.privateKey)}, k=${vapid.publicKey}`,
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = (await res.text().catch(() => '')).slice(0, 300);
  return { status: res.status, text };
}
