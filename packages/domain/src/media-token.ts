/**
 * رابط وسائط موقَّع، قصير العمر.
 *
 * المشكلة (BE-P0-06): صور القارئ محمية بجلسة الـAPI، و`<img src>` **لا يستطيع**
 * حمل ترويسة `Authorization` — المتصفح لا يسمح. فالصور تعتمد اليوم على كوكي،
 * والكوكي cross-site من أصل الـAPK (`https://localhost`) طريق مسدود: `Lax` لا
 * يُرسل، و`None` يعتمد على كوكي طرف ثالث وهو في طريق الزوال.
 *
 * البديل: التوقيع في الرابط نفسه. `<img src>` يحمله بطبيعته، ولا يحتاج كوكي
 * ولا ترويسة.
 *
 * أربع قواعد حاكمة:
 *
 * 1. **قصير العمر.** رابط بلا انتهاء = رابط دائم للمحتوى. دقائق تكفي لفتح فصل،
 *    ولا تكفي لمشاركة مكتبة كاملة.
 *
 * 2. **مربوط بالمسار.** التوقيع يغطّي المسار الكامل، فرابط صفحة لا يفتح صفحة
 *    أخرى ولا فصلًا آخر بتعديل رقم.
 *
 * 3. **مربوط بالمستخدم.** التوقيع يغطّي المعرّف أيضًا: رابط يُسرَّب لا يصبح
 *    رابطًا عامًّا، ويمكن تمييز من سُرِّب منه.
 *
 * 4. **المقارنة بالتحقق لا بالنص.** `crypto.subtle.verify` لا `===`: مقارنة
 *    النصوص تتسرّب منها فروق التوقيت.
 *
 * هذا الملف يعرّف الشكل والقواعد. ربطه بمسار الصور يحتاج عقد الهوية من باتش
 * الهوية الموحدة (من هو المستخدم، ومن أين يأتي السرّ) — ولذلك لا يُغلق B3 قبله.
 */

/** أقصى عمر مسموح لرابط وسائط. */
export const MAX_MEDIA_TOKEN_TTL_MS = 10 * 60_000;
/** العمر الافتراضي: يكفي لفتح فصل وقراءته بلا تجديد في المنتصف. */
export const DEFAULT_MEDIA_TOKEN_TTL_MS = 5 * 60_000;

export interface MediaClaim {
  /** المسار المحمي كاملًا، كما سيُطلب. */
  path: string;
  /** صاحب الرابط. */
  userId: string;
  /** لحظة الانتهاء (ms). */
  expiresAt: number;
}

/**
 * أسباب الرفض.
 *
 * لا `path_mismatch` بينها بقصد: المسار داخل التوقيع، فطلبه لمسار آخر يظهر
 * `bad_signature`. سبب لا يُرجَع أبدًا يضلّل من يقرأ الكود.
 */
export type MediaTokenFailure = 'malformed' | 'expired' | 'bad_signature';

export interface MediaTokenResult {
  ok: boolean;
  claim?: MediaClaim;
  reason?: MediaTokenFailure;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * مفتاح HMAC من السرّ.
 *
 * بلا تعليق نوع صريح بقصد: `CryptoKey` من مكتبة DOM، وهذه الحزمة تُبنى بـES2023
 * وحدها لتبقى محايدة البيئة — تعمل في Node وفي Worker. الاستنتاج يكفي.
 */
async function key(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** ما يُوقَّع: المسار والمستخدم والانتهاء، بفواصل لا تظهر في أيٍّ منها. */
function payloadOf(claim: MediaClaim): string {
  return `${claim.path}\n${claim.userId}\n${claim.expiresAt}`;
}

/**
 * يُنشئ توقيعًا لرابط.
 *
 * العمر مسقوف: طالبٌ يطلب يومًا يحصل على السقف، لا على ما طلب. الرفض كان
 * سيجعل عميلًا قديمًا يفشل بلا سبب ظاهر، والسقف يجعله يعمل بأمان.
 */
export async function signMediaPath(input: {
  path: string;
  userId: string;
  secret: string;
  now?: number;
  ttlMs?: number;
}): Promise<{ token: string; expiresAt: number }> {
  const now = input.now ?? Date.now();
  const ttl = Math.min(Math.max(1_000, input.ttlMs ?? DEFAULT_MEDIA_TOKEN_TTL_MS), MAX_MEDIA_TOKEN_TTL_MS);
  const claim: MediaClaim = { path: input.path, userId: input.userId, expiresAt: now + ttl };

  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(input.secret),
    new TextEncoder().encode(payloadOf(claim)),
  );

  const head = base64url(new TextEncoder().encode(`${claim.userId}\n${claim.expiresAt}`));
  return { token: `${head}.${base64url(new Uint8Array(signature))}`, expiresAt: claim.expiresAt };
}

/**
 * يتحقق من توقيع رابط.
 *
 * يرجع سببًا واضحًا عند الفشل — انتهى، أو لمسار آخر، أو توقيع خاطئ — لأن
 * «صورة مكسورة» بلا سبب أسوأ شيء يمكن تشخيصه في قارئ.
 */
export async function verifyMediaToken(input: {
  token: string;
  path: string;
  secret: string;
  now?: number;
}): Promise<MediaTokenResult> {
  const now = input.now ?? Date.now();
  const [head, signature] = input.token.split('.');
  if (!head || !signature) return { ok: false, reason: 'malformed' };

  let userId = '';
  let expiresAt = 0;
  try {
    const decoded = new TextDecoder().decode(fromBase64url(head));
    const [id, exp] = decoded.split('\n');
    if (!id || !exp) return { ok: false, reason: 'malformed' };
    userId = id;
    expiresAt = Number(exp);
    if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed' };
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const claim: MediaClaim = { path: input.path, userId, expiresAt };

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await key(input.secret),
      fromBase64url(signature),
      new TextEncoder().encode(payloadOf(claim)),
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // التوقيع أولًا ثم الانتهاء: الترتيب المعاكس يقول «انتهى» لتوقيع ملفَّق،
  // فيتعلّم المهاجم أن المسار صحيح وأن المشكلة في الوقت وحده.
  if (!valid) return { ok: false, reason: 'bad_signature' };
  if (expiresAt <= now) return { ok: false, claim, reason: 'expired' };
  return { ok: true, claim };
}

/** الرابط الكامل كما يوضع في `<img src>`. */
export function mediaUrl(base: string, path: string, token: string): string {
  const root = base.replace(/\/+$/, '');
  const separator = path.includes('?') ? '&' : '?';
  return `${root}${path}${separator}t=${encodeURIComponent(token)}`;
}
