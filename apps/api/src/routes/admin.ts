import type { FastifyInstance } from 'fastify';
import { transaction } from '@vantara/db';
import { requireSession, sessionOf, type AppContext } from '../lib/context.ts';

/**
 * المسارات التشغيلية التي يملكها مخزن الخادم وحده.
 *
 * ما تبقّى هنا بعد تجميد الملكية (B4): لقطات الدمج وسجل التدقيق. الاجتماعي كله
 * — البروفايل والحضور والنشاط والتعليقات والتوصيات والإحصاء — انتقل إلى مالكه
 * الوحيد في D1، ولم تعد له نسخة ثانية على هذا المسار.
 */
export async function adminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /** استعادة snapshot الدمج. D-03: لا دمج بلا إمكانية عكسه. */
  app.post('/v1/merges/:id/split', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionOf(request);

    const user = await ctx.uchiyomi.me(session.token);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });

    const reverted = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string; before: unknown }>(
        `UPDATE vantara_merge_snapshots SET reverted_at = now()
          WHERE id = $1 AND reverted_at IS NULL
          RETURNING id, before`,
        [id],
      );
      const snapshot = rows[0];
      if (!snapshot) return undefined;

      await client.query(
        `INSERT INTO vantara_audit_log (actor_id, action, target, detail)
         VALUES ($1, 'merge.split', $2, $3)`,
        [session.userId, id, JSON.stringify(snapshot.before)],
      );
      return snapshot;
    });

    if (!reverted) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ id: reverted.id, restored: reverted.before });
  });
}
