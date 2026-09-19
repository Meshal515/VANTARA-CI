/**
 * تحقّق ما بعد النشر، على D1 الحقيقية.
 *
 * الاختبارات الوحدوية في `@vantara/domain` تثبت القواعد. هذا يثبت أن الـWorker
 * يطبّقها فعلًا عبر SQL وشبكة وعميل — وهو المكان الذي تظهر فيه أخطاء الترتيب
 * والذرّية، لا في الدوال النقية.
 *
 *   node verify.mjs <worker-url>
 *
 * يكتب بمعرّفات موسومة `__verify__` ثم يحذفها عبر واجهة D1 عندما تتوفّر
 * CLOUDFLARE_API_TOKEN وD1_DATABASE_ID. بلا حذف لا يبقى أثر مؤذٍ: صفٌّ واحد
 * بمفتاح فصل لا يوجد في أي مصدر.
 */

const BASE = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!BASE) {
  console.error('usage: node verify.mjs <worker-url>');
  process.exit(2);
}

// دحمي. ثابت في هجرة 0002، فلا يُستنتج من ترتيب.
const USER_ID = '07588797-a471-44d1-99ce-7fb4f188c196';
const CHAPTER = '__verify__/ch-1';
const SERIES = '__verify__/series';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

async function call(path, options = {}, token = null) {
  const headers = { ...(options.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

function rowsOf(payload, table) {
  return payload?.changes?.[table] ?? [];
}

async function main() {
  // ─── الدخول بلا كلمة مرور ───
  const session = await call('/v1/session', { method: 'POST', body: { userId: USER_ID } });
  check('الدخول باختيار الحساب وحده', session.status === 200 && Boolean(session.json?.token));
  const token = session.json?.token;
  if (!token) {
    console.error(session.text);
    process.exit(1);
  }

  const unknown = await call('/v1/session', { method: 'POST', body: { userId: 'not-an-account' } });
  check('حساب غير معروف يُرفض', unknown.status === 404);

  const noToken = await call('/v1/sync');
  check('السحب بلا توكن يُرفض', noToken.status === 401);

  // ─── خط الأساس ───
  const baseline = await call('/v1/sync?since=0', {}, token);
  check('سحب كامل يعمل', baseline.status === 200 && baseline.json?.reset === false);
  const startCursor = Number(baseline.json?.cursor ?? 0);

  // ─── قراءة فصل، ثم إعادة تسليم نفس العملية ───
  const completeOp = {
    opId: '__verify__-complete-1',
    kind: 'chapter.complete',
    payload: { chapterKey: CHAPTER, seriesRef: SERIES, chapterNumber: 1, ratio: 1, activeMs: 9000 },
  };

  const first = await call('/v1/ops', { method: 'POST', body: { ops: [completeOp] } }, token);
  check('تُقبل العملية الأولى', first.status === 200);

  // نفس op_id مرتين: هذا ما يحدث فعلًا عند سقوط الشبكة بعد التطبيق وقبل الإجابة
  const replay = await call('/v1/ops', { method: 'POST', body: { ops: [completeOp] } }, token);
  check('إعادة التسليم تُقبل بلا خطأ', replay.status === 200);

  // ومرة ثالثة في نفس الدفعة، مكرّرة داخليًا
  const doubled = await call(
    '/v1/ops',
    { method: 'POST', body: { ops: [completeOp, completeOp] } },
    token,
  );
  check('التكرار داخل الدفعة يُقبل', doubled.status === 200);

  const afterReads = await call(`/v1/sync?since=${startCursor}`, {}, token);
  const readRow = rowsOf(afterReads.json, 'chapter_reads').find((row) => row.chapter_key === CHAPTER);
  check('الفصل وصل في الفروقات', Boolean(readRow));
  // القلب: أربع تسليمات لنفس العملية ⇒ قراءة واحدة
  check(
    'الفصل لم يُحتسب مرتين بعد إعادة التسليم',
    readRow?.read_count === 1,
    `read_count=${readRow?.read_count}`,
  );

  const stats = await call(`/v1/stats/${USER_ID}`, {}, token);
  check('الإحصائيات تُحتسب', stats.status === 200);
  check(
    'الفريد والإعادات متسقان',
    (stats.json?.uniqueChapters ?? 0) >= 1 && (stats.json?.rereads ?? -1) >= 0,
    `unique=${stats.json?.uniqueChapters} total=${stats.json?.totalReads} rereads=${stats.json?.rereads}`,
  );

  // ─── التقدم لا يرجع ───
  await call(
    '/v1/ops',
    {
      method: 'POST',
      body: {
        ops: [
          {
            opId: '__verify__-progress-high',
            kind: 'progress.set',
            payload: { chapterKey: CHAPTER, seriesRef: SERIES, page: 30, ratio: 0.95 },
          },
        ],
      },
    },
    token,
  );
  // جهاز قديم يزامن بعده حالة أقدم
  await call(
    '/v1/ops',
    {
      method: 'POST',
      body: {
        ops: [
          {
            opId: '__verify__-progress-stale',
            kind: 'progress.set',
            payload: { chapterKey: CHAPTER, seriesRef: SERIES, page: 12, ratio: 0.4 },
          },
        ],
      },
    },
    token,
  );

  const afterProgress = await call(`/v1/sync?since=${startCursor}`, {}, token);
  const progressRow = rowsOf(afterProgress.json, 'progress').find((row) => row.chapter_key === CHAPTER);
  check(
    'التقدم لم يرجع للخلف بعد مزامنة جهاز قديم',
    progressRow?.page === 30,
    `page=${progressRow?.page}`,
  );

  // ─── ملكية التقدم: المرآة صندوق صادر يُقرّ، لا حقيقة ثانية ───
  check(
    'صف المرآة يصل معلَّمًا بأن المالك لم يستلمه',
    progressRow?.owner_synced === 0,
    `owner_synced=${progressRow?.owner_synced}`,
  );

  const pendingBefore = await call('/v1/progress/pending', {}, token);
  const pendingRow = (pendingBefore.json?.content ?? []).find((row) => row.chapterKey === CHAPTER);
  check(
    'الصندوق الصادر يسمّي مالك التقدم',
    pendingBefore.json?.owner === 'UCHIYOMI',
    `owner=${pendingBefore.json?.owner}`,
  );
  check('الصف المعلّق يظهر في الصندوق', pendingRow?.page === 30, `page=${pendingRow?.page}`);

  // إقرار متأخر بصفحة أقل: لا يجوز أن يُسكت صفًّا تجاوزها
  await call(
    '/v1/ops',
    {
      method: 'POST',
      body: {
        ops: [
          {
            opId: '__verify__-confirm-stale',
            kind: 'progress.confirm',
            payload: { chapterKey: CHAPTER, page: 12 },
          },
        ],
      },
    },
    token,
  );
  const afterStaleConfirm = await call('/v1/progress/pending', {}, token);
  check(
    'إقرار بصفحة أقل لا يُخرج الصف من الصندوق',
    (afterStaleConfirm.json?.content ?? []).some((row) => row.chapterKey === CHAPTER),
  );

  await call(
    '/v1/ops',
    {
      method: 'POST',
      body: {
        ops: [
          {
            opId: '__verify__-confirm-30',
            kind: 'progress.confirm',
            payload: { chapterKey: CHAPTER, page: 30 },
          },
        ],
      },
    },
    token,
  );
  const afterConfirm = await call('/v1/progress/pending', {}, token);
  check(
    'إقرار المالك يُخرج الصف من الصندوق',
    !(afterConfirm.json?.content ?? []).some((row) => row.chapterKey === CHAPTER),
  );

  // تقدم جديد أعلى يعيد الصف معلّقًا: المالك لم يرَ القيمة الجديدة
  await call(
    '/v1/ops',
    {
      method: 'POST',
      body: {
        ops: [
          {
            opId: '__verify__-progress-41',
            kind: 'progress.set',
            payload: { chapterKey: CHAPTER, seriesRef: SERIES, page: 41, ratio: 0.95 },
          },
        ],
      },
    },
    token,
  );
  const afterAdvance = await call('/v1/progress/pending', {}, token);
  check(
    'تقدم أعلى بعد الإقرار يعود للصندوق',
    (afterAdvance.json?.content ?? []).some(
      (row) => row.chapterKey === CHAPTER && row.page === 41,
    ),
  );

  // ─── فتح لثانية ليس قراءة ───
  const tooShort = await call(
    '/v1/ops',
    {
      method: 'POST',
      body: {
        ops: [
          {
            opId: '__verify__-too-short',
            kind: 'chapter.complete',
            payload: {
              chapterKey: '__verify__/ch-2',
              seriesRef: SERIES,
              ratio: 1,
              activeMs: 400,
            },
          },
        ],
      },
    },
    token,
  );
  check('تُقبل بلا خطأ فلا يتوقف الطابور', tooShort.status === 200);
  const afterShort = await call(`/v1/sync?since=${startCursor}`, {}, token);
  check(
    'فتح الفصل لثانية لم يُحتسب قراءة',
    !rowsOf(afterShort.json, 'chapter_reads').some((row) => row.chapter_key === '__verify__/ch-2'),
  );

  // ─── الـcursor يتقدّم ولا يرجع ───
  const cursorNow = Number(afterShort.json?.cursor ?? 0);
  check('الـcursor تقدّم بعد الكتابة', cursorNow > startCursor, `${startCursor} → ${cursorNow}`);
  const empty = await call(`/v1/sync?since=${cursorNow}`, {}, token);
  check(
    'سحب بلا جديد لا يُرجع الـcursor',
    Number(empty.json?.cursor ?? 0) >= cursorNow,
    `cursor=${empty.json?.cursor}`,
  );

  // ─── cursor من المستقبل يطلب سحبًا كاملًا ───
  const future = await call(`/v1/sync?since=${cursorNow + 100_000}`, {}, token);
  check('cursor أعلى من الخادم يطلب سحبًا كاملًا', future.json?.reset === true);

  // ─── الحضور خارج سجل الفروقات ───
  const beat = await call(
    '/v1/presence',
    { method: 'POST', body: { status: 'READING', screen: 'READER', seriesTitle: 'verify' } },
    token,
  );
  check('النبضة تُقبل', beat.status === 200);
  const afterBeat = await call(`/v1/sync?since=${cursorNow}`, {}, token);
  // لو رفعت النبضة العدّاد لبقي كل عميل يسحب فروقات إلى الأبد
  check(
    'النبضة لم ترفع عدّاد المراجعات',
    Number(afterBeat.json?.serverRev ?? 0) === Number(empty.json?.serverRev ?? -1),
    `serverRev=${afterBeat.json?.serverRev}`,
  );
  const presence = await call('/v1/presence', {}, token);
  check('قائمة الحضور تُقرأ', presence.status === 200 && Array.isArray(presence.json?.content));
  const reading = (presence.json?.content ?? []).find((row) => row.userId === USER_ID);
  check('ما يُقرأ يُبثّ وهو ظاهر', reading?.seriesTitle === 'verify', `series=${reading?.seriesTitle}`);

  // ─── الإخفاء يُقرأ من مالك الحضور نفسه ───
  //
  // كان يعيش في مخزن آخر (`vantara_user_gates`) على مسار لا يستهلكه التطبيق،
  // فإخفاء مُفعَّل لم يكن يُطبَّق على المسار الذي يقرأه الأصدقاء فعلًا.
  await call(
    '/v1/ops',
    {
      method: 'POST',
      body: {
        ops: [
          {
            opId: `__verify__-incognito-on-${Date.now()}`,
            kind: 'settings.patch',
            payload: { fields: { incognitoUntil: Date.now() + 60_000 } },
          },
        ],
      },
    },
    token,
  );
  const hidden = await call('/v1/presence', {}, token);
  const redacted = (hidden.json?.content ?? []).find((row) => row.userId === USER_ID);
  check('الإخفاء يحجب العمل ويُبقي الوجود', redacted?.seriesTitle === null && redacted?.incognito === true);
  check('الإخفاء يمنع حالة «يقرأ»', redacted?.status !== 'READING', `status=${redacted?.status}`);
  const hiddenAccounts = await call('/v1/accounts');
  check(
    'شاشة اختيار الحساب تحترم نفس الإخفاء',
    (hiddenAccounts.json?.content ?? []).find((row) => row.userId === USER_ID)?.status !== 'READING',
  );

  await call(
    '/v1/ops',
    {
      method: 'POST',
      body: {
        ops: [
          {
            opId: `__verify__-incognito-off-${Date.now()}`,
            kind: 'settings.patch',
            payload: { fields: { incognitoUntil: 0 } },
          },
        ],
      },
    },
    token,
  );
  const restored = await call('/v1/presence', {}, token);
  check(
    'إلغاء الإخفاء يعيد البثّ',
    (restored.json?.content ?? []).find((row) => row.userId === USER_ID)?.incognito === false,
  );

  // ─── الهوية الداخلية لا تتغير ───
  await call(
    '/v1/ops',
    {
      method: 'POST',
      body: {
        ops: [
          {
            opId: `__verify__-identity-${Date.now()}`,
            kind: 'profile.patch',
            payload: { fields: { user_id: 'مُلفَّق', userId: 'مُلفَّق', displayName: 'دحمي' } },
          },
        ],
      },
    },
    token,
  );
  const accounts = await call('/v1/accounts');
  const dahmi = (accounts.json?.content ?? []).find((row) => row.userId === USER_ID);
  check('user_id لم يتغير بتعديل وارد', Boolean(dahmi), `userId=${dahmi?.userId}`);
  check('الاسم بقي قابلًا للتعديل', dahmi?.displayName === 'دحمي', `name=${dahmi?.displayName}`);

  await cleanup();

  console.log(`\n${failures.length === 0 ? 'كل الفحوص نجحت' : `فشل ${failures.length}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

/** يحذف صفوف الفحص عبر واجهة D1 مباشرة (الـWorker لا يملك مسار حذف). */
async function cleanup() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const database = process.env.D1_DATABASE_ID;
  if (!token || !account || !database) {
    console.log('— تنظيف متخطّى (بلا وصول إلى D1). صفوف __verify__ باقية.');
    return;
  }
  const sql = [
    "DELETE FROM chapter_reads WHERE chapter_key LIKE '__verify__%'",
    "DELETE FROM progress WHERE chapter_key LIKE '__verify__%'",
    "DELETE FROM applied_ops WHERE op_id LIKE '__verify__%'",
  ].join('; ');
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
    },
  );
  console.log(response.ok ? '— صفوف الفحص حُذفت' : `— تعذّر التنظيف (${response.status})`);
}

await main();
