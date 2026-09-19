const TOKEN_VERSION = 2 as const;
const ACCESS_TTL_MS = 15 * 60 * 1000;

export interface IdentityTokenInput {
  userId: string;
  deviceId: string;
}

export interface IdentityTokenClaims extends IdentityTokenInput {
  version: typeof TOKEN_VERSION;
  issuedAt: number;
  expiresAt: number;
}

interface WireClaims {
  v: typeof TOKEN_VERSION;
  uid: string;
  did: string;
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function parseClaims(bytes: Uint8Array): WireClaims | null {
  try {
    const value = JSON.parse(decoder.decode(bytes)) as Partial<WireClaims>;
    if (
      value.v !== TOKEN_VERSION ||
      !validString(value.uid) ||
      !validString(value.did) ||
      typeof value.iat !== 'number' ||
      typeof value.exp !== 'number' ||
      !Number.isSafeInteger(value.iat) ||
      !Number.isSafeInteger(value.exp) ||
      value.iat < 0 ||
      value.exp <= value.iat ||
      value.exp - value.iat > ACCESS_TTL_MS
    ) {
      return null;
    }
    return value as WireClaims;
  } catch {
    return null;
  }
}

export async function mintIdentityToken(
  input: IdentityTokenInput,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (!validString(input.userId) || !validString(input.deviceId)) {
    throw new Error('invalid_identity_claims');
  }
  if (!secret) throw new Error('identity_secret_required');

  const claims: WireClaims = {
    v: TOKEN_VERSION,
    uid: input.userId,
    did: input.deviceId,
    iat: now,
    exp: now + ACCESS_TTL_MS,
  };
  const payload = encoder.encode(JSON.stringify(claims));
  const payloadPart = base64UrlEncode(payload);
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payloadPart)),
  );
  return `${payloadPart}.${base64UrlEncode(signature)}`;
}

export async function verifyIdentityToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<IdentityTokenClaims | null> {
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadPart, signaturePart] = parts;
  if (!payloadPart || !signaturePart) return null;

  const payload = base64UrlDecode(payloadPart);
  const signature = base64UrlDecode(signaturePart);
  if (!payload || !signature) return null;

  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      signature,
      encoder.encode(payloadPart),
    );
  } catch {
    return null;
  }
  if (!signatureValid) return null;

  const claims = parseClaims(payload);
  if (!claims || now < claims.iat || now >= claims.exp) return null;

  return {
    version: TOKEN_VERSION,
    userId: claims.uid,
    deviceId: claims.did,
    issuedAt: claims.iat,
    expiresAt: claims.exp,
  };
}
