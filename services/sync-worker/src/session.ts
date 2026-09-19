/**
 * Legacy sync-handler token.
 *
 * B2 no longer exposes this format to clients: `secure-index.ts` verifies the
 * trusted-device VANTARA identity token first, then mints this short token only
 * for the duration of delegation into the old sync handlers. B3 removes this
 * adapter when transport/auth cleanup reaches the handlers themselves.
 */

const encoder = new TextEncoder();
const TOKEN_TTL_MS = 15 * 60 * 1000;

interface TokenPayload {
  uid: string;
  iat: number;
  exp: number;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// النوع مُثبَّت على ArrayBuffer لا ArrayBufferLike: crypto.subtle يطلب
// BufferSource، وSharedArrayBuffer لا يُقبل فيه
function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function keyFor(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function mintToken(userId: string, secret: string, now = Date.now()): Promise<string> {
  const payload: TokenPayload = { uid: userId, iat: now, exp: now + TOKEN_TTL_MS };
  const body = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), encoder.encode(body));
  return `${body}.${base64urlEncode(new Uint8Array(signature))}`;
}

/** يعيد الـuser_id أو null بعد التحقق من التوقيع والعمر. */
export async function verifyToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await keyFor(secret),
      base64urlDecode(signature),
      encoder.encode(body),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(body))) as TokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp <= now) return null;
  return payload.uid;
}

/** التوكن من ترويسة Authorization. */
export function bearerFrom(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
