// 代币元数据：Token-2022 metadata 扩展 → IPFS JSON（描述/图片/社交链接）→ 图片本地缓存
import fs from 'node:fs';
import path from 'node:path';
import type { TokenInfo } from '../shared/types';
import { getBuffer, getJson } from './http';
import type { RpcHttp } from './rpc';

const GATEWAYS = [
  'https://pump.mypinata.cloud/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
  'https://4everland.io/ipfs/',
  'https://ipfs.io/ipfs/',
];

/** 把任意 IPFS 链接展开成多个网关候选（ipfs.io 已限流，放最后） */
export function ipfsCandidates(uri: string): string[] {
  const m = uri.match(/(?:ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]+)(\/[^?#]*)?/);
  if (!m) return [uri];
  const cidPath = m[1] + (m[2] ?? '');
  return GATEWAYS.map((g) => g + cidPath);
}

async function fetchFirstJson(urls: string[]) {
  for (const u of urls) {
    try {
      return await getJson(u, 8_000);
    } catch {
      /* 下一个网关 */
    }
  }
  return null;
}

export async function loadTokenInfo(
  rpc: RpcHttp,
  mint: string,
  dataDir: string,
  cached: TokenInfo | null,
): Promise<{ info: TokenInfo; imageFile: string | null }> {
  const acc = await rpc.call<any>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const v = acc?.value;
  if (!v) throw new Error('mint 账户不存在');
  const info = v.data?.parsed?.info ?? {};
  const decimals = Number(info.decimals ?? 6);
  const supply = Number(info.supply ?? 0) / 10 ** decimals;
  const md = (info.extensions ?? []).find((e: any) => e.extension === 'tokenMetadata')?.state;

  const metadataUri: string = md?.uri ?? cached?.metadataUri ?? '';
  let json: any = null;
  if (metadataUri) json = await fetchFirstJson(ipfsCandidates(metadataUri));

  const imageRemote: string = json?.image ?? cached?.imageRemote ?? '';
  let imageFile: string | null = null;
  if (imageRemote) {
    const existing = ['jpg', 'png', 'webp', 'gif'].map((e) => path.join(dataDir, `token-image.${e}`)).find((f) => fs.existsSync(f));
    if (existing) imageFile = existing;
    else {
      for (const u of ipfsCandidates(imageRemote)) {
        try {
          const { buf, type } = await getBuffer(u, 12_000);
          if (buf.length < 100) continue;
          const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg';
          imageFile = path.join(dataDir, `token-image.${ext}`);
          fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(imageFile, buf);
          break;
        } catch {
          /* 下一个网关 */
        }
      }
    }
  }

  const tokenInfo: TokenInfo = {
    mint,
    name: (md?.name ?? json?.name ?? cached?.name ?? '').trim(),
    symbol: (md?.symbol ?? json?.symbol ?? cached?.symbol ?? '').trim(),
    description: (json?.description ?? cached?.description ?? '').trim(),
    image: imageFile ? '/api/token/image' : imageRemote ? ipfsCandidates(imageRemote)[0] : '',
    imageRemote,
    decimals,
    supply,
    tokenProgram: v.owner,
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    updateAuthority: md ? (md.updateAuthority ?? null) : (cached?.updateAuthority ?? null),
    metadataUri,
    createdAt: cached?.createdAt ?? 0,
    website: json?.website || cached?.website || undefined,
    twitter: json?.twitter || cached?.twitter || undefined,
    telegram: json?.telegram || cached?.telegram || undefined,
  };
  return { info: tokenInfo, imageFile };
}
