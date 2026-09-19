-- سجل الفحص: الحكم الواحد لا يكفي.
--
-- ثلاثة أمور قِيست وأوجبت هذا الجدول:
--
--   1. الدليل بلا اسم العمل المفحوص لا يُقرأ. «332 فصلًا» و«6 فصول» لنفس
--      المصدر ليسا تناقضًا — هما عملان مختلفان وجدهما استعلامان مختلفان.
--   2. المصدر يستجيب لاستعلام ويرمي على آخر: Kawii Manga خدم
--      `nano machine` ورمى على `the`، ثلاث مرات متطابقة. فالبحث ليس
--      صالحًا/معطوبًا، بل صالحًا لبعض الاستعلامات.
--   3. صحة المصدر تاريخية لا لقطة. الحكم الحالي يبقى في
--      vantara_source_verdicts للقراءة السريعة، وهذا الجدول يحفظ كيف وصلنا إليه.

CREATE TABLE vantara_source_probes (
  id                bigserial PRIMARY KEY,
  source_id         text NOT NULL,
  verdict           source_verdict NOT NULL,
  -- الاستعلام الذي استُخدم والعمل الذي وُجد به: بدونهما الأعداد بلا معنى
  probe_query       text,
  probed_work       text,
  evidence          jsonb NOT NULL,
  elapsed_ms        integer CHECK (elapsed_ms IS NULL OR elapsed_ms >= 0),
  probed_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON vantara_source_probes (source_id, probed_at DESC);
CREATE INDEX ON vantara_source_probes (verdict, probed_at DESC);

-- الحكم الحالي يحمل الآن سياقه
ALTER TABLE vantara_source_verdicts
  ADD COLUMN probe_query text,
  ADD COLUMN probed_work text,
  -- عدد الفحوص المتعاقبة التي وافقت الحكم الحالي: 1 يعني لقطة واحدة
  ADD COLUMN agreeing_probes integer NOT NULL DEFAULT 0
    CHECK (agreeing_probes >= 0);

COMMENT ON COLUMN vantara_source_verdicts.agreeing_probes IS
  'كم فحصًا متعاقبًا وافق هذا الحكم. SUPPORTED بـ1 هو لقطة لا خلاصة.';

-- آخر حكم لكل مصدر مع عدد فحوصه، للوحة صحة المصادر
CREATE VIEW vantara_source_health AS
SELECT v.source_id,
       v.source_name,
       v.lang,
       v.verdict,
       v.agreeing_probes,
       v.probe_query,
       v.probed_work,
       v.tested_at,
       v.last_success_at,
       (SELECT count(*) FROM vantara_source_probes p WHERE p.source_id = v.source_id)
         AS total_probes,
       (SELECT count(DISTINCT p.verdict) FROM vantara_source_probes p
         WHERE p.source_id = v.source_id) AS distinct_verdicts
  FROM vantara_source_verdicts v;
