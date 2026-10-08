// 세션 토큰·참가 코드 해시·코드 암호화. 모두 WebCrypto 로 Worker(무상태)에서 계산한다.
// SESSION_SECRET 하나에서 용도별 키를 HMAC 으로 파생해(도메인 분리) 쓴다.

const te = new TextEncoder();
const td = new TextDecoder();

export type Role = 'p' | 'h' | 'b';
export interface PlayerToken { r: 'p'; e: string; p: number; g: number; x: number }
export interface HostToken { r: 'h'; x: number }
export interface BoardToken { r: 'b'; e: string; k: number; x: number }
export type Token = PlayerToken | HostToken | BoardToken;

export const COOKIE = { p: 'qz_p', h: 'qz_h', b: 'qz_b' } as const;
export const SESSION_TTL_SEC = { p: 14 * 3600, h: 12 * 3600, b: 24 * 3600 } as const;

/** 코드 문자: 헷갈리는 0 O 1 I L 제외 (31자) */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

interface Keys { cookie: CryptoKey; code: CryptoKey; enc: CryptoKey; secret: string }
let cached: Keys | null = null;

export class ConfigError extends Error {}

async function keys(secret: string | undefined): Promise<Keys> {
  if (!secret || secret.length < 32) throw new ConfigError('SESSION_SECRET 가 없거나 32자 미만입니다.');
  if (cached && cached.secret === secret) return cached;
  const master = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derive = async (label: string) => new Uint8Array(await crypto.subtle.sign('HMAC', master, te.encode('quiz-v1:' + label)));
  const hmac = (raw: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  cached = {
    secret,
    cookie: await hmac(await derive('cookie')),
    code: await hmac(await derive('code')),
    enc: await crypto.subtle.importKey('raw', await derive('enc'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
  };
  return cached;
}

export async function signToken(secret: string | undefined, t: Token): Promise<string> {
  const k = await keys(secret);
  const body = b64u(te.encode(JSON.stringify(t)));
  const sig = b64u(await crypto.subtle.sign('HMAC', k.cookie, te.encode(body)));
  return body + '.' + sig;
}

export async function verifyToken(secret: string | undefined, value: string | undefined | null): Promise<Token | null> {
  if (!value || value.length > 600) return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const body = value.slice(0, dot);
  try {
    const k = await keys(secret);
    const ok = await crypto.subtle.verify('HMAC', k.cookie, unb64u(value.slice(dot + 1)), te.encode(body));
    if (!ok) return null;
    const t = JSON.parse(td.decode(unb64u(body))) as Token;
    if (typeof t.x !== 'number' || t.x * 1000 < Date.now()) return null;
    return t;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    return null;
  }
}

/** 사용자가 입력한 코드 정리: 전각→반각, 대문자, 영숫자 외 제거 */
export function normalizeCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 32);
}

export function randomCode(len: number): string {
  // 거부 샘플링으로 치우침 없이 뽑는다
  const out: string[] = [];
  const n = CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  while (out.length < len) {
    const buf = crypto.getRandomValues(new Uint8Array(len * 2));
    for (const b of buf) {
      if (b < limit) out.push(CODE_ALPHABET[b % n]);
      if (out.length === len) break;
    }
  }
  return out.join('');
}

export function randomToken(bytes = 24): string {
  return b64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** 참가 코드 → 조회용 해시. 행사 코드를 섞어 다른 행사의 같은 코드와 구분 */
export async function codeHash(secret: string | undefined, eventCode: string, code: string): Promise<string> {
  const k = await keys(secret);
  return b64u(await crypto.subtle.sign('HMAC', k.code, te.encode(eventCode + ':' + code)));
}

export async function encryptCode(secret: string | undefined, code: string): Promise<string> {
  const k = await keys(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k.enc, te.encode(code)));
  return b64u(iv) + '.' + b64u(ct);
}

export async function decryptCode(secret: string | undefined, blob: string): Promise<string> {
  const k = await keys(secret);
  const [iv, ct] = blob.split('.');
  return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, k.enc, unb64u(ct)));
}

/** 진행자 비밀번호 비교 (길이·내용 모두 상수 시간에 가깝게) */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(b)));
  let d = 0;
  for (let i = 0; i < ha.length; i++) d |= ha[i] ^ hb[i];
  return d === 0;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function cookieHeader(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
