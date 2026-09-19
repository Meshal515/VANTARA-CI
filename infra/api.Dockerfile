# vantara-api
#
# بناء على مرحلتين: التبعيات الكاملة للبناء، ثم تبعيات الإنتاج وحدها مع dist.
# النتيجة لا تحمل TypeScript ولا vitest ولا مصدرًا.

# قابل للتجاوز: Docker Hub يحدّ المعدّل على عناوين IP مشتركة، و429 يوقف البناء.
# مرآة بديلة: --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo

# بدونه يرفض `pnpm install --prod` مسح node_modules بلا TTY ويفشل البناء:
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
ENV CI=true

RUN corepack enable

# طبقة التبعيات منفصلة عن الكود: تغيير سطر في route لا يعيد تنزيل كل شيء
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/uchiyomi/package.json packages/uchiyomi/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps/api apps/api
RUN pnpm -r build

# تبعيات الإنتاج وحدها، في شجرة نظيفة تُنسخ كما هي
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production

# لا يعمل كـroot. الصورة تكتب في /data/uploads فقط.
RUN addgroup -g 10002 -S vantara \
 && adduser -u 10002 -S -G vantara vantara \
 && mkdir -p /data/uploads \
 && chown -R vantara:vantara /data

COPY --from=build --chown=vantara:vantara /repo/node_modules ./node_modules
COPY --from=build --chown=vantara:vantara /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=vantara:vantara /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=vantara:vantara /repo/apps/api/package.json ./apps/api/
COPY --from=build --chown=vantara:vantara /repo/packages ./packages
# الـmigrations تُشحن مع الصورة كي تُطبَّق من نفس النسخة التي تشغّل الكود
COPY --from=build --chown=vantara:vantara /repo/packages/db/migrations ./packages/db/migrations

USER vantara
EXPOSE 3100

# الإطفاء المنظّم في server.ts يحتاج أن تصل إليه الإشارة مباشرة، لا عبر shell
STOPSIGNAL SIGTERM
CMD ["node", "apps/api/dist/server.js"]
