-- VANTARA sync — مخطط D1.
--
-- نطاقه الاجتماعي فقط: البروفايلات والحضور والنشاط والتعليقات والتقييمات
-- والتوصيات والإشعارات والتقدم والإحصائيات. الفصول المنزّلة وكاش الصور
-- وكوكيز المصادر تبقى على الهاتف ولا تصل هنا.
--
-- كل جدول قابل للمزامنة يحمل `rev` من عدّاد واحد في sync_state. العميل يسحب
-- `rev > cursor`، فلا يعتمد على ساعة جهاز ولا يفقد صفّين في نفس المللي ثانية.
-- الحضور وحده بلا rev: نبضة كل 25 ثانية × 3 مستخدمين ترفع العدّاد بلا توقف
-- وتُبقي كل عميل يسحب إلى الأبد.

-- ───────────────────────────── العدّاد ─────────────────────────────

CREATE TABLE IF NOT EXISTS sync_state (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_state (id, rev) VALUES (1, 0);

-- منع تكرار الكتابة. العميل يعيد المحاولة بنفس op_id بعد انقطاع الشبكة،
-- وبلا هذا الجدول تُحتسب القراءة مرتين ويُرسل الترشيح مرتين.
CREATE TABLE IF NOT EXISTS applied_ops (
  op_id      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS applied_ops_applied_at ON applied_ops (applied_at);

-- ───────────────────────────── الهوية ─────────────────────────────

-- user_id يُنشأ مرة واحدة ولا يتغير أبدًا. كل العلاقات تُعلَّق عليه، فتغيير
-- الاسم أو الصورة أو username لا يكسر تعليقًا ولا توصية ولا إحصاءً.
CREATE TABLE IF NOT EXISTS accounts (
  user_id    TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 0
);

-- field_revs: rev لكل حقل، لدمج على مستوى الحقل لا الصف. جهاز يغيّر الصورة
-- وآخر يغيّر النبذة بينما كان الأول خارج الشبكة — دمج الصف يفقد أحدهما.
CREATE TABLE IF NOT EXISTS profiles (
  user_id      TEXT PRIMARY KEY REFERENCES accounts (user_id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_key   TEXT,
  banner_key   TEXT,
  bio          TEXT,
  accent       TEXT,
  field_revs   TEXT NOT NULL DEFAULT '{}',
  rev          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS profiles_rev ON profiles (rev);

-- ───────────────────────────── الحضور ─────────────────────────────

-- بلا rev بقصد. beat_at يحدد الحالة المعروضة: الحاضر من كان آخر نبضة له
-- قريبة، والحالة تُشتق عند القراءة لا تُخزَّن — فلا حاجة لمهمة تنظيف.
CREATE TABLE IF NOT EXISTS presence (
  user_id        TEXT PRIMARY KEY REFERENCES accounts (user_id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'OFFLINE',
  screen         TEXT,
  series_ref     TEXT,
  series_title   TEXT,
  chapter_ref    TEXT,
  chapter_label  TEXT,
  chapter_number REAL,
  beat_at        INTEGER NOT NULL DEFAULT 0
);

-- ───────────────────────────── المكتبة والتقدم ─────────────────────────────

CREATE TABLE IF NOT EXISTS library (
  user_id      TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  series_ref   TEXT NOT NULL,
  series_title TEXT,
  cover_url    TEXT,
  source_id    TEXT,
  added_at     INTEGER NOT NULL,
  -- شاهد قبر لا حذف: الحذف الصامت لا يُزامَن، فيعود العمل عند أول مزامنة
  removed      INTEGER NOT NULL DEFAULT 0,
  rev          INTEGER NOT NULL,
  PRIMARY KEY (user_id, series_ref)
);

CREATE INDEX IF NOT EXISTS library_rev ON library (rev);

-- التقدم يُدمج بـmax لا بآخر كتابة: جهاز قديم يزامن صفحة 12 بعد أن قرأ الآخر
-- 30 يجب ألا يُرجع القارئ 18 صفحة.
CREATE TABLE IF NOT EXISTS progress (
  user_id     TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  chapter_key TEXT NOT NULL,
  series_ref  TEXT NOT NULL,
  page        INTEGER NOT NULL DEFAULT 0,
  ratio       REAL NOT NULL DEFAULT 0 CHECK (ratio >= 0 AND ratio <= 1),
  updated_at  INTEGER NOT NULL,
  rev         INTEGER NOT NULL,
  PRIMARY KEY (user_id, chapter_key)
);

CREATE INDEX IF NOT EXISTS progress_rev ON progress (rev);

-- الإحصاء على الفصول لا الصفحات. read_count يفصل الفريد عن الإعادة:
-- فريدة = COUNT(*)، إجمالي = SUM(read_count)، إعادات = الفرق.
CREATE TABLE IF NOT EXISTS chapter_reads (
  user_id        TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  chapter_key    TEXT NOT NULL,
  series_ref     TEXT NOT NULL,
  chapter_number REAL,
  read_count     INTEGER NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  first_read_at  INTEGER NOT NULL,
  last_read_at   INTEGER NOT NULL,
  rev            INTEGER NOT NULL,
  PRIMARY KEY (user_id, chapter_key)
);

CREATE INDEX IF NOT EXISTS chapter_reads_rev ON chapter_reads (rev);
CREATE INDEX IF NOT EXISTS chapter_reads_series ON chapter_reads (user_id, series_ref);

-- وقت الاستخدام الفعلي في المقدمة، تراكمي لكل يوم. الخلفية والشاشة المقفلة
-- والخمول لا تُحتسب: العميل لا يرسل نبضة أصلًا في تلك الحالات.
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id   TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  day       TEXT NOT NULL,
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  rev       INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS usage_daily_rev ON usage_daily (rev);

-- ───────────────────────────── المجموعات ─────────────────────────────

-- المفضلة وأقرأ لاحقًا في جدول واحد: نفس الدلالة تمامًا (عضوية + شاهد قبر)،
-- وجدولان يعنيان نسختين من منطق الدمج نفسه.
CREATE TABLE IF NOT EXISTS collections (
  user_id    TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('favorite', 'read_later')),
  series_ref TEXT NOT NULL,
  member     INTEGER NOT NULL DEFAULT 1,
  position   INTEGER,
  updated_at INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, series_ref)
);

CREATE INDEX IF NOT EXISTS collections_rev ON collections (rev);

CREATE TABLE IF NOT EXISTS ratings (
  user_id    TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  series_ref TEXT NOT NULL,
  score      REAL NOT NULL CHECK (score >= 0 AND score <= 10),
  updated_at INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  PRIMARY KEY (user_id, series_ref)
);

CREATE INDEX IF NOT EXISTS ratings_rev ON ratings (rev);

-- ───────────────────────────── الاجتماعي ─────────────────────────────

-- المعرّف هو op_id: الإدراج المكرر يصطدم بالمفتاح، فالإضافة معرّفة بطبيعتها
-- بلا حاجة لفحص إضافي.
CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  series_ref  TEXT NOT NULL,
  chapter_ref TEXT,
  parent_id   TEXT REFERENCES comments (id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  -- يُحجب عن من لم يبلغ هذا الفصل
  spoiler_after REAL,
  created_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  rev         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS comments_rev ON comments (rev);
CREATE INDEX IF NOT EXISTS comments_series ON comments (series_ref, created_at);

CREATE TABLE IF NOT EXISTS reactions (
  comment_id TEXT NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  rev        INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS reactions_rev ON reactions (rev);

CREATE TABLE IF NOT EXISTS recommendations (
  id           TEXT PRIMARY KEY,
  from_id      TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  -- NULL = للجميع
  to_id        TEXT REFERENCES accounts (user_id) ON DELETE CASCADE,
  series_ref   TEXT NOT NULL,
  series_title TEXT,
  cover_url    TEXT,
  message      TEXT,
  state        TEXT NOT NULL DEFAULT 'SENT',
  created_at   INTEGER NOT NULL,
  rev          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS recommendations_rev ON recommendations (rev);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  actor_id   TEXT REFERENCES accounts (user_id) ON DELETE SET NULL,
  series_ref TEXT,
  body       TEXT,
  -- يفتح المكان الصحيح داخل التطبيق مباشرة
  link       TEXT,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  rev        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS notifications_rev ON notifications (rev);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, created_at);

-- نشاط خفيف: بدء عمل، إنهاء فصل، تقييم، إضافة للمفضلة. لا صفحة ولا فتح شاشة.
CREATE TABLE IF NOT EXISTS activity (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  verb       TEXT NOT NULL,
  series_ref TEXT,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  rev        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_rev ON activity (rev);
CREATE INDEX IF NOT EXISTS activity_created ON activity (created_at);

CREATE TABLE IF NOT EXISTS settings (
  user_id    TEXT PRIMARY KEY REFERENCES accounts (user_id) ON DELETE CASCADE,
  data       TEXT NOT NULL DEFAULT '{}',
  field_revs TEXT NOT NULL DEFAULT '{}',
  rev        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settings_rev ON settings (rev);
