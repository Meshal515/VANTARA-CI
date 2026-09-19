/**
 * تنقية diagnostics البلاغات.
 *
 * البلاغ يرفق حالة النظام تلقائيًا، وهذا مفيد — وخطر. هذه الطبقة تضمن أن
 * ما يُخزَّن لا يحمل كوكيز ولا توكنات ولا ترويسات مصادقة، حتى لو أرسلها العميل.
 */

const REDACTED = '[redacted]';

const FORBIDDEN_KEY = /(cookie|authorization|auth|token|secret|password|passwd|session|bearer|jwt|apikey|api[-_]?key|credential|set-cookie)/i;

/** توكنات Uchiyomi `uy_…`، JWT، وسلاسل Bearer داخل النصوص. */
const SECRET_IN_TEXT: readonly [RegExp, string][] = [
  [/\buy_[A-Za-z0-9._-]{8,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9._-]{16,}/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, REDACTED],
  [/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, REDACTED],
  // توقيع رابط الصفحة: `?t=<hmac>`.
  //
  // هذا الرابط يفتح الصفحة بلا جلسة ولا ترويسة — هذا قصده. ومفتاحه `t` لا
  // يُشبه سرًّا، وقيمته سداسية بلا نقاط فلا يمسكها نمط JWT. وبلاغ «صفحة
  // ناقصة» يحمل رابط الصفحة بطبيعته، فكانت قدرةُ الفتح تُخزَّن في جدول
  // البلاغات. القيمة وحدها تُشطب ويبقى المفتاح والمسار، وهو ما يفيد التشخيص.
  [/([?&](?:t|sig|signature|token)=)[A-Za-z0-9._%-]{16,}/gi, `$1${REDACTED}`],
];

const MAX_DEPTH = 6;
const MAX_STRING = 4_000;

function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_IN_TEXT) out = out.replace(pattern, replacement);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

/**
 * ينسخ القيمة مع إسقاط كل مفتاح محظور وتنقية كل نص.
 * يقطع عند MAX_DEPTH حتى لا يعلّقه كائن دائري أو عميق.
 */
export function scrubDiagnostics(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (typeof input === 'string') return scrubString(input);
  if (input === null || typeof input !== 'object') return input;

  if (Array.isArray(input)) {
    return input.slice(0, 200).map((item) => scrubDiagnostics(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubDiagnostics(value, depth + 1);
  }
  return out;
}

/** فحص للاختبارات وللتأكيد قبل الكتابة: هل بقي سرّ ظاهر؟ */
export function containsSecret(value: unknown): boolean {
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    if (typeof node === 'string') {
      return SECRET_IN_TEXT.some(([pattern]) => {
        pattern.lastIndex = 0;
        return pattern.test(node);
      });
    }
    if (node === null || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);

    if (Array.isArray(node)) return node.some((item) => walk(item, depth + 1));

    return Object.entries(node).some(
      ([key, child]) =>
        (FORBIDDEN_KEY.test(key) && child !== REDACTED) || walk(child, depth + 1),
    );
  };

  return walk(value, 0);
}
