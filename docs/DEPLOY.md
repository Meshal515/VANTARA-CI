# نشر مكدّس المحتوى المستضاف ذاتيًّا

> **نطاق هذا الملف:** خادم المحتوى وحده — Uchiyomi وSuwayomi وFlareSolverr
> وPostgres على جهاز البيت. وهو **قطعة واحدة** من VANTARA لا كلّه.
>
> القطع الأخرى تُنشر آليًّا ولا يخصّها شيء مما هنا: الواجهة على Cloudflare
> Pages، والمزامنة على Cloudflare Worker + D1، وAPK من سير GitHub Actions.
> انظر [`README.md`](../README.md) § النشر.
>
> وقراءة المصادر **لا تحتاج هذا المكدّس إطلاقًا**: محرّك الإضافات داخل الـAPK
> يجلبها من الجهاز مباشرة.

> كل أمر هنا جرى تنفيذه فعليًا في هذه الجلسة، إلا الخطوة 5 (النفق) — وسبب
> استثنائها مكتوب فيها.

---

## 0. ما يلزم

| | |
|---|---|
| Docker + Compose v2 | `docker compose version` |
| قرص حرّ | **‏10 GiB على الأقل.** Uchiyomi يرفض تنزيل أي فصل تحت هذه الأرضية، ورسالته صريحة: `Not enough free space … floor is 10 GiB` |
| ذاكرة | ‏4 GB للمكدّس الأساسي: Suwayomi (JVM) ~800MB، FlareSolverr حتى 2GB، الباقي للتطبيق والقاعدة |
| حساب Cloudflare | للخطوة 5 فقط |

---

## 1. المكدّس

```bash
git clone <repo> vantara && cd vantara
cp .env.example .env
```

اضبط في `.env`:

```bash
POSTGRES_PASSWORD=$(openssl rand -base64 24)
SESSION_SECRET=$(openssl rand -base64 48)     # 32 بايتًا على الأقل، وإلا رفض الإقلاع
PUBLIC_ORIGIN=https://vantara.example.com
LIBRARY_PATH=/mnt/media/comics                # مكتبتك المحلية إن وُجدت
SUWAYOMI_MAX_SOURCES=60                        # الافتراضي 25، والإضافات العربية 38
```

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
```

انتظر `suwayomi` حتى `healthy` — الـJVM يأخذ حتى 120 ثانية، ولهذا
`start_period: 120s` في الـhealthcheck.

---

## 2. الحسابات

**من المتصفح، لا بـ`INSERT` في القاعدة.** افتح Uchiyomi وأنشئ حساب المدير، ثم
البقية من Admin → Users.

بالـAPI:

```bash
curl -s localhost:8080/api/setup/status          # {"needsSetup":true}
curl -s -X POST localhost:8080/api/setup -H 'Content-Type: application/json' \
  -d '{"username":"mishal","password":"<قوية>"}'
```

> ⚠️ `POST /api/setup` **يتجاهل `displayName`**. اضبط الاسم العربي بعدها من
> `PATCH /api/admin/users/{id}` أو من شاشة Admin.

توكن الخدمة الذي يحتاجه VANTARA:

```bash
S=$(curl -s -X POST localhost:8080/auth/login -H 'Content-Type: application/json' \
      -d '{"username":"mishal","password":"<قوية>"}' | jq -r .accessToken)

curl -s -X POST localhost:8080/api/tokens -H "Authorization: Bearer $S" \
  -H 'Content-Type: application/json' \
  -d '{"name":"vantara","scopes":["read","write","admin"],"expiresInDays":90}'
