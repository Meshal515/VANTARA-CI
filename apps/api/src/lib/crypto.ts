import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * مفتاح مشتق من SESSION_SECRET بـHKDF، مع info مختلفة لكل استخدام، حتى لا
 * يُستخدم نفس المفتاح لتشفير التوكنات وتوقيع الكوكيز.
 */
export function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'vantara-v1', info, 32));
}

/** يُرجع `nonce.tag.ciphertext` بـbase64url. */
export function encrypt(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [nonce, tag, ciphertext].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('malformed ciphertext');

  const [nonceB64, tagB64, dataB64] = parts as [string, string, string];
  const nonce = Buffer.from(nonceB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');

  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('malformed ciphertext');
  }

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  // final() يرمي إذا فشل التحقق من الـtag — أي أن النص عُدِّل
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** معرّف جلسة: 256 بت عشوائية، لا تخمين ولا تسلسل. */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** مقارنة بزمن ثابت لسلسلتين قد تختلفان طولًا. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
