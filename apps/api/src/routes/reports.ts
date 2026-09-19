import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '@vantara/db';
import { containsSecret, isCorrelationId, ownerOf, scrubDiagnostics } from '@vantara/domain';
import { requireAdmin, requireSession, sessionOf, type AppContext } from '../lib/context.ts';

const KINDS = [
  'CHAPTER_WONT_OPEN',
  'MISSING_PAGE',
  'WRONG_ORDER',
  'WRONG_CHAPTER',
  'BAD_TRANSLATION',
  'DUPLICATE_WORK',
  'WRONG_CHAPTER_NUMBER',
  'LOW_QUALITY',
  'OTHER',
] as const;

const reportBody = z.object({
  kind: z.enum(KINDS),
  seriesRef: z.string().max(200).optional(),
  chapterRef: z.string().max(200).optional(),
  pageIndex: z.number().int().min(0).max(10_000).optional(),
  sourceId: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  /** حالة العميل: نسخة التطبيق، المتصفح، سلسلة الاحتياط، تصنيف الخطأ. */
  client: z.record(z.unknown()).optional(),
  /** معرّف النداء الذي فشل عند المستخدم، كما عاد إليه في ترويسة الخطأ. */
  correlationId: z.string().max(64).optional(),
});

export async function reportRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * إنشاء بلاغ.
   *
   * الـdiagnostics تُجمع آليًا ثم **تُنقّى** قبل الكتابة: لا كوكيز، لا توكنات،
   * لا ترويسات مصادقة — حتى لو أرسلها العميل. ثم يُتحقق من النتيجة قبل الحفظ،
   * فالتنقية الصامتة التي تفشل أسوأ من عدمها.
   */
  app.post(
    '/v1/reports',
    {
      preHandler: requireSession(ctx),
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const parsed = reportBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'bad_request', detail: parsed.error.issues });
      }

      const input = parsed.data;
      const session = sessionOf(request);

      const collected = {
        client: input.client ?? {},
        server: {
          at: new Date().toISOString(),
          userAgent: request.headers['user-agent'] ?? null,
          sourceVerdict: input.sourceId
            ? (
                await queryOne<{ verdict: string }>(
                  `SELECT verdict FROM vantara_source_verdicts WHERE source_id = $1`,
                  [input.sourceId],
                )
              )?.verdict ?? null
            : null,
        },
      };

      const diagnostics = scrubDiagnostics(collected);
      if (containsSecret(diagnostics)) {
        // لا نكتب شيئًا نشكّ أنه يحمل سرًّا
        request.log.error('diagnostics still contained a secret after scrubbing — refusing');
        return reply.code(500).send({ error: 'diagnostics_unsafe' });
      }

      const row = await queryOne<{ id: string }>(
        `INSERT INTO vantara_reports
           (reporter_id, kind, series_ref, chapter_ref, page_index, source_id,
            description, diagnostics, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          session.userId,
          input.kind,
          input.seriesRef ?? null,
          input.chapterRef ?? null,
          input.pageIndex ?? null,
          input.sourceId ?? null,
          input.description ?? null,
          JSON.stringify(diagnostics),
          // B10: معرّف النداء الفاشل إن أرسلته الواجهة، وإلا معرّف طلب
          // البلاغ نفسه. ولا يُولَّد معرّف جديد هنا: معرّفٌ لا يقابله سطر
          // في السجلّ خيطٌ لا يصل إلى شيء، وهو أسوأ من غيابه.
          isCorrelationId(input.correlationId) ? input.correlationId : request.correlationId,
        ],
      );

      return reply.code(201).send({ id: row?.id, state: 'OPEN' });
    },
  );

  app.get('/v1/reports', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const session = sessionOf(request);
    const user = await ctx.uchiyomi.me(session.token);

    // المستخدم يرى بلاغاته؛ المدير يرى الكل
    const rows = await query(
      `SELECT r.id, u.username AS reporter, r.kind, r.state,
              r.series_ref AS "seriesRef", r.chapter_ref AS "chapterRef",
              r.page_index AS "pageIndex", r.source_id AS "sourceId",
              r.description, r.created_at AS "createdAt", r.resolved_at AS "resolvedAt",
              (SELECT count(*) FROM vantara_report_actions a WHERE a.report_id = r.id) AS attempts
         FROM vantara_reports r
         JOIN vantara_users u ON u.uchiyomi_user_id = r.reporter_id
        WHERE $2 = true OR r.reporter_id = $1
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [session.userId, user.role === 'admin'],
    );
    return reply.send({ content: rows });
  });

  app.get('/v1/reports/:id', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionOf(request);
    const user = await ctx.uchiyomi.me(session.token);

    const report = await queryOne(
      `SELECT r.*, u.username AS reporter
         FROM vantara_reports r
         JOIN vantara_users u ON u.uchiyomi_user_id = r.reporter_id
        WHERE r.id = $1 AND ($2 = true OR r.reporter_id = $3)`,
      [id, user.role === 'admin', session.userId],
    );
    if (!report) return reply.code(404).send({ error: 'not_found' });

    const actions = await query(
      `SELECT action, outcome, detail, created_at AS "createdAt"
         FROM vantara_report_actions WHERE report_id = $1 ORDER BY created_at`,
      [id],
    );

    return reply.send({ report, actions });
  });

  /** تسجيل محاولة إصلاح. كل محاولة تُسجَّل حتى الفاشلة — هذا سجل التشخيص. */
  app.post('/v1/reports/:id/actions', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        action: z.string().min(1).max(100),
        outcome: z.enum(['success', 'failed', 'skipped']),
        detail: z.record(z.unknown()).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const session = sessionOf(request);
    const user = await ctx.uchiyomi.me(session.token);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });

    const exists = await queryOne<{ id: string }>(`SELECT id FROM vantara_reports WHERE id = $1`, [id]);
    if (!exists) return reply.code(404).send({ error: 'not_found' });

    await query(
      `INSERT INTO vantara_report_actions (report_id, action, outcome, detail)
       VALUES ($1, $2, $3, $4)`,
      [id, parsed.data.action, parsed.data.outcome, JSON.stringify(scrubDiagnostics(parsed.data.detail ?? {}))],
    );

    if (parsed.data.outcome === 'success') {
      await query(
        `UPDATE vantara_reports SET state = 'RESOLVED', resolved_at = now() WHERE id = $1`,
        [id],
      );
    }

    return reply.code(204).send();
  });

  // ─────────────────────── الحذف للجميع ───────────────────────

  /**
   * حذف عمل من VANTARA للجميع.
   *
   * حذف ناعم فقط: حالة + snapshot. بيانات Uchiyomi (التقدم والتقييمات) لا
   * تُلمس، وهذا ما يجعل الاستعادة مجانية.
   */
  app.post('/v1/deleted-works', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const parsed = z
      .object({
        seriesRef: z.string().min(1).max(200),
        seriesTitle: z.string().max(400).optional(),
        reason: z.string().max(500).optional(),
        /** تأكيد ثانٍ: كتابة اسم العمل حرفيًا. */
        confirmTitle: z.string().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const session = sessionOf(request);
    const user = await ctx.uchiyomi.me(session.token);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });

    const input = parsed.data;
    if (input.seriesTitle && input.confirmTitle !== input.seriesTitle) {
      return reply.code(400).send({ error: 'confirmation_mismatch' });
    }

    // snapshot لما يملكه هذا المخزن فقط.
    //
    // كان يعدّ التعليقات والتوصيات وجلسات القراءة من جداول PostgreSQL. بعد
    // تجميد الملكية (B4) صار مالك الاجتماعي هو D1، وتلك الجداول متقاعدة — فعدّها
    // من هنا كان سيكتب «0 تعليق متأثر» بينما عند المالك اثنا عشر. الأثر
    // الاجتماعي يُقرأ من مالكه، و`socialOwner` يقول للمشغّل أين يقرأه.
    const snapshot = {
      reports: (
        await queryOne<{ n: string }>(
          `SELECT count(*)::text AS n FROM vantara_reports WHERE series_ref = $1`,
          [input.seriesRef],
        )
      )?.n,
      socialOwner: ownerOf('social.comments'),
    };

    await query(
      `INSERT INTO vantara_deleted_works (series_ref, series_title, deleted_by, reason, snapshot)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (series_ref)
       DO UPDATE SET deleted_at = now(), restored_at = NULL,
                     deleted_by = EXCLUDED.deleted_by, reason = EXCLUDED.reason,
                     snapshot = EXCLUDED.snapshot`,
      [
        input.seriesRef,
        input.seriesTitle ?? null,
        session.userId,
        input.reason ?? null,
        JSON.stringify(snapshot),
      ],
    );

    await query(
      `INSERT INTO vantara_audit_log (actor_id, action, target, detail)
       VALUES ($1, 'work.soft_delete', $2, $3)`,
      [session.userId, input.seriesRef, JSON.stringify(snapshot)],
    );

    return reply.code(201).send({ seriesRef: input.seriesRef, snapshot });
  });

  app.get(
    '/v1/deleted-works',
    { preHandler: [requireSession(ctx), requireAdmin(ctx)] },
    async (_request, reply) => {
    const rows = await query(
      `SELECT d.series_ref AS "seriesRef", d.series_title AS "seriesTitle",
              u.username AS "deletedBy", d.reason, d.snapshot,
              d.deleted_at AS "deletedAt"
         FROM vantara_deleted_works d
         JOIN vantara_users u ON u.uchiyomi_user_id = d.deleted_by
        WHERE d.restored_at IS NULL
        ORDER BY d.deleted_at DESC`,
    );
      return reply.send({ content: rows });
    },
  );

  app.post('/v1/deleted-works/:seriesRef/restore', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { seriesRef } = request.params as { seriesRef: string };
    const session = sessionOf(request);
    const user = await ctx.uchiyomi.me(session.token);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });

    const row = await queryOne<{ series_ref: string }>(
      `UPDATE vantara_deleted_works SET restored_at = now()
        WHERE series_ref = $1 AND restored_at IS NULL
        RETURNING series_ref`,
      [seriesRef],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });

    await query(
      `INSERT INTO vantara_audit_log (actor_id, action, target)
       VALUES ($1, 'work.restore', $2)`,
      [session.userId, seriesRef],
    );

    return reply.send({ seriesRef, restored: true });
  });
}
