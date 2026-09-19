-- B2: الجهاز الموثوق بدل اعتبار userId وحده إثبات هوية.
--
-- كل تثبيت يحمل credential عشوائيًا لا يُخزن في D1. نخزن HMAC فقط، ومفتاح
-- الـHMAC يبقى Worker secret. الصف مربوط بالحساب حتى يمكن logout-all لحساب
-- واحد من دون كسر الحسابين الآخرين على نفس الجهاز.

CREATE TABLE IF NOT EXISTS trusted_devices (
  device_id        TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  credential_hash  TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  last_used_at     INTEGER NOT NULL,
  revoked_at       INTEGER,
  PRIMARY KEY (device_id, user_id)
);

CREATE INDEX IF NOT EXISTS trusted_devices_user_active
  ON trusted_devices(user_id, revoked_at);

-- Owner ينشئ token عشوائيًا قصير العمر ويضع HMAC له هنا عبر Wrangler/D1.
-- user_id = NULL يعني أن نفس عملية الـpair تثق الجهاز للحسابات الثلاثة؛ هذا
-- لا يضيف أي اختيار أو PIN إلى شاشة الحسابات اليومية.
CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES accounts(user_id) ON DELETE CASCADE,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pairing_tokens_active
  ON pairing_tokens(expires_at, consumed_at);