```

السرّ يُعاد **مرة واحدة**. ضعه في `UCHIYOMI_SERVICE_TOKEN`.

> `scopes` بلا `admin` تُرجع `403 This token does not have the admin scope` على
> مسارات الإدارة — وهذا ما حدث أول مرة هنا.

---

## 3. المصادر

> ⚠️ **ثلاث صيغ للمتجر، وواحدة فقط تناسب نسختك.** فُحصت الثلاث فعلًا من
> المصدر (2026‑09‑18):
>
> | الملف | الحجم | ما فيه | الحكم |
> |---|---|---|---|
> | `index.min.json` | **765 بايت** | مدخلان وهميان: «Outdated App» و«Update to Mihon 0.20.1+» | ☠️ **شاهد قبر.** يُقرأ بنجاح ويعطي **صفر مصدر عربي** بلا رسالة خطأ |
> | `index.json` | **1.4 MB** | 1396 إضافة بالصيغة **المتشعّبة** الجديدة (`extensionList.extensions`) | ⚠️ محلّل Suwayomi القديم يتوقع مصفوفة مسطّحة، فقد لا يفهمها |
> | `index.pb` | 108 KB | Protobuf، وهو ما يستعمله Mihon اليوم | ✅ الصيغة الحالية — **وتحتاج Suwayomi حديثًا** |
>
> **فالخلاصة: لا صيغة تُنقذ نسخة قديمة.** الترقية ليست تحسينًا اختياريًّا،
> هي شرط رؤية أي مصدر. وترقيةُ Suwayomi مطلوبة لسببٍ ثانٍ أيضًا: تثبيت
> الـJAR مباشرة (`Suwayomi-Server#2182`، مدموج 13 يوليو 2026) يُسقط مسار
> `dex2jar` الهشّ — وهو سبب أعطال موثّقة (`#2178` انهيار على minSdk 26،
> `#602` أصول مفقودة).

```bash
A="Authorization: Bearer <uy_token>"

# `index.pb` هي الصيغة الحالية. إن رجع صفرًا، فالنسخة قديمة — رقِّها،
# ولا تجرّب `index.min.json` فهو شاهد قبر لا كتالوج.
curl -X POST -H "$A" -H 'Content-Type: application/json' \
  localhost:8080/api/admin/extensions/repos \
  -d '{"url":"https://github.com/keiyoushi/extensions/raw/repo/index.pb"}'

curl -X POST -H "$A" localhost:8080/api/admin/extensions/refresh
curl -H "$A" "localhost:8080/api/admin/extensions/catalog?lang=ar" | jq -r '.content[].pkgName'
```

**افحص العدد، لا تفترضه.** الفهرس يحمل **75 إضافة فيها مصدر عربي**
(43 `SAFE` · 10 `MIXED` · 22 `NSFW`) — عددٌ مقروء من `index.json` نفسه، لا
تقديرًا. فالسطر الأخير يجب أن يطبع عشرات الحزم.

| ما يظهر | ما يعنيه |
|---|---|
| عشرات الحزم | المتجر مقروء — أكمل |
| **صفر** | النسخة لا تفهم `index.pb`. **ليس عيبًا في VANTARA**: رقِّ الـupstream (والـdigests مثبّتة عندنا، فالترقية قرار واعٍ يُحدَّث في `docs/UPSTREAMS.md`). ولا تنزل إلى `index.min.json` ظنًّا أنه أبسط: هو من يعطي «عنصرين» |
| **عنصران** | أنت على `index.min.json`. عُد إلى `index.pb` |

### المصادر الخمسة الأولى، بأرقامها

مُتحقَّق منها من الفهرس ومن الشبكة في 2026‑09‑18. كلها `SAFE`، وكلها تنشر
`jarUrl` و`apkUrl`:

| المصدر | الحزمة | lib | الدومين | فحص الشبكة |
|---|---|---|---|---|
| Mangalek | `eu.kanade.tachiyomi.extension.ar.mangalek` | 1.4 | `mangalik.net` | 200 · 173 KB |
| MangaSpark | `…ar.mangaspark` | 1.4 | `sparkmanga.net` | 200 · 122 KB |
| Azora | `…ar.azora` | 1.6 | `azorafly.com` | 200 · 984 KB |
| MangaSwat | `…ar.mangaswat` | 1.6 | `meshmanga.com` | 200 · 70 KB |
| Team X | `…ar.teamx` | 1.6 | `olympustaff.com` | 200 · 307 KB |

