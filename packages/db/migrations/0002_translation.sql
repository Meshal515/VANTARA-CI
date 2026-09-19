-- الترجمة العربية: الوظائف والذاكرة.
--
-- الرسم العربي عندنا (D-04). هذه الجداول تحمل ما يجعل الترجمة متسقة عبر الفصول:
-- المصطلحات، الشخصيات، والذاكرة. بلا Vector DB — structured memory يكفي.

CREATE TYPE translation_state AS ENUM (
  'QUEUED', 'DETECTING', 'OCR', 'CONTEXT', 'TRANSLATING',
  'INPAINTING', 'TYPESETTING', 'READY_PARTIAL', 'READY',
  'NEEDS_REVIEW', 'FAILED'
);

CREATE TABLE vantara_translation_jobs (
  id                bigserial PRIMARY KEY,
  series_ref        text NOT NULL,
  chapter_ref       text NOT NULL,
  source_lang       text NOT NULL,
  target_lang       text NOT NULL DEFAULT 'ar',
  state             translation_state NOT NULL DEFAULT 'QUEUED',
  engine            text,
  requested_by      uuid REFERENCES vantara_users(uchiyomi_user_id) ON DELETE SET NULL,
  pages_total       integer NOT NULL DEFAULT 0 CHECK (pages_total >= 0),
  pages_done        integer NOT NULL DEFAULT 0 CHECK (pages_done >= 0),
  -- أزمنة كل مرحلة بالمللي ثانية؛ هذا ما يغذّي بوابة قرار READY_PARTIAL
  timings           jsonb NOT NULL DEFAULT '{}',
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (pages_done <= pages_total)
);

CREATE UNIQUE INDEX ON vantara_translation_jobs (series_ref, chapter_ref, target_lang);
CREATE INDEX ON vantara_translation_jobs (state, created_at);

CREATE TABLE vantara_translation_pages (
  id                bigserial PRIMARY KEY,
  job_id            bigint NOT NULL REFERENCES vantara_translation_jobs(id) ON DELETE CASCADE,
  page_index        integer NOT NULL CHECK (page_index >= 0),
  state             translation_state NOT NULL DEFAULT 'QUEUED',
  output_path       text,
  width             integer CHECK (width IS NULL OR width > 0),
  height            integer CHECK (height IS NULL OR height > 0),
  -- المناطق المكتشفة: صندوق + نص أصلي + ترجمة + ثقة + الخط المستخدم
  regions           jsonb NOT NULL DEFAULT '[]',
  timings           jsonb NOT NULL DEFAULT '{}',
  error             text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, page_index)
);

CREATE INDEX ON vantara_translation_pages (job_id, page_index);

-- ذاكرة العمل: تُقرأ قبل كل صفحة وتُحدَّث بعدها
CREATE TABLE vantara_characters (
  id                bigserial PRIMARY KEY,
  series_ref        text NOT NULL,
  name              text NOT NULL,
  arabic_name       text,
  aliases           text[] NOT NULL DEFAULT '{}',
  gender            text CHECK (gender IS NULL OR gender IN ('male', 'female', 'unknown')),
  role              text,
  notes             text,
  -- لا نثبّت ضميرًا أو اسمًا عربيًا دون ثقة كافية؛ الـworker يقرأ هذا الرقم
  confidence        real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_ref, name)
);

CREATE INDEX ON vantara_characters (series_ref);

CREATE TABLE vantara_glossary (
  id                bigserial PRIMARY KEY,
  -- NULL = مصطلح عام يسري على كل الأعمال
  series_ref        text,
  term              text NOT NULL,
  arabic            text NOT NULL,
  kind              text,
  locked            boolean NOT NULL DEFAULT false,
  notes             text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ON vantara_glossary (coalesce(series_ref, ''), lower(term));
CREATE INDEX ON vantara_glossary (series_ref);

-- إعادة استخدام الترجمات المتطابقة: مجاني ويمنع التذبذب بين الفصول
CREATE TABLE vantara_translation_memory (
  id                bigserial PRIMARY KEY,
  series_ref        text NOT NULL,
  source_lang       text NOT NULL,
  source_text       text NOT NULL,
  arabic_text       text NOT NULL,
  hits              integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz
);

CREATE UNIQUE INDEX ON vantara_translation_memory (series_ref, source_lang, md5(source_text));
CREATE INDEX ON vantara_translation_memory USING gin (source_text gin_trgm_ops);

CREATE TABLE vantara_chapter_summaries (
  series_ref        text NOT NULL,
  chapter_ref       text NOT NULL,
  summary           text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_ref, chapter_ref)
);
