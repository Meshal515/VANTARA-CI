import PgBoss from 'pg-boss';
import { query } from '@vantara/db';
import type { AppContext } from '../lib/context.ts';

/**
 * الوظائف الخلفية عبر pg-boss — داخل نفس PostgreSQL، بلا Redis.
 *
 * قائمة الوظائف مقصودة القِلّة: كل واحدة تفعل شيئًا واحدًا وتسجّل أثرها.
 */
export const QUEUES = {
  sessionPurge: 'session.purge',
  sourceProbe: 'source.probe',
  sourceSync: 'source.sync',
  translationChapter: 'translation.chapter',
  translationPage: 'translation.page',
  reportDiagnose: 'report.diagnose',
  backupRun: 'backup.run',
} as const;

/**
 * أسماء طوابير متقاعدة.
 *
 * تبقى معروفة بالاسم لأن جدولتها محفوظة في القاعدة: بلا إلغائها صريحًا تبقى
 * تنتج مهامًا بلا مستهلك. ليست في `QUEUES` كي لا يُنشأ لها worker من جديد.
 */
const RETIRED_QUEUES = {
  /** B4: الحضور انتقل إلى D1، وحالته تُشتق عند القراءة. */
  presenceSweep: 'presence.sweep',
} as const;

export interface JobRunner {
  boss: PgBoss;
  stop(): Promise<void>;
}

export async function startJobs(ctx: AppContext): Promise<JobRunner> {
  const boss = new PgBoss({
    connectionString: ctx.config.DATABASE_URL,
    schema: 'pgboss',
    // الوظائف قليلة ومتباعدة؛ لا داعي لاستطلاع كل ثانية
    pollingIntervalSeconds: 5,
  });

  boss.on('error', (error) => {
    // pg-boss يرمي على أخطاء الاتصال؛ تجاهلها صامتًا يخفي عطلًا حقيقيًا
    console.error('[pg-boss]', error);
  });

  await boss.start();

  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name);
  }

  /** الجلسات المنتهية تبقى صفوفًا ميتة حتى تُحذف. */
  await boss.work(QUEUES.sessionPurge, async () => {
    const purged = await ctx.sessions.purgeExpired();
    if (purged > 0) console.log(`[jobs] purged ${String(purged)} expired sessions`);
  });

  /**
   * مكنسة الحضور حُذفت في B4: الحضور يملكه D1، وحالته تُشتق من `beat_at` عند
   * القراءة، فلا يوجد صفّ «عالق» يحتاج إغلاقًا.
   *
   * الجدول الزمني في pg-boss مخزّن في القاعدة لا في الكود: حذف الـworker وحده
   * كان سيُبقي الجدولة تنتج مهامًا لا مستهلك لها، فتتراكم صفوفًا إلى الأبد.
   */
  await boss.unschedule(RETIRED_QUEUES.presenceSweep).catch(() => {});
  await boss.deleteQueue(RETIRED_QUEUES.presenceSweep).catch(() => {});

  /** مزامنة سجل المصادر مع Uchiyomi. الأحكام لا تُلمس — فقط التسجيل. */
  await boss.work(QUEUES.sourceSync, async () => {
    const sources = await ctx.uchiyomi.listSources();
    for (const source of sources) {
      await query(
        `INSERT INTO vantara_source_verdicts (source_id, source_name, lang)
              VALUES ($1, $2, $3)
         ON CONFLICT (source_id)
         DO UPDATE SET source_name = EXCLUDED.source_name, lang = EXCLUDED.lang`,
        [source.id, source.name, source.lang],
      );
    }
    console.log(`[jobs] synced ${String(sources.length)} sources`);
  });

  // كل ليلة: تنظيف الجلسات ومزامنة المصادر.
  await boss.schedule(QUEUES.sessionPurge, '17 3 * * *');
  await boss.schedule(QUEUES.sourceSync, '43 4 * * *');

  return {
    boss,
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 20_000 });
    },
  };
}