وفحص الشبكة كان بـ`curl` وحده بترويسة أندرويد، **بلا كوكي وبلا WebView**.
و`teamx` و`mangaspark` تحملان سكربت `challenge-platform` من Cloudflare،
لكنهما أعطيا الصفحة العربية كاملة (146 و131 رابط عمل) — فهو ليس تحدّيًا
يحجب في ذلك الوقت.

> ⚠️ **وما لا يقوله هذا الجدول.** `200` يثبت أن الموقع كان حيًّا في ذلك
> التاريخ، ولا يثبت أن **عقد صفحته** لم يتغيّر. فالموقع قد يخدم صفحة سليمة
> بترميز HTML جديد يكسر selectors الإضافة: لا المحرك مذنب ولا الموقع ساقط،
> والمتغيّر هو الصفحة. ولا يصحّ أن يُقرأ سطرٌ من هذا الجدول كبراءةٍ للمحرك
> عند أي سقوط لاحق — الدليل يُجمع لحظةَ السقوط، لا من جدولٍ أمس.

وهذا الفحص ليس تزيينًا: صيغة المتجر تغيّرت في 2026، وكتالوج صامت يبدو تمامًا
كمكتبة فارغة.

ثبّت ما تريد، ثم **افحص قبل أن تثق**:

```bash
docker cp spike/probes/05-probe-all-arabic.js uchiyomi:/tmp/
docker exec uchiyomi sh -c 'PROBE_SOURCES="$(cat /tmp/sources.json)" node /tmp/05-probe-all-arabic.js' \
  > verdicts.json
```

ثم حمّل الأحكام في السجل:

```bash
curl -b cookies -X POST localhost:3100/v1/sources/sync
curl -b cookies -X PUT  localhost:3100/v1/sources/<id>/evidence -d @evidence.json
```

**نتيجة هذه الجلسة على 37 مصدرًا عربيًا:** 13 `SUPPORTED`، 10
`NEEDS_FLARESOLVERR`، 7 `SEARCH_BROKEN`، 7 `PARSER_FAILED`. توقّع أرقامًا
مختلفة قليلًا: المواقع تتغير.

---

## 4. المكتبة

الإضافة بلا تنزيل — تُتابع العمل وتكتب قائمة فصوله فقط:

```bash
curl -X POST -H "$A" -H 'Content-Type: application/json' localhost:8080/api/sources/add \
  -d '{"source":"sw:<id>","sourceId":"<id>","chapterFrom":"none","autoUpdate":true}'
```

`chapterFrom: none` مقصود: القراءة عند الطلب، لا مرآة دائمة. الفصل يُجلب من
صفحة العمل عند فتحه (`POST /v1/series/:id/fetch`).

---

## 5. النفق — على جهازك، لا من بيئة معزولة

**لم تُنفَّذ هذه الخطوة هنا.** cloudflared يحتاج **المنفذ 7844 صادرًا**
(QUIC/UDP وTCP معًا) لقناة بياناته، وبيئة هذه الجلسة تحجبه. تشخيصه الخاص:

```
UDP Connectivity  region1.v2.argotunnel.com  FAIL  QUIC connection failed
TCP Connectivity  region1.v2.argotunnel.com  FAIL  HTTP/2 connection is blocked
Cloudflare API    api.cloudflare.com:443     PASS
ERROR: Allow outbound TCP on port 7844.
```

فالحافة ترجع `530 origin unreachable`. على شبكة منزلية عادية المنفذ مفتوح.

للتحقق قبل أي شيء:

```bash
cloudflared tunnel diagnostic   # أو: nc -zv region1.v2.argotunnel.com 7844
```

ثم:

```bash
cloudflared tunnel login
cloudflared tunnel create vantara
cloudflared tunnel route dns vantara vantara.example.com
```

