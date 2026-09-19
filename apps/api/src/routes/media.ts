import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { signMediaPath, verifyMediaToken } from '@vantara/domain';
import { requireSession, sessionOf, type AppContext } from '../lib/context.ts';
import { maxWidthSuffix, streamUpstreamImage } from '../lib/images.ts';

/**
 * صور القارئ برابط موقَّع.
 *
 * `<img src>` لا يحمل ترويسة `Authorization` — المتصفح لا يسمح. والكوكي
 * cross-site من أصل الـAPK طريق مسدود: `Lax` لا يُرسل، و`None` يعتمد على كوكي
 * طرف ثالث وهو في طريق الزوال. والبروكسي عبر `fetch` إلى `blob:` يعني تحميل
 * الصفحة كاملة في الذاكرة قبل عرضها، وهذا انتحار في ويبتون طويل.
 *
 * فالإذن يُحمل في الرابط نفسه: `POST /v1/media/pages` يوقّع روابط الفصل بجلسة
 * صالحة، ثم `GET /v1/media/page/...` يتحقق من التوقيع **بلا أي اعتماد** —
 * ولذلك يعمل من أي أصل.
 *
 * ثلاث قواعد حاكمة:
 *
 * 1. **الإذن في التوقيع لا في الجلسة.** المسار العام لا يقرأ كوكي ولا ترويسة،
 *    فلا يتأثر بنموذج الجلسة ولا ينتظر عقد الهوية.
 *
 * 2. **بايتات الصفحة ليست بيانات مستخدم.** الصفحة نفسها لكل من يملك الحساب،
 *    فالجلب من المنبع بتوكن الخدمة. التحكم في *من يرى* عند التوقيع، لا عند
 *    البايتات.
 *
 * 3. **لا يُعاد إلا ما يُثبت أنه صورة.** مصدر يرجع صفحة تحدٍّ بترويسة HTML كان
 *    سيصل للقارئ كصورة مكسورة بلا تفسير.
 */

/** سقف الفصل الواحد. فصل أطول من هذا لا يُوقَّع دفعة واحدة. */
const MAX_PAGES_PER_MINT = 300;

const mintBody = z.object({
  bookId: z.string().min(1).max(200),
  pages: z.array(z.coerce.number().int().min(0).max(10_000)).min(1).max(MAX_PAGES_PER_MINT),
});

/** المسار الموقَّع: بلا query بقصد — انظر التعليق في مسار العرض. */
function pagePath(bookId: string, page: number): string {
  return `/v1/media/page/${encodeURIComponent(bookId)}/${String(page)}`;
}

export async function mediaRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const base = ctx.config.UCHIYOMI_URL.replace(/\/+$/, '');

  /**
   * يوقّع روابط صفحات فصل.
   *
   * يحتاج جلسة — وهنا وحده. الروابط الناتجة نسبية: العميل يضع عنوان الـAPI
   * الذي يعرفه، فلا نخبز عنوانًا في جواب يُخزَّن أو يُمرَّر.
   */
  app.post(
    '/v1/media/pages',
    {
      preHandler: requireSession(ctx),
      // ‏300 توقيع HMAC في النداء الواحد عملٌ حقيقي. القراءة الطبيعية نداء لكل
      // فصل (ومثله للتسخين)، فهذا السقف بعيد جدًّا عنها ويمنع استنزافها.
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      // بلا توكن خدمة لن يخدم المسار العام شيئًا. قول ذلك **عند التوقيع** يجعل
      // العميل يسقط إلى مسار الكوكي مرة واحدة للفصل؛ الصمت هنا كان سيعطيه
      // ثلاثين رابطًا كلها 503 — أي فصلًا من صور مكسورة.
      if (!ctx.config.UCHIYOMI_SERVICE_TOKEN) {
        return reply.code(503).send({ error: 'media_unconfigured' });
      }

      const parsed = mintBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

      const session = sessionOf(request);
      const unique = [...new Set(parsed.data.pages)];

      const urls = await Promise.all(
        unique.map(async (page) => {
          const path = pagePath(parsed.data.bookId, page);
          const { token, expiresAt } = await signMediaPath({
            path,
            userId: session.userId,
            secret: ctx.config.SESSION_SECRET,
          });
          return { page, path, token, expiresAt };
        }),
      );

      return reply.send({
        bookId: parsed.data.bookId,
        // أقرب انتهاء: العميل يجدّد قبله بدل أن يراقب كل رابط
        expiresAt: Math.min(...urls.map((entry) => entry.expiresAt)),
        content: urls.map((entry) => ({
          page: entry.page,
          url: `${entry.path}?t=${encodeURIComponent(entry.token)}`,
        })),
      });
    },
  );

  const streamImage = async (reply: FastifyReply, path: string): Promise<FastifyReply> => {
    // توكن الخدمة لا توكن المستخدم: البايتات ليست بيانات مستخدم، والإذن
    // أُثبت عند التوقيع. وبلا توكن خدمة لا نخمّن — نقول ذلك صريحًا بـ503 كي
    // يسقط العميل إلى `/v1/img/page/*` بالكوكي بدل صورة مكسورة.
    const serviceToken = ctx.config.UCHIYOMI_SERVICE_TOKEN;
    if (!serviceToken) return reply.code(503).send({ error: 'media_unconfigured' });

    return streamUpstreamImage({ reply, base, token: serviceToken, path });
  };

  /**
   * صفحة واحدة، بلا أي اعتماد.
   *
   * `maxWidth` خارج التوقيع بقصد: نفس الصورة بحجم آخر ليست محتوى آخر، وإدخالها
   * في التوقيع يعني رابطًا لكل حجم. الحدّ يمنع إساءة استخدامها كعبء معالجة.
   */
  app.get('/v1/media/page/:id/:n', async (request, reply) => {
    const { id, n } = request.params as { id: string; n: string };
    const query = request.query as { t?: string; maxWidth?: string } | undefined;
    const page = z.coerce.number().int().min(0).max(10_000).safeParse(n);
    if (!page.success) return reply.code(400).send({ error: 'bad_request' });

    const token = typeof query?.t === 'string' ? query.t : '';
    if (!token) return reply.code(401).send({ error: 'signature_required' });

    const verdict = await verifyMediaToken({
      token,
      path: pagePath(id, page.data),
      secret: ctx.config.SESSION_SECRET,
    });
    if (!verdict.ok) {
      // السبب يُقال: «صورة مكسورة» بلا سبب أسوأ ما يمكن تشخيصه في قارئ.
      // انتهى ⇒ 401 ليعرف العميل أن التجديد يكفي؛ توقيع خاطئ ⇒ 403.
      const expired = verdict.reason === 'expired';
      return reply.code(expired ? 401 : 403).send({ error: verdict.reason });
    }

    return streamImage(
      reply,
      `/img/books/${encodeURIComponent(id)}/page/${String(page.data)}${maxWidthSuffix(query?.maxWidth)}`,
    );
  });
}
