-- VANTARA schema, أول migration.
--
-- قاعدة حاكمة (D-02): Uchiyomi يملك المستخدمين والمكتبة والتقدم.
-- كل عمود هنا ينتهي بـ_ref هو معرّف Uchiyomi غير مملوك لنا، ولا مفتاح أجنبي عليه.
-- امسح هذا المخطط كاملًا ⇒ لا يفقد أي مستخدم فصلًا واحدًا من تقدمه.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────────────────────────── الهوية ─────────────────────────────

-- ظل خفيف لمستخدم Uchiyomi. لا كلمة مرور، لا دور، لا صلاحيات.
-- المصادقة كلها تمر بـUchiyomi؛ هذا الجدول يعلّق بياناتنا الاجتماعية على معرّفه.
CREATE TABLE vantara_users (
  uchiyomi_user_id  uuid PRIMARY KEY,
  username          text NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vantara_profiles (
  uchiyomi_user_id  uuid PRIMARY KEY REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  display_name      text,
  bio               text CHECK (bio IS NULL OR length(bio) <= 280),
  avatar_path       text,
  banner_path       text,
  accent            text CHECK (accent IS NULL OR accent ~ '^#[0-9a-fA-F]{6}$'),
  theme             text NOT NULL DEFAULT 'default',
  -- Favorite 4: أربعة أعمال كحد أقصى، بترتيب يختاره المستخدم
  favorite_refs     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(favorite_refs) <= 4),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- جلسة VANTARA.
--
-- المتصفح يحمل معرّفًا مبهمًا فقط. توكن Uchiyomi يبقى هنا مشفّرًا، ولا يخرج
-- إلى العميل أبدًا. هذا يجعل تسجيل دخول واحدًا يكفي بلا دورة refresh، ويعني
-- أن سرقة الكوكي لا تسلّم توكن Uchiyomi.
CREATE TABLE vantara_sessions (
  id                text PRIMARY KEY,
  uchiyomi_user_id  uuid NOT NULL REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  -- AES-256-GCM: nonce:tag:ciphertext بصيغة base64
  token_encrypted   text NOT NULL,
  /* معرّف التوكن عند Uchiyomi، لإبطاله هناك عند الخروج */
  token_id          text,
  device            text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz
);

CREATE INDEX ON vantara_sessions (uchiyomi_user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON vantara_sessions (expires_at) WHERE revoked_at IS NULL;

-- بوابة محتوى البالغين، تفعيل مستقل لكل حساب (لا يورَّث ولا يُدار مركزيًا)
CREATE TABLE vantara_user_gates (
  uchiyomi_user_id  uuid PRIMARY KEY REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  adult_enabled     boolean NOT NULL DEFAULT false,
  adult_confirmed_at timestamptz,
  -- الإخفاء المؤقت: لا يُبث ما يقرأه في Presence ولا في Activity
  incognito_until   timestamptz,
  CHECK (NOT adult_enabled OR adult_confirmed_at IS NOT NULL)
);

-- ──────────────────────────── الحضور ─────────────────────────────

CREATE TYPE presence_status AS ENUM ('READING', 'ONLINE', 'IDLE', 'OFFLINE');

CREATE TABLE vantara_presence (
  uchiyomi_user_id  uuid PRIMARY KEY REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  status            presence_status NOT NULL DEFAULT 'OFFLINE',
  series_ref        text,
  series_title      text,
  chapter_ref       text,
  chapter_label     text,
  progress          real CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
  device            text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- جلسة قراءة فعلية. active_ms هو الوقت المحتسب، لا الفارق بين البداية والنهاية:
-- التبويب المفتوح بلا تفاعل لا يُحسب (انظر heartbeat في الـAPI).
CREATE TABLE vantara_reading_sessions (
  id                bigserial PRIMARY KEY,
  uchiyomi_user_id  uuid NOT NULL REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  series_ref        text NOT NULL,
  chapter_ref       text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_beat_at      timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  active_ms         bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  interactions      integer NOT NULL DEFAULT 0 CHECK (interactions >= 0),
  pages_seen        integer NOT NULL DEFAULT 0 CHECK (pages_seen >= 0)
);

CREATE INDEX ON vantara_reading_sessions (uchiyomi_user_id, started_at DESC);
CREATE INDEX ON vantara_reading_sessions (series_ref);
-- جلسة واحدة مفتوحة لكل مستخدم/فصل: الـheartbeat يحدّثها بدل أن يفتح غيرها
CREATE UNIQUE INDEX vantara_reading_sessions_open
  ON vantara_reading_sessions (uchiyomi_user_id, series_ref, coalesce(chapter_ref, ''))
  WHERE ended_at IS NULL;

-- ──────────────────────────── الاجتماعي ──────────────────────────

CREATE TABLE vantara_activity_events (
  id                bigserial PRIMARY KEY,
  actor_id          uuid NOT NULL REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  verb              text NOT NULL,
  series_ref        text,
  chapter_ref       text,
  payload           jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON vantara_activity_events (created_at DESC);
CREATE INDEX ON vantara_activity_events (actor_id, created_at DESC);
CREATE INDEX ON vantara_activity_events (series_ref) WHERE series_ref IS NOT NULL;

CREATE TYPE comment_target AS ENUM ('series', 'chapter');

CREATE TABLE vantara_comments (
  id                bigserial PRIMARY KEY,
  author_id         uuid NOT NULL REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  target_type       comment_target NOT NULL,
  series_ref        text NOT NULL,
  chapter_ref       text,
  parent_id         bigint REFERENCES vantara_comments(id) ON DELETE CASCADE,
  body              text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  -- حجب المحتوى عن من لم يبلغ هذا الفصل بعد
  spoiler_after_ref text,
  edited_at         timestamptz,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (target_type <> 'chapter' OR chapter_ref IS NOT NULL)
);

CREATE INDEX ON vantara_comments (series_ref, created_at DESC);
CREATE INDEX ON vantara_comments (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE vantara_comment_reactions (
  comment_id        bigint NOT NULL REFERENCES vantara_comments(id) ON DELETE CASCADE,
  uchiyomi_user_id  uuid NOT NULL REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  emoji             text NOT NULL CHECK (length(emoji) <= 16),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, uchiyomi_user_id, emoji)
);

CREATE TYPE recommendation_state AS ENUM ('SENT', 'READ', 'SAVED', 'NOT_INTERESTED');

CREATE TABLE vantara_recommendations (
  id                bigserial PRIMARY KEY,
  from_id           uuid NOT NULL REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  -- NULL = للجميع
  to_id             uuid REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  series_ref        text NOT NULL,
  series_title      text,
  message           text CHECK (message IS NULL OR length(message) <= 500),
  state             recommendation_state NOT NULL DEFAULT 'SENT',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (to_id IS NULL OR to_id <> from_id)
);

CREATE INDEX ON vantara_recommendations (to_id, created_at DESC);
CREATE INDEX ON vantara_recommendations (from_id, created_at DESC);

-- ─────────────────────── الإدارة والموثوقية ─────────────────────

-- الحذف للجميع. snapshot يحمل ما يلزم لاستعادة بيانات VANTARA؛
-- تقدم Uchiyomi وتقييماته تبقى عنده ولا نلمسها.
CREATE TABLE vantara_deleted_works (
  series_ref        text PRIMARY KEY,
  series_title      text,
  deleted_by        uuid NOT NULL REFERENCES vantara_users(uchiyomi_user_id),
  reason            text,
  snapshot          jsonb NOT NULL DEFAULT '{}',
  deleted_at        timestamptz NOT NULL DEFAULT now(),
  restored_at       timestamptz
);

CREATE TYPE policy_rule AS ENUM ('BLOCK_SOURCE', 'BLOCK_SERIES', 'ADULT_ONLY');

CREATE TABLE vantara_content_policy (
  id                bigserial PRIMARY KEY,
  rule              policy_rule NOT NULL,
  source_id         text,
  series_ref        text,
  reason            text NOT NULL,
  created_by        uuid REFERENCES vantara_users(uchiyomi_user_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source_id IS NOT NULL OR series_ref IS NOT NULL)
);

CREATE UNIQUE INDEX ON vantara_content_policy (rule, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX ON vantara_content_policy (rule, series_ref) WHERE series_ref IS NOT NULL;

-- حكم المصدر. SEARCH_BROKEN مكتشفة في الـspike: المصدر حيّ وبحثه غير صالح.
CREATE TYPE source_verdict AS ENUM (
  'REGISTERED_NOT_TESTED',
  'SUPPORTED',
  'SEARCH_BROKEN',
  'NEEDS_FLARESOLVERR',
  'PARSER_FAILED',
  'TEMPORARILY_UNAVAILABLE',
  'POLICY_BLOCKED'
);

CREATE TABLE vantara_source_verdicts (
  source_id         text PRIMARY KEY,
  source_name       text NOT NULL,
  lang              text,
  verdict           source_verdict NOT NULL DEFAULT 'REGISTERED_NOT_TESTED',
  -- لا SUPPORTED بلا دليل: المعيار الخمسي مخزّن هنا
  evidence          jsonb NOT NULL DEFAULT '{}',
  tested_at         timestamptz,
  last_success_at   timestamptz,
  notes             text,
  CHECK (verdict <> 'SUPPORTED' OR evidence <> '{}')
);

CREATE TYPE report_kind AS ENUM (
  'CHAPTER_WONT_OPEN', 'MISSING_PAGE', 'WRONG_ORDER', 'WRONG_CHAPTER',
  'BAD_TRANSLATION', 'DUPLICATE_WORK', 'WRONG_CHAPTER_NUMBER',
  'LOW_QUALITY', 'OTHER'
);

CREATE TYPE report_state AS ENUM ('OPEN', 'AUTO_REPAIRING', 'ESCALATED', 'RESOLVED', 'WONT_FIX');

CREATE TABLE vantara_reports (
  id                bigserial PRIMARY KEY,
  reporter_id       uuid NOT NULL REFERENCES vantara_users(uchiyomi_user_id) ON DELETE CASCADE,
  kind              report_kind NOT NULL,
  state             report_state NOT NULL DEFAULT 'OPEN',
  series_ref        text,
  chapter_ref       text,
  page_index        integer CHECK (page_index IS NULL OR page_index >= 0),
  source_id         text,
  description       text CHECK (description IS NULL OR length(description) <= 2000),
  -- diagnostics تُجمع آليًا. ممنوع أن تحمل cookies أو tokens (مفروض في الـAPI)
  diagnostics       jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);

CREATE INDEX ON vantara_reports (state, created_at DESC);

CREATE TABLE vantara_report_attachments (
  id                bigserial PRIMARY KEY,
  report_id         bigint NOT NULL REFERENCES vantara_reports(id) ON DELETE CASCADE,
  path              text NOT NULL,
  mime              text NOT NULL,
  bytes             integer NOT NULL CHECK (bytes > 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vantara_report_actions (
  id                bigserial PRIMARY KEY,
  report_id         bigint NOT NULL REFERENCES vantara_reports(id) ON DELETE CASCADE,
  action            text NOT NULL,
  outcome           text NOT NULL,
  detail            jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON vantara_report_actions (report_id, created_at);

-- D-03: لا دمج بلا snapshot، ولا snapshot بلا إمكانية split
CREATE TABLE vantara_merge_snapshots (
  id                bigserial PRIMARY KEY,
  primary_ref       text NOT NULL,
  merged_ref        text NOT NULL,
  merged_by         uuid NOT NULL REFERENCES vantara_users(uchiyomi_user_id),
  -- حالة ما قبل الدمج لكل مستخدم، بما يكفي للعكس
  before            jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  reverted_at       timestamptz
);

CREATE INDEX ON vantara_merge_snapshots (primary_ref);

CREATE TABLE vantara_audit_log (
  id                bigserial PRIMARY KEY,
  actor_id          uuid REFERENCES vantara_users(uchiyomi_user_id),
  action            text NOT NULL,
  target            text,
  detail            jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON vantara_audit_log (created_at DESC);
