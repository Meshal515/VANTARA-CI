-- B7 — وصف العمل مرة واحدة، لا أربع مرات.
--
-- الرقم 0006 بقصد: 0005 محجوز لهجرة B2 (`trusted_devices`) بعد إعادة ترقيمها،
-- كما هو مسجّل في OWNER OFFICE. الفراغ مقبول: `wrangler` يرتّب بالاسم.
--
-- المشكلة: عضوية المفضلة وأقرأ لاحقًا تحمل `series_ref` وحده. عملٌ يُضاف للمفضلة
-- من صفحته لا يُسجَّل في أي مكان بعنوانه، فشاشة المفضلة لا تملك إلا معرّفًا خامًا
-- تعرضه. وفي الوقت نفسه العنوان والغلاف مكرّران أصلًا في `library` و
-- `recommendations`، ومكرّران ثالثًا داخل `activity.payload` — ثلاث نسخ تتفرّق.
--
-- `works` هو الوصف الواحد: مرآة اجتماعية لهوية العمل، ومالك الحقيقة يبقى
-- Uchiyomi (انظر `library.membership` في مصفوفة الملكية). بلا `user_id` بقصد:
-- الأصدقاء الثلاثة يرون نفس الأعمال، وصفٌّ لكل مستخدم كان سيعني ثلاث نسخ من
-- نفس العنوان.

CREATE TABLE IF NOT EXISTS works (
  series_ref TEXT PRIMARY KEY,
  title      TEXT,
  cover_url  TEXT,
  source_id  TEXT,
  updated_at INTEGER NOT NULL,
  rev        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS works_rev ON works (rev);

-- ما نعرفه الآن يُنقل من المرآة الموجودة: المكتبة أولًا لأنها الأوثق، ثم
-- التوصيات لما ليس في المكتبة. `INSERT OR IGNORE` يجعل الترتيب هو الأولوية.
INSERT OR IGNORE INTO works (series_ref, title, cover_url, source_id, updated_at, rev)
  SELECT series_ref, series_title, cover_url, source_id, added_at, rev
    FROM library
   WHERE series_title IS NOT NULL;

INSERT OR IGNORE INTO works (series_ref, title, cover_url, source_id, updated_at, rev)
  SELECT series_ref, series_title, cover_url, NULL, created_at, rev
    FROM recommendations
   WHERE series_title IS NOT NULL;
