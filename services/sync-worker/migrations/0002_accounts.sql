-- الحسابات الثلاثة.
--
-- الـuser_id مكتوب هنا حرفيًا بقصد: يُنشأ مرة واحدة ولا يتغير أبدًا. توليده
-- عند أول تشغيل يعني معرّفات مختلفة في كل بيئة، فتنكسر كل علاقة عند أي
-- إعادة نشر. `INSERT OR IGNORE` يجعل تشغيل هذه الهجرة مرتين بلا أثر.
--
-- المستخدم لا يرى هذه المعرّفات ولا يكتبها ولا يعدّلها. الاسم والصورة
-- والبانر وusername كلها قابلة للتغيير من صفحة الحساب، والمعرّف لا.

INSERT OR IGNORE INTO accounts (user_id, username, created_at, rev) VALUES
  ('07588797-a471-44d1-99ce-7fb4f188c196', 'dahmi',   unixepoch() * 1000, 0),
  ('bedcf897-a6f0-4730-b757-402b14891ca5', 'ngm',     unixepoch() * 1000, 0),
  ('9e4b51d9-4ca0-4da2-9b1f-2205e67134ed', 'mansour', unixepoch() * 1000, 0);

INSERT OR IGNORE INTO profiles (user_id, display_name, field_revs, rev) VALUES
  ('07588797-a471-44d1-99ce-7fb4f188c196', 'دحمي',   '{}', 0),
  ('bedcf897-a6f0-4730-b757-402b14891ca5', 'N G M',  '{}', 0),
  ('9e4b51d9-4ca0-4da2-9b1f-2205e67134ed', 'منصور',  '{}', 0);

INSERT OR IGNORE INTO presence (user_id, status, beat_at) VALUES
  ('07588797-a471-44d1-99ce-7fb4f188c196', 'OFFLINE', 0),
  ('bedcf897-a6f0-4730-b757-402b14891ca5', 'OFFLINE', 0),
  ('9e4b51d9-4ca0-4da2-9b1f-2205e67134ed', 'OFFLINE', 0);

INSERT OR IGNORE INTO settings (user_id, data, field_revs, rev) VALUES
  ('07588797-a471-44d1-99ce-7fb4f188c196', '{}', '{}', 0),
  ('bedcf897-a6f0-4730-b757-402b14891ca5', '{}', '{}', 0),
  ('9e4b51d9-4ca0-4da2-9b1f-2205e67134ed', '{}', '{}', 0);
