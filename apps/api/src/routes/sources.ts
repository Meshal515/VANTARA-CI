import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '@vantara/db';
import {
  looksRelevant,
  toPublicSource,
  verdictFrom,
  type ProbeEvidence,
  type SourceVerdict,
} from '@vantara/domain';
import { requireSession, sessionOf, type AppContext } from '../lib/context.ts';

interface VerdictRow {
  source_id: string;
  source_name: string;
  lang: string | null;
  verdict: SourceVerdict;
  evidence: ProbeEvidence | Record<string, never>;
  tested_at: Date | null;
  last_success_at: Date | null;
  notes: string | null;
}

const SEARCH_LANGUAGE_RANK: Record<string, number> = { ar: 0, en: 1 };

export function rankProvidersByLanguage<T extends { source: string }>(
  providers: readonly T[],
  sourceLanguages: ReadonlyMap<string, string | null>,
): T[] {
  const rank = (provider: T): number => {
    const language = sourceLanguages.get(provider.source);
    return language ? (SEARCH_LANGUAGE_RANK[language] ?? 2) : 3;
  };
  return [...providers].sort((a, b) => rank(a) - rank(b));
}


/**
 * هوية عمل داخل مصدر. لا تُخلط مع Uchiyomi series id:
 * provider.sourceId هو source-specific series id، بينما *_ref عند VANTARA هو
 * canonical Uchiyomi series id.
 */
export function sourceIdentity(source: string, sourceSeriesId: string): string {
  return JSON.stringify([source, sourceSeriesId]);
}

interface SeriesWithSources {
  sources?: readonly { sourceId: string; sourceSeriesId: string }[];
}

/**
 * يحوّل canonical Uchiyomi series refs إلى الهويات الدقيقة التي قد تظهر بها
 * نفس السلسلة في search-all عبر المصادر.
 */
export async function sourceKeysForSeriesRefs(
  seriesRefs: Iterable<string>,
  loadSeries: (seriesRef: string) => Promise<SeriesWithSources | undefined>,
): Promise<Set<string>> {
  const refs = [...new Set(seriesRefs)].filter(Boolean);
  if (refs.length === 0) return new Set();

  const rows = await Promise.all(refs.map((ref) => loadSeries(ref)));
  const keys = new Set<string>();
  for (const series of rows) {
    for (const source of series?.sources ?? []) {
      if (!source.sourceId || !source.sourceSeriesId) continue;
      keys.add(sourceIdentity(source.sourceId, source.sourceSeriesId));
    }
  }
  return keys;
}


interface SourceRegistryRow {
  source_id: string;
  lang: string | null;
  verdict: SourceVerdict;
}

export function sourceSearchPolicy(rows: readonly SourceRegistryRow[]): {
  filterSources: boolean;
  allowedSources: Set<string>;
  sourceLanguages: Map<string, string | null>;
} {
  const supported = rows.filter((row) => row.verdict === 'SUPPORTED');
  return {
    // فقط السجل الفيزيائي الفارغ يعني أول تشغيل بلا sync.
    filterSources: rows.length > 0,
    allowedSources: new Set(supported.map((row) => row.source_id)),
    sourceLanguages: new Map(supported.map((row) => [row.source_id, row.lang] as const)),
  };
}

