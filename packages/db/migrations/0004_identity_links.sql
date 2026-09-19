-- B2: VANTARA identity هي الهوية الأساسية. Uchiyomi يبقى مالك المحتوى
-- والمكتبة والتقدم، لذلك نربط كل VANTARA UUID بمستخدم Uchiyomi وتوكنه
-- المشفّر بدل استعمال Uchiyomi UUID كهوية المنتج.

CREATE TABLE vantara_identity_links (
  vantara_identity_id uuid PRIMARY KEY,
  uchiyomi_user_id    uuid NOT NULL UNIQUE REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  token_encrypted     text NOT NULL,
  token_id            text,
  linked_at           timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz
);

CREATE INDEX vantara_identity_links_active
  ON vantara_identity_links (uchiyomi_user_id)
  WHERE revoked_at IS NULL;
