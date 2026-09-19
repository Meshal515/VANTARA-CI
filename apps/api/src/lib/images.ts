/**
 * بروكسي صور واحد.
 *
 * الصور تُقدَّم عبر VANTARA لا مباشرة: المتصفح يحمل كوكي VANTARA المبهم فقط،
 * وصور Uchiyomi تحتاج توكنه — والتوكن يبقى عند الخادم فلا يُقرأ من الصفحة.
 *
 * وُضع هنا لأن مسارين يحتاجانه: `/v1/img/*` بجلسة وبتوكن المستخدم، و
 * `/v1/media/page/*` برابط موقَّع وبتوكن الخدمة. الفرق بينهما **من يُصرَّح له**
 * لا **كيف تُنقل البايتات**، فنسختان من النقل تعني عيبًا يُصلح في واحدة ويبقى
 * في الأخرى.
 *
 * لا يُعاد إلا ما يُثبت أنه صورة: مصدر يرجع صفحة تحدٍّ بترويسة HTML كان سيصل
 * للقارئ كصورة مكسورة بلا تفسير.
 */
import type { FastifyReply } from 'fastify';

/** ما يُقبل من المنبع. أي شيء آخر ليس صورة ولو قال إنه كذلك. */
export const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
]);

/** مهلة الصفحة الواحدة. ويبتون كامل الصفحة قد يتجاوز عشر ثوانٍ على مصدر بطيء. */
const UPSTREAM_TIMEOUT_MS = 60_000;

/** أصغر عرض له معنى، وأكبر عرض نسمح بأن يُعالجه المنبع. */
const MIN_MAX_WIDTH = 64;
const MAX_MAX_WIDTH = 4096;

/**
 * `?maxWidth=` كما يُمرَّر للمنبع.
 *
 * يُسقَف ولا يُسقَط: إسقاط قيمة خارج المدى يعني طلب الصورة **بحجمها الكامل** —
 * أي عكس ما يحمي منه الحدّ بالضبط، فـ`?maxWidth=99999` كان يجلب أثقل مما
 * يجلبه `?maxWidth=4096`.
 *
 * وقيمة غير رقمية تُهمل: عميل قديم يمرّر شيئًا غريبًا يحصل على الحجم الطبيعي
 * لا على خطأ.
 */
export function maxWidthSuffix(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  const value = Number(raw);
  if (!Number.isFinite(value)) return '';
  const clamped = Math.min(Math.max(Math.trunc(value), MIN_MAX_WIDTH), MAX_MAX_WIDTH);
  return `?maxWidth=${String(clamped)}`;
}

export async function streamUpstreamImage(input: {
  reply: FastifyReply;
  /** أصل Uchiyomi بلا شرطة أخيرة. */
  base: string;
  /** توكن المستخدم أو توكن الخدمة — القرار عند المُنادي. */
  token: string;
  /** مسار الصورة عند المنبع، مع أي query. */
  path: string;
}): Promise<FastifyReply> {
  const { reply, base, token, path } = input;

  const upstream = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!upstream.ok || !upstream.body) {
    return reply.code(upstream.status === 404 ? 404 : 502).send({ error: 'image_unavailable' });
  }

  const type = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    return reply.code(502).send({ error: 'not_an_image', contentType: type });
  }

  const length = upstream.headers.get('content-length');
  if (length !== null) void reply.header('content-length', length);

  return (
    reply
      .header('content-type', type)
      // الصفحة لا تتغير لنفس المعرّف؛ الكاش الخاص يجعل التمرير للخلف فوريًا.
      // `private` حتى للرابط الموقَّع: الوسيط المشترك لا يجوز أن يخدم صفحةً لمن
      // لا يملك رابطًا موقَّعًا.
      .header('cache-control', 'private, max-age=86400, immutable')
      .send(upstream.body)
  );
}