export async function sourceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * مزامنة سجل المصادر مع ما يراه Uchiyomi.
   *
   * المصدر الجديد يُسجَّل REGISTERED_NOT_TESTED. لا يُرفع إلى SUPPORTED إلا
   * بدليل من `/v1/sources/:id/probe` — هذه هي قاعدة "لا Supported بلا evidence".
   */
  app.post('/v1/sources/sync', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const session = sessionOf(request);
    const user = await ctx.uchiyomi.me(session.token);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });

    const sources = await ctx.uchiyomi.listSources(session.token);
    let added = 0;

    for (const source of sources) {
      const row = await queryOne<{ inserted: boolean }>(
        `INSERT INTO vantara_source_verdicts (source_id, source_name, lang)
              VALUES ($1, $2, $3)
         ON CONFLICT (source_id)
         DO UPDATE SET source_name = EXCLUDED.source_name, lang = EXCLUDED.lang
         RETURNING (xmax = 0) AS inserted`,
        [source.id, source.name, source.lang],
      );
      if (row?.inserted) added++;
    }

    const status = await ctx.uchiyomi.extensionStatus(session.token).catch(() => null);
    return reply.send({ total: sources.length, added, engine: status });
  });

  /**
   * العقد العام للمصدر صغير وثابت عمدًا. verdict/evidence تفاصيل تشغيلية تبقى
   * في مسارات evidence/probes ولا نجبر كل عميل على فهمها.
   */
  app.get('/v1/sources', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const onlyUsable = (request.query as { usable?: string }).usable === 'true';

    const rows = await query<VerdictRow>(
      `SELECT source_id, source_name, lang, verdict, evidence, tested_at, last_success_at, notes
         FROM vantara_source_verdicts
        ORDER BY verdict, source_name`,
    );

    const content = rows
      .map((row) =>
        toPublicSource({
          id: row.source_id,
          name: row.source_name,
          lang: row.lang,
          verdict: row.verdict,
        }),
      )
      .filter((source) => !onlyUsable || source.capabilities.read);

    return reply.send({ content });
  });

  app.get('/v1/sources/:id/evidence', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await queryOne<VerdictRow>(
      `SELECT * FROM vantara_source_verdicts WHERE source_id = $1`,
      [id],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return reply.send({
      id: row.source_id,
      verdict: row.verdict,
      testedAt: row.tested_at,
      evidence: row.evidence,
    });
  });

  /**
   * تسجيل نتيجة فحص المعيار الخمسي.
   *
   * الفحص نفسه يجري في وظيفة خلفية (`source.probe`) لأنه يستغرق دقائق على
   * مصادر بطيئة؛ هذا المسار يتلقّى الدليل ويحسب الحكم منه.
   */
  app.put('/v1/sources/:id/evidence', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionOf(request);
    const user = await ctx.uchiyomi.me(session.token);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });

    const probe = z.object({
      popular: z.object({ ok: z.boolean(), count: z.number().optional(), error: z.string().optional() }),
      search: z.object({
        ok: z.boolean(),
        count: z.number().optional(),
        relevant: z.boolean().optional(),
        error: z.string().optional(),
      }),
      chapters: z.object({ ok: z.boolean(), count: z.number().optional(), error: z.string().optional() }),
      pagesOldest: z.object({ ok: z.boolean(), count: z.number().optional(), error: z.string().optional() }),
      pagesNewest: z.object({ ok: z.boolean(), count: z.number().optional(), error: z.string().optional() }),
      imagesDecoded: z.object({
        ok: z.boolean(),
        types: z.array(z.string()).optional(),
        error: z.string().optional(),
      }),
      // محاولات متعددة: الحكم من استعلام واحد ينقلب بحسب أي استعلام جُرّب
      searchAttempts: z
        .array(
          z.object({
            query: z.string().max(200),
            ok: z.boolean(),
            count: z.number().optional(),
            relevant: z.boolean().optional(),
            error: z.string().optional(),
          }),
        )
        .max(20)
        .optional(),
      // بدون هذين، عدد الفصول في الدليل بلا معنى
      probeQuery: z.string().max(200).optional(),
      probedWork: z.string().max(400).optional(),
      elapsedMs: z.number().int().min(0).optional(),
    });

    const parsed = probe.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.issues });
    }

    const evidence = parsed.data as ProbeEvidence;
    const verdict = verdictFrom(evidence);

    // السجل أولًا: الحكم الحالي لقطة، وهذا تاريخه
    await query(
      `INSERT INTO vantara_source_probes
         (source_id, verdict, probe_query, probed_work, evidence, elapsed_ms)
       VALUES ($1, $2::source_verdict, $3, $4, $5::jsonb, $6)`,
      [
        id,
        verdict,
        parsed.data.probeQuery ?? null,
        parsed.data.probedWork ?? null,
        JSON.stringify(evidence),
        parsed.data.elapsedMs ?? null,
      ],
    );

    const row = await queryOne<{ verdict: SourceVerdict; agreeing_probes: number }>(
      // $2 يُستخدم في سياقَي نوع مختلفين، فالتحويل الصريح ضروري وإلا فشل الاستدلال
      // agreeing_probes يعدّ الفحوص المتعاقبة التي وافقت الحكم، ويعود إلى 1
      // عند أي تغيّر: SUPPORTED بواحد لقطة لا خلاصة
      `UPDATE vantara_source_verdicts
          SET verdict = $2::source_verdict,
              evidence = $3::jsonb,
              probe_query = $4,
              probed_work = $5,
              agreeing_probes = CASE WHEN verdict = $2::source_verdict
                                     THEN agreeing_probes + 1 ELSE 1 END,
              tested_at = now(),
              last_success_at = CASE WHEN $2::source_verdict = 'SUPPORTED'
                                     THEN now() ELSE last_success_at END
        WHERE source_id = $1
        RETURNING verdict, agreeing_probes`,
      [
        id,
        verdict,
        JSON.stringify(evidence),
        parsed.data.probeQuery ?? null,
        parsed.data.probedWork ?? null,
      ],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });

    await query(
      `INSERT INTO vantara_audit_log (actor_id, action, target, detail)
       VALUES ($1, 'source.verdict', $2, $3)`,
      [session.userId, id, JSON.stringify({ verdict })],
    );

    return reply.send({ id, verdict, agreeingProbes: row.agreeing_probes });
  });

  /** تاريخ فحص مصدر: لماذا حكمه ما هو، وهل تغيّر. */
  app.get('/v1/sources/:id/probes', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const rows = await query(
      `SELECT verdict, probe_query AS "probeQuery", probed_work AS "probedWork",
              elapsed_ms AS "elapsedMs", probed_at AS "probedAt"
         FROM vantara_source_probes
        WHERE source_id = $1
        ORDER BY probed_at DESC
        LIMIT 50`,
      [id],
    );
    return reply.send({ content: rows });
  });

  /**
   * بحث VANTARA.
   *
   * ثلاثة فروق عن Uchiyomi الخام:
   *  1. المصادر غير الصالحة للبحث تُستبعد من النتائج (SEARCH_BROKEN تضخّ ضجيجًا).
   *  2. الأعمال المحذوفة للجميع تُحجب.
   *  3. الأعمال الممنوعة بالسياسة تُحجب.
   */
  app.get('/v1/search', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const parsed = z
      .object({ q: z.string().min(1).max(200) })
      .safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const q = parsed.data.q;
    const session = sessionOf(request);
    const grouped = await ctx.uchiyomi.searchAll(q, session.token);

    const [searchable, deleted, blocked] = await Promise.all([
      query<SourceRegistryRow>(
        `SELECT source_id, lang, verdict FROM vantara_source_verdicts`,
      ),
      query<{ series_ref: string }>(
        `SELECT series_ref FROM vantara_deleted_works WHERE restored_at IS NULL`,
      ),
      query<{ source_id: string | null; series_ref: string | null }>(
        `SELECT source_id, series_ref FROM vantara_content_policy
          WHERE rule IN ('BLOCK_SOURCE', 'BLOCK_SERIES')`,
      ),
    ]);

    const { filterSources, allowedSources, sourceLanguages } = sourceSearchPolicy(searchable);
    const blockedSources = new Set(
      blocked.map((r) => r.source_id).filter((v): v is string => v !== null),
    );
    const hiddenSeriesRefs = new Set([
      ...deleted.map((r) => r.series_ref),
      ...blocked.map((r) => r.series_ref).filter((v): v is string => v !== null),
    ]);

    // *_ref هو canonical Uchiyomi id، أما provider.sourceId فهو id داخل المصدر.
    // نحل canonical series إلى كل هويات مصادره قبل المقارنة، بدل مقارنة namespace
    // مختلفين لا يمكن أن يتساويا إلا صدفة.
    const policyToken = ctx.config.UCHIYOMI_SERVICE_TOKEN ?? session.token;
    const blockedSeriesSourceKeys = await sourceKeysForSeriesRefs(
      hiddenSeriesRefs,
      (seriesRef) => ctx.uchiyomi.series(seriesRef, policyToken),
    );

    // سجل verdicts الفارغ فقط هو bootstrap mode؛ سجل موجود بلا SUPPORTED يحجب الجميع.

    const content = grouped
      .map((group) => ({
        ...group,
        providers: rankProvidersByLanguage(
          group.providers.filter(
            (provider) =>
              !blockedSources.has(provider.source) &&
              (!filterSources || allowedSources.has(provider.source)),
          ),
          sourceLanguages,
        ),
      }))
      .filter(
        (group) =>
          group.providers.length > 0 &&
          !group.providers.some((provider) =>
            blockedSeriesSourceKeys.has(sourceIdentity(provider.source, provider.sourceId)),
          ),
      )
      .sort((a, b) => {
        const languageRank = (sourceId: string | undefined): number => {
          const language = sourceId ? sourceLanguages.get(sourceId) : null;
          return language ? (SEARCH_LANGUAGE_RANK[language] ?? 2) : 3;
        };
        return languageRank(a.providers[0]?.source) - languageRank(b.providers[0]?.source);
      });

    return reply.send({
      content,
      /** تشخيص: هل البحث ضيّق بسبب مصادر غير مختبرة؟ */
      meta: {
        query: q,
        groupsBeforeFilter: grouped.length,
        groupsAfterFilter: content.length,
        searchableSources: allowedSources.size,
        relevanceHint: looksRelevant(
          q,
          grouped.map((g) => g.title),
        ),
      },
    });
  });
}
