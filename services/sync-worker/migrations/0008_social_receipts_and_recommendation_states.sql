-- B8 — Social Activity & Recommendations
--
-- 0007 محجوز لهجرة B2 على فرع الهوية. نستخدم 0008 هنا لتبقى سلسلة الدمج
-- غير ملتبسة حتى قبل اجتماع الفروع.
--
-- recommendations.state يبقى مؤقتًا للتوافق فقط. الحقيقة الجديدة لكل مستلم
-- تعيش في recommendation_recipients، ويُحذف الحقل القديم في B12 بعد انتقال
-- جميع المستهلكين.
--
-- delivery/seen ليست حالة عامة للحدث: لكل مشاهد صف مستقل.

ALTER TABLE activity ADD COLUMN target_user_id TEXT;
ALTER TABLE activity ADD COLUMN link TEXT;

CREATE TABLE IF NOT EXISTS recommendation_recipients (
  recommendation_id TEXT NOT NULL REFERENCES recommendations (id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  state              TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (state IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  intent             TEXT
                     CHECK (
                       intent IS NULL OR
                       intent IN ('WATCH_NOW', 'WATCH_LATER', 'ADD_TO_LIBRARY')
                     ),
  responded_at       INTEGER,
  rev                INTEGER NOT NULL,
  PRIMARY KEY (recommendation_id, user_id),
  CHECK (
    (state = 'PENDING' AND intent IS NULL AND responded_at IS NULL) OR
    (state = 'REJECTED' AND intent IS NULL AND responded_at IS NOT NULL) OR
    (state = 'ACCEPTED' AND responded_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS recommendation_recipients_user
  ON recommendation_recipients (user_id, state, recommendation_id);

CREATE TABLE IF NOT EXISTS activity_receipts (
  event_id      TEXT NOT NULL REFERENCES activity (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  delivered_at  INTEGER,
  seen_at       INTEGER,
  rev           INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id),
  CHECK (seen_at IS NULL OR delivered_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS activity_receipts_user
  ON activity_receipts (user_id, seen_at, delivered_at, event_id);

-- توصيات قديمة: لا نخترع قبولًا أو رفضًا من الحقل العام القديم.
-- targeted ⇒ مستلم واحد، broadcast ⇒ كل حساب عدا المرسل.
INSERT OR IGNORE INTO recommendation_recipients
  (recommendation_id, user_id, state, intent, responded_at, rev)
SELECT
  r.id,
  a.user_id,
  'PENDING',
  NULL,
  NULL,
  r.rev
FROM recommendations r
JOIN accounts a
  ON (
    (r.to_id IS NOT NULL AND a.user_id = r.to_id) OR
    (r.to_id IS NULL AND a.user_id <> r.from_id)
  );

-- أحداث قديمة تُعطى جمهورًا من كل الحسابات عدا الفاعل حتى تعمل receipts
-- عليها أيضًا. لا نضع delivered/seen لأننا لا نملك دليلًا تاريخيًا عليهما.
INSERT OR IGNORE INTO activity_receipts
  (event_id, user_id, delivered_at, seen_at, rev)
SELECT
  activity.id,
  accounts.user_id,
  NULL,
  NULL,
  activity.rev
FROM activity
CROSS JOIN accounts
WHERE accounts.user_id <> activity.actor_id;
