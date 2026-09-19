import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '@vantara/db';
import { requireSession, sessionOf, type AppContext } from '../lib/context.ts';

/**
 * المكتبة والاستكشاف — عقد الشاشة، لا عقد التدقيق.
 *
 * `GET /v1/library` يمشي كل صفحات المكتبة عند كل نداء (حتى 80 صفحة × 200 عمل،
 * متسلسلة). هذا صحيح لتدقيق التغطية — «هل ينقص فصل؟» تحتاج الكل — وخاطئ تمامًا
 * كعقد لشاشة: فتح المكتبة بآلاف الأعمال يصبح عشرات الطلبات المتسلسلة قبل أن
 * يُرسم شيء. عقدان مختلفان كانا مدموجين في مسار واحد.
 *
 * هنا العقد الآخر: صفحة واحدة لكل نداء، والترتيب والتصفية عند upstream الذي
 * يملك البيانات (`/api/series/search` يدعم `sort` و`query` و`page`). ولا يلمس
 * هذا الملف مسارات B6 ولا منطق الفصول.
 */

/** ما يفهمه upstream. أي قيمة أخرى تُرفض بدل أن تُمرَّر بهدوء. */
const SORTS = {
  updated: 'updated,desc',
  added: 'added,desc',
  title: 'title,asc',
  unread: 'unread,desc',
  favorites: 'favorites,desc',
  random: 'random,asc',
} as const;

type SortKey = keyof typeof SORTS;

const browseQuery = z.object({
  sort: z.enum(Object.keys(SORTS) as [SortKey, ...SortKey[]]).catch('updated'),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(0).max(500).catch(0),
  size: z.coerce.number().int().min(1).max(100).catch(40),
});

interface SeriesRow {
  id: string;
  name: string;
  booksCount?: number;
  booksUnreadCount?: number;
  booksInProgressCount?: number;
  color?: string | null;
  metadata?: { summary?: string; status?: string } | null;
}

/** الأعمال المحذوفة للجميع لا تظهر في أي وجهة. سياسة يملكها مخزن الخادم. */
async function deletedRefs(): Promise<Set<string>> {
  const rows = await query<{ series_ref: string }>(
    `SELECT series_ref FROM vantara_deleted_works WHERE restored_at IS NULL`,
  );
  return new Set(rows.map((row) => row.series_ref));
}

function present(row: SeriesRow) {
  return {
    id: row.id,
    title: row.name,
    chapters: row.booksCount ?? 0,
    unread: row.booksUnreadCount ?? 0,
    inProgress: row.booksInProgressCount ?? 0,
    accent: row.color ?? null,
    status: row.metadata?.status ?? null,
  };
}

export async function discoveryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * صفحة واحدة من المكتبة، مرتّبة ومفلترة عند upstream.
   *
   * هذا ما تستهلكه شاشة المكتبة. `hasMore` من جواب upstream لا من تخمين الطول:
   * صفحة ناقصة قد تعني آخر صفحة وقد تعني عملًا محذوفًا أُسقط بعد الجلب.
   */
  app.get('/v1/library/browse', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const params = browseQuery.parse(request.query ?? {});
    const session = sessionOf(request);

    let payload;
    try {
      payload = await ctx.uchiyomi.librarySearch(session.token, {
        page: params.page,
        size: params.size,
        sort: SORTS[params.sort],
        ...(params.q !== undefined && params.q !== '' ? { query: params.q } : {}),
      });
    } catch {
      return reply.code(502).send({ error: 'upstream_unavailable' });
    }

    const rows = (payload.content ?? []) as SeriesRow[];
    const deleted = await deletedRefs();

    return reply.send({
      sort: params.sort,
      page: params.page,
      size: params.size,
      total: payload.totalElements ?? null,
      // الصفحة التالية موجودة إن قال upstream ذلك؛ الحذف لا يغيّر الترقيم
      hasMore: payload.last === true ? false : rows.length >= params.size,
      content: rows.filter((row) => row?.id && !deleted.has(row.id)).map(present),
    });
  });

  /**
   * الاستكشاف: أقسام جاهزة للعرض.
   *
   * كل قسم نداء واحد إلى upstream بترتيب مختلف، والأقسام تُجلب بالتوازي. قسم
   * يفشل لا يُفرّغ الشاشة — يعود فارغًا ومعه سبب، ويبقى الباقي. الشاشة بلا
   * استكشاف أفضل من شاشة تسقط كلها لأن قسمًا واحدًا تعثّر.
   */
  app.get('/v1/explore', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const session = sessionOf(request);
    const size = z.coerce.number().int().min(1).max(30).catch(12).parse(
      (request.query as { size?: string } | undefined)?.size,
    );

    const sections: { key: SortKey; title: string }[] = [
      { key: 'unread', title: 'غير مقروء' },
      { key: 'updated', title: 'آخر التحديثات' },
      { key: 'added', title: 'أُضيف حديثًا' },
      { key: 'random', title: 'اكتشف' },
    ];

    const [deleted, ...results] = await Promise.all([
      deletedRefs(),
      ...sections.map((section) =>
        ctx.uchiyomi
          .librarySearch(session.token, { page: 0, size, sort: SORTS[section.key] })
          .then((payload) => ({ ok: true as const, rows: (payload.content ?? []) as SeriesRow[] }))
          .catch(() => ({ ok: false as const, rows: [] as SeriesRow[] })),
      ),
    ]);

    return reply.send({
      content: sections.map((section, index) => {
        const result = results[index] ?? { ok: false as const, rows: [] as SeriesRow[] };
        return {
          key: section.key,
          title: section.title,
          available: result.ok,
          content: result.rows.filter((row) => row?.id && !deleted.has(row.id)).map(present),
        };
      }),
    });
  });

  /**
   * المصادر المتاحة للتصفّح.
   *
   * قائمة أسماء وحالات فقط: أي تفصيل تقني عن المصدر (سبب الفشل، آخر فحص) يبقى
   * في مسارات المصادر، ولا يتسرّب إلى وجهة استكشاف يستعملها القارئ.
   */
  app.get('/v1/explore/sources', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const session = sessionOf(request);
    try {
      const sources = await ctx.uchiyomi.listSources(session.token);
      return reply.send({
        content: sources.map((source) => ({
          id: source.id,
          name: source.name,
          lang: source.lang ?? null,
        })),
      });
    } catch {
      return reply.code(502).send({ error: 'upstream_unavailable' });
    }
  });
}
