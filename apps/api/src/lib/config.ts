import { z } from 'zod';

/**
 * الإعداد يُتحقق منه عند الإقلاع ويفشل بصوت عالٍ.
 * خدمة تقلع بإعداد ناقص ثم تسقط تحت الحمل أسوأ من خدمة لا تقلع.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),

  UCHIYOMI_URL: z.string().url(),
  /** توكن خدمة `uy_…` بنطاق read+write. النداءات باسم مستخدم تستخدم توكنه. */
  UCHIYOMI_SERVICE_TOKEN: z.string().optional(),

  /** يوقّع كوكي الجلسة القديمة ويشفّر توكن Uchiyomi المخزّن. 32 بايتًا على الأقل. */
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(60),

  /** نفس القيمة المضبوطة كـWorker secret؛ توقّع access token v2 وتتحقق منه. */
  VANTARA_IDENTITY_SECRET: z.string().min(32),

  /** VANTARA يقف خلف Cloudflare Access؛ الكوكي Secure إلا في التطوير. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * أصول مسموح لها بالطلب، مفصولة بفاصلة.
   *
   * تُضاف إلى الأصول المعروفة (`https://localhost` للـAPK وما شابه). هنا يوضع
   * نطاق Pages الإنتاجي. القائمة بيضاء بقصد: `*` مع اعتماد يرفضه المتصفح،
   * ويعني أن أي صفحة تستطيع قراءة مكتبة المستخدم.
   */
  ALLOWED_ORIGINS: z.string().optional(),

  UPLOAD_DIR: z.string().default('/data/uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${detail}`);
  }
  return parsed.data;
}
