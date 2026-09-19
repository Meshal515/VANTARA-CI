/**
 * ما يُقرّه الخادم مقابل ما كتبه فعلًا.
 *
 * طابور B5 على العميل يعزل أي عملية لا تذكرها الاستجابة في `applied` ولا في
 * `skipped`: «استجابة ناجحة لا تذكر عملية تعني أن الخادم رفضها عند التحليل».
 * فنصف العقد عند العميل صحيح أصلًا. هذه الاختبارات تحرس النصف الآخر: الخادم
 * لا يجوز أن يقرّ عملية لم تُنتج جملة واحدة.
 *
 * وهذا ليس احتمالًا نظريًّا في VANTARA: ثلاثة أجهزة أندرويد تُحدَّث في أوقات
 * مختلفة، فAPK أحدث من الـWorker المنشور يرسل `kind` لا يعرفه الخادم. إن
 * أقرّه، فرّغ العميل طابوره والكتابة ضاعت للأبد — وهو ما يسمّيه تعليق
 * `handleOps` نفسه «أسوأ عيب ممكن في المزامنة».
 */
import { describe, expect, it } from 'vitest';
import worker from './index.ts';
import { mintToken } from './session.ts';
import type { D1PreparedStatement, Env } from './types.ts';

const SECRET = 'ops-ack-secret-that-is-at-least-32-chars';
const USER = 'bedcf897-a6f0-4730-b757-402b14891ca5';

interface Batched {
  sql: string;
  values: unknown[];
}

/**
 * D1 تكفي `handleOps`: عدّاد الـrev يستجيب، و`batch` تُسجَّل بلا تنفيذ.
 * ما يهمّنا هو ما دخل الدفعة وما خرج في الاستجابة.
 */
function stubEnv(): { env: Env; batches: Batched[][] } {
  const batches: Batched[][] = [];
  let rev = 7;

  const prepare = (sql: string): D1PreparedStatement => {
    const entry: Batched = { sql, values: [] };
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        entry.values = values;
        return statement;
      },
      async first<T>() {
        if (sql.includes('UPDATE sync_state')) return { rev: ++rev } as T;
        if (sql.includes('SELECT rev FROM sync_state')) return { rev } as T;
        return null as T;
      },
      all: async () => ({ results: [], success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
    };
    // نربط الجملة بكائنها حتى تُعرف عند التسجيل في الدفعة
    Object.defineProperty(statement, '__entry', { value: entry, enumerable: false });
    return statement;
  };

  const env = {
    DB: {
      prepare,
      async batch(statements: D1PreparedStatement[]) {
        // D1 الحقيقية ترمي على دفعة فارغة، فالمُزيَّفة المتسامحة تُخفي
        // العيب: الإصلاح الأول هنا مرّ في الاختبار وأرجع 500 من الـWorker
        // الحقيقي. تتصرّف كالأصل حتى يُلتقط هذا الصنف في كل تشغيل.
        if (statements.length === 0) {
          throw new Error('D1_ERROR: No SQL statements detected.');
        }
        batches.push(
          statements.map(
            (statement) => (statement as unknown as { __entry: Batched }).__entry,
          ),
        );
        return [];
      },
      exec: async () => ({ count: 0, duration: 0 }),
    },
    VANTARA_SESSION_SECRET: SECRET,
    VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only-32-chars',
    VANTARA_DEVICE_PEPPER: 'device-pepper-for-tests-only-32-chars-x',
  } as unknown as Env;

  return { env, batches };
}

async function postOps(
  env: Env,
  ops: { opId: string; kind: string; payload: Record<string, unknown> }[],
) {
  const token = await mintToken(USER, SECRET);
  const response = await worker.fetch(
    new Request('https://worker.test/v1/ops', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ops }),
    }),
    env,
    { waitUntil: () => {} },
  );
  return { status: response.status, body: (await response.json()) as Record<string, string[]> };
}

const GOOD = {
  opId: 'op-good',
  kind: 'library.add',
  payload: { seriesRef: 'src:test:one-piece', seriesTitle: 'ون بيس' },
};

describe('the server only acknowledges what it actually wrote', () => {
  it('does not acknowledge a kind it does not know', async () => {
    // APK أحدث من الـWorker: `shelf.pin` لم يُنشر بعد
    const { env } = stubEnv();
    const { status, body } = await postOps(env, [
      { opId: 'op-future', kind: 'shelf.pin', payload: { seriesRef: 'src:test:x' } },
    ]);

    expect(status).toBe(200);
    expect(body.applied).not.toContain('op-future');
    expect(body.skipped).not.toContain('op-future');
  });

  it('does not reserve op_id for a kind it could not apply', async () => {
    // الحجز بلا كتابة هو الضياع نفسه: إعادة المحاولة تُتجاهل بعدها
    const { env, batches } = stubEnv();
    await postOps(env, [{ opId: 'op-future', kind: 'shelf.pin', payload: {} }]);

    const reserved = batches
      .flat()
      .filter((entry) => entry.sql.includes('applied_ops'))
      .flatMap((entry) => entry.values);
    expect(reserved).not.toContain('op-future');
  });

  it('answers a batch of nothing but unknown kinds without failing', async () => {
    // بلا جملة واحدة لا توجد دفعة تُنفَّذ. الردّ 500 هنا يعني «أعد المحاولة»
    // عند العميل، على عمليات لن تُطبَّق أبدًا.
    const { env } = stubEnv();
    const { status, body } = await postOps(env, [
      { opId: 'op-future-a', kind: 'shelf.pin', payload: {} },
      { opId: 'op-future-b', kind: 'shelf.unpin', payload: {} },
    ]);

    expect(status).toBe(200);
    expect(body.applied).toEqual([]);
  });

  it('does not acknowledge a known kind whose payload is missing its key', async () => {
    // `library.add` بلا `seriesRef` تُنتج `null`: لا جملة، فلا إقرار
    const { env } = stubEnv();
    const { body } = await postOps(env, [
      { opId: 'op-malformed', kind: 'library.add', payload: { workId: 'wrong-key' } },
    ]);

    expect(body.applied).not.toContain('op-malformed');
  });

  it('still acknowledges the good ops in a mixed batch, and writes them', async () => {
    // عملية واحدة فاسدة لا تُسقط الدفعة: الباقي يثبت ويُقَرّ
    const { env, batches } = stubEnv();
    const { body } = await postOps(env, [
      GOOD,
      { opId: 'op-future', kind: 'shelf.pin', payload: {} },
    ]);

    expect(body.applied).toContain('op-good');
    expect(body.applied).not.toContain('op-future');
    const wrote = batches.flat().some((entry) => entry.sql.includes('INSERT INTO library'));
    expect(wrote).toBe(true);
  });

  it('acknowledges a field-merge kind, which writes outside the batch', async () => {
    // `profile.patch` و`settings.patch` تُطبَّقان قبل الدفعة عبر
    // `applyFieldMerge`، فغيابهما من الدفعة ليس دليل فشل. حراسة انحدار:
    // الإصلاح لا يجوز أن يرفضهما بالخطأ.
    const { env } = stubEnv();
    const { body } = await postOps(env, [
      { opId: 'op-merge', kind: 'profile.patch', payload: { displayName: 'مشعل' } },
    ]);

    expect(body.applied).toContain('op-merge');
  });
});
