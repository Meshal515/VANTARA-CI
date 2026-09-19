-- §9: «أفضل 5» تستخدم نفس جدول المجموعات. القيد الأصلي سبق إضافة النوع top،
-- لذلك نعيد بناء الجدول مع الحفاظ على كل الصفوف الموجودة ومفاتيحها.
CREATE TABLE collections_with_top (
  user_id    TEXT NOT NULL REFERENCES accounts (user_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('favorite', 'read_later', 'top')),
  series_ref TEXT NOT NULL,
  member     INTEGER NOT NULL DEFAULT 1,
  position   INTEGER,
  updated_at INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, series_ref)
);

INSERT INTO collections_with_top
  (user_id, kind, series_ref, member, position, updated_at, rev)
SELECT user_id, kind, series_ref, member, position, updated_at, rev
  FROM collections;

DROP TABLE collections;
ALTER TABLE collections_with_top RENAME TO collections;
CREATE INDEX collections_rev ON collections (rev);
