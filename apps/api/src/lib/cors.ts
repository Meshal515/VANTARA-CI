import type { FastifyInstance } from 'fastify';
import type { Config } from './config.ts';

/**
 * CORS للأصل الذي يعمل منه الـAPK.
 *
 * الـContent API كان بلا CORS إطلاقًا: الواجهة كانت تُقدَّم من نفس الأصل،
 * فالمسألة لم تكن موجودة. لكن Capacitor يقدّم الصفحة من `https://localhost`
 * على أندرويد، وكل نداء إلى الـAPI يصبح cross-origin — أي أن **كل** ميزة محتوى
 * على الـAPK تفشل عند الـpreflight: المكتبة والبحث والفصول والصور. يظهر
 * للمستخدم كانقطاع شبكة لا كخطأ إعداد.
 *
 * ثلاث قواعد حاكمة:
 *
 * 1. **قائمة بيضاء لا `*`.** الطلبات تحمل اعتمادًا (كوكي الآن، وBearer بعد عقد
 *    الهوية)، والمتصفح يرفض `*` مع الاعتماد أصلًا. `*` هنا يعني أيضًا أن أي
 *    صفحة على الإنترنت تستطيع قراءة مكتبة المستخدم.
 *
 * 2. **الأصل يُعاد كما وصل.** صدى الأصل المسموح وحده، ومع `Vary: Origin` كي لا
 *    يخدم كاش وسيط جوابًا بترويسة أصل غيره.
 *
 * 3. **الـpreflight لا يلمس جلسة ولا قاعدة.** `OPTIONS` يُجاب قبل أي حارس:
 *    استهلاك استعلام لطلب استكشافي بلا اعتماد هدر، والأسوأ أنه يرجع 401
 *    فيبدو للمتصفح كرفض CORS.
 */

/** أصول العميل المعروفة. Capacitor يقدّم من `https://localhost` على أندرويد. */
const DEFAULT_ORIGINS = [
  'https://localhost',
  'capacitor://localhost',
  'http://localhost:4173',
  'http://localhost:5173',
];

const ALLOWED_HEADERS = 'authorization, content-type';
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

export function allowedOrigins(config: Config): string[] {
  const extra = (config.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ORIGINS, ...extra])];
}

export function registerCors(app: FastifyInstance, config: Config): void {
  const allowed = new Set(allowedOrigins(config));

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    // بلا أصل: طلب same-origin أو من أداة. لا شيء يُضاف، ولا شيء يُمنع.
    if (typeof origin !== 'string' || origin === '') return;

    void reply.header('vary', 'origin');
    if (!allowed.has(origin)) {
      // أصل غير مسموح: لا ترويسة سماح. المتصفح هو من يمنع، ولا نردّ 403 —
      // الرفض بحالة مختلفة يكشف لصفحة معادية أن الأصل موجود أصلًا.
      if (request.method === 'OPTIONS') return reply.code(204).send();
      return;
    }

    void reply.header('access-control-allow-origin', origin);
    void reply.header('access-control-allow-credentials', 'true');

    if (request.method === 'OPTIONS') {
      void reply.header('access-control-allow-headers', ALLOWED_HEADERS);
      void reply.header('access-control-allow-methods', ALLOWED_METHODS);
      void reply.header('access-control-max-age', '86400');
      return reply.code(204).send();
    }
  });
}
