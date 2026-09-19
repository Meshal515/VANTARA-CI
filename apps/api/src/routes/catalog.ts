import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession, sessionOf, type AppContext } from '../lib/context.ts';

const AddSourceSeries = z.object({
  source: z.string().min(1).max(256),
  sourceId: z.string().min(1).max(4096),
});

/**
 * يضيف نتيجة مصدر إلى مكتبة Uchiyomi بلا تنزيل فصول.
 *
 * VANTARA يبقى BFF فقط: Uchiyomi هو الذي يملك العمل وتتبعه وتحديثاته،
 * ونحن نطلب منه الإضافة بالهوية الحالية للمستخدم.
 */
export async function catalogRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const base = ctx.config.UCHIYOMI_URL.replace(/\/+$/, '');

  app.post('/v1/library/source', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const parsed = AddSourceSeries.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const session = sessionOf(request);
    const response = await fetch(`${base}/api/sources/add`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: parsed.data.source,
        sourceId: parsed.data.sourceId,
        chapterFrom: 'none',
        autoUpdate: true,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const status = response.status === 400 || response.status === 404 ? response.status : 502;
      return reply.code(status).send({ error: 'add_source_failed', detail: payload });
    }

    return reply.code(201).send(payload);
  });
}
