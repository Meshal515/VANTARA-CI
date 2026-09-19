-- فهرس `rev` لجدولي B8.
--
-- كل نداء `/v1/sync` يشغّل على كل جدول فروقات:
--   SELECT … WHERE rev > ? ORDER BY rev LIMIT 500
--
-- وبلا فهرس على `rev` يجيب المحرّك `SCAN` كاملًا للجدول ثم
-- `USE TEMP B-TREE FOR ORDER BY` — أي مسحٌ وترتيبٌ مؤقت في كل مزامنة، لا
-- في مزامنة أولى. الجداول الأقدم كلها أخذت فهرسها، وهذان من B8 فسقطا.
--
-- و`activity_receipts` أسرع جدول نموًّا في التصميم: صفٌّ لكل حدث نشاط لكل
-- مستلم. فهو آخر جدول يُحتمل فيه مسحٌ كامل.
--
-- ولا فهرس لـ`accounts`: ثلاثة صفوف ثابتة بحكم §2 من وثيقة النظام
-- الاجتماعي، فالفهرس عليها كلفة كتابة بلا مقابل. إن صار للمجموعات الخاصة
-- حسابات كثيرة، فهذا سطرٌ واحد يُضاف يومها.

CREATE INDEX IF NOT EXISTS activity_receipts_rev ON activity_receipts (rev);
CREATE INDEX IF NOT EXISTS recommendation_recipients_rev ON recommendation_recipients (rev);
