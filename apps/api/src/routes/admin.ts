import type { FastifyInstance } from 'fastify';
import { requireSession, sessionOf, type AppContext } from '../lib/context.ts';

/**
 * المسارات التشغيلية التي يملكها مخزن الخادم وحده.
 *
 * ما تبقّى هنا بعد تجميد الملكية (B4): لقطات الدمج وسجل التدقيق. الاجتماعي كله
 * — البروفايل والحضور والنشاط والتعليقات والتوصيات والإحصاء — انتقل إلى مالكه
 * الوحيد في D1، ولم تعد له نسخة ثانية على هذا المسار.
 */
export async function adminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * D-03 لا يسمح بادعاء split قبل وجود استعادة ذرّية للـsnapshot عند المالكين.
   *
   * النسخة القديمة كانت تضع reverted_at وتكتب audit ثم تعيد before للعميل،
   * لكنها لم تستعد progress/ratings/collections/comments فعلًا. نجاح 200 هنا
   * أخطر من غياب الميزة لأنه يجعل المشغّل يعتقد أن البيانات عادت.
   */
  app.post('/v1/merges/:id/split', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const session = sessionOf(request);
    const user = await ctx.uchiyomi.me(session.token);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });

    return reply.code(409).send({
      error: 'merge_restore_unavailable',
      detail: 'No owner-aware atomic merge restoration is installed.',
    });
  });

}