ضع التوكن في `.env` وشغّل:

```bash
TUNNEL_TOKEN=<token> docker compose -f infra/docker-compose.yml --profile public up -d
```

### Cloudflare Access أمامه

النفق وحده يجعل الموقع **علنيًا**، وحمايته الوحيدة تصبح شاشة دخول VANTARA.
أضف Zero Trust → Access → Application على النطاق، واسمح لبُرد الثلاثة فقط.
مجاني تحت 50 مستخدمًا.

> **قبل أول عنوان علني:** بدّل كل كلمة مرور استخدمتها أثناء التطوير. أي كلمة
> ظهرت في ملف أو أمر تُعدّ منشورة.

---

## 6. التحقق

```bash
curl -s localhost:3100/healthz        # {"ok":true,"db":true,"uchiyomi":true}
curl -s localhost:3100/livez          # يجيب حتى والقاعدة ساقطة
```

`/healthz` يرجع **503** إذا سقط أحد التابعين — فـUptime Kuma يرى العطل ولا
يخمّنه. وجّهه إلى `/healthz` لا `/livez`.

```bash
docker compose -f infra/docker-compose.yml --profile monitoring up -d
```

---

## 7. النسخ الاحتياطي

PostgreSQL لا يُنسخ من مجلد البيانات وهو حي. أولًا أنشئ dump منطقيًا متحققًا
لقاعدتي **VANTARA وUchiyomi**، ثم اجعل Restic يشفّر الـdumps مع مرفقات البلاغات:

```bash
docker compose -f infra/docker-compose.yml --profile backup run --rm --entrypoint sh db-backup \
  /scripts/backup-postgres.sh

docker compose -f infra/docker-compose.yml --profile backup run --rm backup \
  "restic backup /backups/postgres /source/api-uploads"
```

يغطي: قاعدتي VANTARA وUchiyomi (ومنها التقدم/المكتبة والـglossary والبروفايلات)
+ **مرفقات البلاغات** في `api_uploads`.

**لا يغطي:** مكتبة الملفات الخارجية `LIBRARY_PATH`، تنزيلات/كاش Uchiyomi،
كاش الصور، ولا الترجمات. هذه إما قابلة لإعادة الجلب أو تحتاج سياسة تخزين مستقلة.

استعادة القاعدتين نفسها مُختبرة في CI عبر `infra/restore-postgres.sh`. لا تعتبر
snapshot Restic صالحة حتى تختبر أيضًا استعادة المرفقات على بيئة غير إنتاجية.

---

## 8. أعطال قابلة للتوقع

| العطل | السبب | الحل |
|---|---|---|
| `Not enough free space … floor is 10 GiB` | الأرضية الصلبة في Uchiyomi | فرّغ قرصًا. ليست قابلة للتعطيل |
| `Cloudflare bypass currently disabled` | FlareSolverr غير مشغّل أو غير موصول | تحقق من `FLARESOLVERR_URL` وأن الحاوية `healthy` |
| `429` على تسجيل الدخول | Uchiyomi يحدّ معدّل `/auth/login` | انتظر. لا تعد المحاولة آليًا — VANTARA لا يعيدها لهذا السبب |
| `403 does not have the admin scope` | التوكن بلا `admin` | اصكّ واحدًا بالنطاق الصحيح |
| البحث يرجع نتائج غير ذات صلة | `SEARCH_BROKEN` | المصدر يبقى صالحًا للقراءة؛ الاكتشاف يمر بـPOPULAR |
| تعديل لا يظهر في التطوير | عملية قديمة ما زالت تخدم | `ps -eo pid,args \| grep server.ts` ثم اقتل. **`ss -ltnp` لا يعرض PIDs في كل بيئة**، فالقتل بالمنفذ قد يفشل صامتًا |
| FlareSolverr يفشل بعد أسابيع | تسرّب موثّق حتى 2.5GB | `mem_limit: 2g` + `restart` يحوّله لإعادة تشغيل |
