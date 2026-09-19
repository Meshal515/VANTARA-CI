# vantara-translation-worker
#
# ⚠️ **لم يُبنَ ولم يُختبر.** بيئة كتابته لم تسمح: قرص ممتلئ، وDocker Hub
# محدود المعدّل، ووسيط TLS يعترض الشهادات. الراسم العربي نفسه مُختبر (24
# اختبارًا) لكن هذه الصورة لا. تعامل معه كمسودّة أولى.
#
# قاعدة الصورة: الكشف وOCR وinpainting من محرك جاهز، والرسم العربي من طبقتنا
# (D-04). لذلك هنا Pillow بـraqm، ولا موديلات ONNX.

ARG PYTHON_IMAGE=python:3.12-slim

FROM ${PYTHON_IMAGE} AS runtime

# لا مخزون pip ولا .pyc: يضاعفان حجم الطبقة بلا فائدة في الإنتاج
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# fontconfig لازم لكشف الخطوط، وlibgomp لـONNX/Paddle إن أُضيفا لاحقًا.
# الخطوط العربية من الحزمة لا بتنزيل: أصغر وأثبت من جلبها عند التشغيل.
RUN apt-get update \
 && apt-get install --no-install-recommends -y \
      fonts-noto-core \
      fontconfig \
      libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

WORKDIR /app

# طبقة التبعيات قبل الكود: تعديل سطر في الراسم لا يعيد تثبيت Pillow
COPY services/translation-worker/requirements.txt ./
RUN pip install -r requirements.txt

# بوابة الإقلاع: صورة بلا raqm تنتج عربية معكوسة تبدو سليمة، وهذا أسوأ من
# صورة لا تُبنى. الفحص هنا يُفشل البناء لا التشغيل.
RUN python -c "\
from PIL import features; \
assert features.check('raqm'), 'Pillow wheel has no raqm: no Arabic shaping or bidi'; \
print('raqm', features.version('raqm'))"

COPY services/translation-worker/vantara_worker ./vantara_worker
COPY services/translation-worker/pyproject.toml ./

# الخطوط في مسار ثابت يطابق ARABIC_FONT/LATIN_FONT في compose
RUN mkdir -p /fonts \
 && cp /usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf /fonts/ \
 && cp /usr/share/fonts/truetype/noto/NotoSans-Regular.ttf /fonts/

RUN useradd --uid 10003 --create-home --shell /usr/sbin/nologin worker \
 && mkdir -p /data/translations /models \
 && chown -R worker:worker /data /models

USER worker

# يرفض العمل بلا raqm بدل أن ينتج صفحات معكوسة
ENV REQUIRE_RAQM=true \
    ARABIC_FONT=/fonts/NotoNaskhArabic-Regular.ttf \
    LATIN_FONT=/fonts/NotoSans-Regular.ttf

STOPSIGNAL SIGTERM

# لا نقطة دخول للـworker بعد: الترجمة أسبوع 4 في المخطط. هذا يُثبت البيئة
# ويفشل صريحًا بدل أن يبدو جاهزًا.
CMD ["python", "-c", "raise SystemExit('translation worker entrypoint not implemented yet — see docs/BLUEPRINT.md week 4')"]
