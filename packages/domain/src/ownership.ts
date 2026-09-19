/**
 * ملكية البيانات — مصدر حقيقة واحد لكل نوع بيانات.
 *
 * المشكلة التي يحلّها هذا الملف ليست نظرية: VANTARA يخزّن نفس المعنى في
 * مخزنين. تقدم القراءة يعيش عند Uchiyomi وفي D1، والبروفايل والحضور والنشاط
 * والتعليقات والتوصيات لها جدول في PostgreSQL وجدول في D1 ومسار HTTP لكل
 * منهما. مخزنان يملكان نفس الحقيقة يعني أن المستخدم يرى الفصل «غير مقروء» في
 * صفحة العمل و«مقروء» في الإحصائيات، ويكتب تعليقًا فلا يظهر لأحد.
 *
 * ثلاث قواعد حاكمة:
 *
 * 1. **مالك واحد لكل نوع.** لا «مالك أساسي» ولا «مالك احتياطي». `assertSingleOwner`
 *    يفشل عند أول ازدواج، ويُشغَّل في الاختبارات حتى لا يعود الازدواج بهدوء.
 *
 * 2. **المرآة مشتقة ومُعلَّمة.** يجوز لمخزن أن يحمل نسخة لأجل المزامنة بين
 *    الأجهزة أو العمل بلا شبكة، بشرط أن تُعرَف كمرآة: تُصالح مع المالك، ولا
 *    تُقرأ كحقيقة نهائية، ولا تُرجع المالك للخلف.
 *
 * 3. **الجدول المتقاعد لا يُكتب.** إسقاط الجداول فعليًا ملك باتش الـmigrations؛
 *    إلى أن يحدث، `retired` يسمّيها كي لا يعيد كود جديد الكتابة فيها.
 */

/** المخازن التي يعرفها VANTARA. لا «مخزن آخر» غير مسمّى. */
export const OWNERSHIP_STORES = ['UCHIYOMI', 'D1', 'POSTGRES', 'IDENTITY', 'DEVICE'] as const;

export type Store = (typeof OWNERSHIP_STORES)[number];

export interface DataDomainSpec {
  /** معرّف نوع البيانات، لا اسم جدول: الجداول تتغير والمعنى يبقى. */
  readonly key: string;
  readonly owner: Store;
  /** مخازن يجوز أن تحمل نسخة مشتقة. لا تحتوي المالك أبدًا. */
  readonly mirrors: readonly Store[];
  /** الجداول الحيّة لكل مخزن. */
  readonly tables: Readonly<Partial<Record<Store, readonly string[]>>>;
  /** جداول موجودة فيزيائيًا وممنوع الكتابة فيها، لكل مخزن. */
  readonly retired: Readonly<Partial<Record<Store, readonly string[]>>>;
  readonly why: string;
}

/**
 * مصفوفة الملكية الرسمية.
 *
 * ترتيبها: المحتوى، ثم القراءة، ثم الاجتماعي، ثم الهوية، ثم التشغيل، ثم الجهاز.
 */
export const DATA_OWNERSHIP: readonly DataDomainSpec[] = [
  {
    key: 'content.catalogue',
    owner: 'UCHIYOMI',
    mirrors: [],
    tables: {},
    retired: {},
    why: 'الأعمال والفصول والصفحات واكتشاف المصادر تُقرأ من Uchiyomi عند الطلب. نسخة دائمة عندنا تعني كتالوجًا يتخلف عن المصدر بصمت.',
  },
  {
    key: 'library.membership',
    owner: 'UCHIYOMI',
    mirrors: ['D1'],
    tables: { D1: ['library', 'works'] },
    retired: {},
    why: 'الإضافة والمتابعة والتحديث التلقائي تحدث عند Uchiyomi. جدولا library وworks في D1 مرآة اجتماعية فقط: `works` هو وصف العمل الواحد (عنوان وغلاف) لتعرضه المفضلة والتوصيات والإشعارات بدل تخزينه في كل جدول، ولا يُقرأ أيٌّ منهما كمصدر للمكتبة.',
  },
  {
    key: 'reading.progress',
    owner: 'UCHIYOMI',
    mirrors: ['D1'],
    tables: { D1: ['progress'] },
    retired: {},
    why: 'القارئ يستكمل من تقدم Uchiyomi. مرآة D1 صندوق صادر: تحمل ما لم يصل المالك بعد، وتُصالح عبر reconcileProgress، ولا تُرجع المالك للخلف.',
  },
  {
    key: 'reading.ratings',
    owner: 'D1',
    mirrors: [],
    tables: { D1: ['ratings'] },
    retired: {},
    why: 'التقييم في VANTARA إشارة اجتماعية تُعرض للأصدقاء وتُزامَن بين الأجهزة، فمالكه D1. تقييم Uchiyomi الداخلي ليس نفس الحقيقة ولا يُكتب من هنا.',
  },
  {
    key: 'stats.reading',
    owner: 'D1',
    mirrors: [],
    tables: { D1: ['chapter_reads', 'usage_daily'] },
    retired: { POSTGRES: ['vantara_reading_sessions'] },
    why: 'الإحصاء على الفصول لا الصفحات، ووقت الاستخدام في المقدمة فقط. جلسات القراءة في PostgreSQL كانت حسابًا ثانيًا للوقت نفسه.',
  },
  {
    key: 'social.profile',
    owner: 'D1',
    mirrors: [],
    tables: { D1: ['profiles'] },
    retired: { POSTGRES: ['vantara_profiles'] },
    why: 'الاسم والصورة والبانر والنبذة تُعدَّل من التطبيق وتُزامَن بـfield_revs. نسخة PostgreSQL كانت مسارًا ثانيًا للكتابة لا يراه العميل.',
  },
  {
    key: 'social.presence',
    owner: 'D1',
    mirrors: [],
    tables: { D1: ['presence'] },
    retired: { POSTGRES: ['vantara_presence'] },
    why: 'النبضة تصل الـWorker مباشرة والحالة تُشتق من beat_at عند القراءة. الإخفاء يُقرأ من settings في نفس المخزن، فلا تنقسم الخصوصية بين مخزنين.',
  },
  {
    key: 'social.activity',
    owner: 'D1',
    mirrors: [],
    tables: { D1: ['activity', 'activity_receipts'] },
    retired: { POSTGRES: ['vantara_activity_events'] },
    why: 'الأحداث الخفيفة تُبث للأصدقاء عبر سجل الفروقات نفسه، وactivity_receipts يحمل إيصال كل مشاهد للحالة delivered/seen بلا حالة عامة مزيفة.',
  },
  {
    key: 'social.comments',
    owner: 'D1',
    mirrors: [],
    tables: { D1: ['comments', 'reactions'] },
    retired: { POSTGRES: ['vantara_comments', 'vantara_comment_reactions'] },
    why: 'التعليقات والتفاعلات تُكتب كعمليات معرّفة بـop_id وتُسحب كفروقات. حجب الحارق يُطبَّق عند العرض لأن المرآة كاملة عند العميل.',
  },
  {
    key: 'social.recommendations',
    owner: 'D1',
    mirrors: [],
    tables: { D1: ['recommendations', 'recommendation_recipients'] },
    retired: { POSTGRES: ['vantara_recommendations'] },
    why: 'التوصية كيان مشترك في recommendations، وحالة كل مستلم مستقلة في recommendation_recipients؛ الإشعار يُنشأ في نفس المخزن والدفعة الذرّية.',
  },
  {
    key: 'social.notifications',
    owner: 'D1',
    mirrors: [],
    tables: { D1: ['notifications'] },
    retired: {},
    why: 'الإشعارات داخل التطبيق فقط، وصندوقها دائم في D1. لا Push من نظام التشغيل.',
  },
  {
    key: 'social.settings',
    owner: 'D1',
    mirrors: [],
    tables: { D1: ['settings'] },
    retired: { POSTGRES: ['vantara_user_gates'] },
    why: 'الإعدادات المشتركة بين الأجهزة — الإخفاء وبوابة محتوى البالغين وتفضيلات التنبيه — حقول في settings تُدمج على مستوى الحقل.',
  },
  {
    key: 'collections.membership',
    owner: 'D1',
    mirrors: [],
    tables: { D1: ['collections'] },
    retired: {},
    why: 'المفضلة وأقرأ لاحقًا عضوية بشاهد قبر، والحذف الصامت لا يُزامَن.',
  },
  {
    key: 'identity.account',
    owner: 'IDENTITY',
    mirrors: ['D1'],
    tables: { D1: ['accounts'] },
    retired: {},
    why: 'user_id يُنشأ مرة ولا يتغير. صف accounts في D1 هو ما تحتاجه شاشة اختيار الحساب قبل أي جلسة؛ عقد الهوية نفسه يُثبَّت في باتش الهوية.',
  },
  {
    key: 'identity.session',
    owner: 'IDENTITY',
    mirrors: [],
    tables: { POSTGRES: ['vantara_sessions', 'vantara_users'] },
    retired: {},
    why: 'اختيار الحساب هو الدخول. الجلسة وتوكن المحتوى تملكهما طبقة الهوية الموحدة، لا الاجتماعي ولا المحتوى.',
  },
  {
    key: 'ops.reports',
    owner: 'POSTGRES',
    mirrors: [],
    tables: {
      POSTGRES: ['vantara_reports', 'vantara_report_attachments', 'vantara_report_actions'],
    },
    retired: {},
    why: 'بلاغات المشاكل ومرفقاتها وإجراءاتها تشخيصية للمشغّل، لا تُبث للأصدقاء ولا تُزامَن للأجهزة.',
  },
  {
    key: 'ops.content_policy',
    owner: 'POSTGRES',
    mirrors: [],
    tables: {
      POSTGRES: [
        'vantara_content_policy',
        'vantara_deleted_works',
        'vantara_merge_snapshots',
        'vantara_audit_log',
      ],
    },
    retired: {},
    why: 'الحجب والحذف للجميع ولقطات الدمج وسجل التدقيق قرارات تشغيلية بأثر دائم، ومكانها مخزن الخادم.',
  },
  {
    key: 'ops.sources',
    owner: 'POSTGRES',
    mirrors: [],
    tables: { POSTGRES: ['vantara_source_verdicts'] },
    retired: {},
    why: 'حكم المصدر ودليله يُبنيان بالفحص عندنا، ولا يأتيان من Uchiyomi.',
  },
  {
    key: 'device.downloads',
    owner: 'DEVICE',
    mirrors: [],
    tables: {},
    retired: {},
    why: 'الفصول المنزّلة وكاش الصور والملفات المؤقتة وكوكيز المصادر تبقى على الجهاز. رفعها إلى D1 يسرّب المحتوى ويفجّر الحجم بلا فائدة.',
  },
];

function specFor(key: string, specs: readonly DataDomainSpec[] = DATA_OWNERSHIP): DataDomainSpec {
  const spec = specs.find((entry) => entry.key === key);
  if (!spec) throw new Error(`unknown data domain: ${key}`);
  return spec;
}

/** مالك نوع البيانات. يرمي على نوع غير مسجّل بدل أن يخمّن. */
export function ownerOf(key: string, specs: readonly DataDomainSpec[] = DATA_OWNERSHIP): Store {
  return specFor(key, specs).owner;
}

export function mirrorsOf(
  key: string,
  specs: readonly DataDomainSpec[] = DATA_OWNERSHIP,
): readonly Store[] {
  return specFor(key, specs).mirrors;
}

/** هل يملك هذا المخزن هذا الجدول؟ يُستخدم في حرس معماري لا في منطق تشغيل. */
export function storeOwns(
  store: Store,
  table: string,
  specs: readonly DataDomainSpec[] = DATA_OWNERSHIP,
): boolean {
  return specs.some((spec) => (spec.tables[store] ?? []).includes(table));
}

/** الجدول → النوع الذي يملكه. `null` لجدول غير مسجّل أو متقاعد. */
export function ownerOfTable(
  store: Store,
  table: string,
  specs: readonly DataDomainSpec[] = DATA_OWNERSHIP,
): { key: string; owner: Store } | null {
  const spec = specs.find((entry) => (entry.tables[store] ?? []).includes(table));
  return spec ? { key: spec.key, owner: spec.owner } : null;
}

/** كل الجداول المتقاعدة في مخزن. ممنوعة على أي كود جديد. */
export function retiredTables(
  store: Store,
  specs: readonly DataDomainSpec[] = DATA_OWNERSHIP,
): readonly string[] {
  return specs.flatMap((spec) => spec.retired[store] ?? []);
}

/**
 * الحرس المعماري.
 *
 * يفشل على: نوع مكرر، مخزن مالك ومرآة لنفس النوع، جدول واحد تحت نوعين، جدول
 * حيّ ومتقاعد في الوقت نفسه، أو مخزن غير معروف.
 */
export function assertSingleOwner(specs: readonly DataDomainSpec[] = DATA_OWNERSHIP): void {
  const seen = new Set<string>();
  const tableOwners = new Map<string, string>();

  for (const spec of specs) {
    if (seen.has(spec.key)) {
      throw new Error(`data domain declared twice: ${spec.key}`);
    }
    seen.add(spec.key);

    if (!OWNERSHIP_STORES.includes(spec.owner)) {
      throw new Error(`unknown store for ${spec.key}: ${String(spec.owner)}`);
    }

    if (spec.mirrors.includes(spec.owner)) {
      throw new Error(`${spec.key}: ${spec.owner} cannot be owner and mirror at once`);
    }

    for (const [store, tables] of Object.entries(spec.tables) as [Store, readonly string[]][]) {
      if (!OWNERSHIP_STORES.includes(store)) {
        throw new Error(`unknown store for ${spec.key}: ${String(store)}`);
      }
      const retired = new Set(spec.retired[store] ?? []);
      for (const table of tables) {
        if (retired.has(table)) {
          throw new Error(`${spec.key}: ${table} is listed as active and retired`);
        }
        const id = `${store}.${table}`;
        const previous = tableOwners.get(id);
        if (previous !== undefined) {
          throw new Error(`table ${table} claimed by ${previous} and ${spec.key}`);
        }
        tableOwners.set(id, spec.key);
      }
    }
  }
}

// ───────────────────── مصالحة تقدم القراءة ─────────────────────

export interface ProgressSnapshot {
  page: number;
  ratio: number;
}

/**
 * لقطة المالك.
 *
 * `ratio` اختياري بقصد: مالك التقدم عندنا (Uchiyomi) يحفظ الصفحة و`completed`
 * ولا يعرف نسبة داخل الصفحة أصلًا. النسبة تنقيح يعيش في المرآة وحدها، فمقارنتها
 * بما لا يملكه المالك كانت ستُنتج دفعًا أبديًا عند كل إقلاع.
 */
export interface OwnerProgress {
  page: number;
  ratio?: number | null;
}

export interface MirrorProgress extends ProgressSnapshot {
  /** هل أقرّ المالك بهذه القيمة سابقًا. */
  confirmed: boolean;
}

export type ProgressAction =
  | { kind: 'none' }
  /** المالك لم يستلم هذا التقدم: اكتبه عنده. */
  | { kind: 'push-to-owner'; page: number; ratio: number }
  /** المرآة متخلفة أو مخالفة: اجعلها تساوي المالك. */
  | { kind: 'correct-mirror'; page: number; ratio: number }
  /** القيمتان متساويتان لكن المرآة بلا إقرار: علّمها مؤكَّدة. */
  | { kind: 'confirm-mirror'; page: number; ratio: number };

export interface ProgressReconciliation {
  effective: ProgressSnapshot;
  action: ProgressAction;
}

function clampPage(page: number): number {
  return Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0;
}

function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
}

function clampSnapshot(value: ProgressSnapshot): ProgressSnapshot {
  return { page: clampPage(value.page), ratio: clampRatio(value.ratio) };
}

/** لقطة المالك بنسبة معروفة أو `null` إذا لم يكن يحفظها. */
interface ClampedOwner {
  page: number;
  ratio: number | null;
}

/**
 * يقرّر ماذا يُقرأ وماذا يُكتب عندما يختلف المالك ومرآته.
 *
 * هذا هو ما يجعل D1 مرآة لا حقيقة ثانية. بلا هذه الدالة: كتابة تقدم تنجح عند
 * D1 وتفشل عند المالك فيعود القارئ للصفحة الأولى بينما الإحصائيات تقول إن
 * الفصل قُرئ — ولا أحد يصالح الاثنين.
 *
 * القاعدة: المالك يفوز دائمًا على مرآة **مؤكَّدة**، ولا يفوز أبدًا بإرجاع تقدم
 * لم يستلمه بعد. المرآة غير المؤكَّدة تُدمج بـmax ثم تُدفع للمالك.
 */
export function reconcileProgress(input: {
  owner: OwnerProgress | null;
  mirror: MirrorProgress | null;
}): ProgressReconciliation {
  const owner: ClampedOwner | null = input.owner
    ? {
        page: clampPage(input.owner.page),
        ratio:
          input.owner.ratio === undefined || input.owner.ratio === null
            ? null
            : clampRatio(input.owner.ratio),
      }
    : null;
  const mirror = input.mirror ? clampSnapshot(input.mirror) : null;
  const confirmed = input.mirror?.confirmed === true;

  if (!mirror) {
    const effective = owner ? { page: owner.page, ratio: owner.ratio ?? 0 } : { page: 0, ratio: 0 };
    return { effective, action: { kind: 'none' } };
  }

  if (confirmed) {
    // المالك غائب عن الإجابة (شبكة أو خدمة) ليس قرارًا بالحذف: لا نصحّح على لا شيء
    if (!owner) return { effective: mirror, action: { kind: 'none' } };
    // ما لا يحفظه المالك تبقى فيه قيمة المرآة: تصحيح النسبة إلى صفر لأن المالك
    // لا يعرفها كان سيمحو تنقيحًا صحيحًا
    const effective = { page: owner.page, ratio: owner.ratio ?? mirror.ratio };
    const agrees = effective.page === mirror.page && effective.ratio === mirror.ratio;
    return {
      effective,
      action: agrees ? { kind: 'none' } : { kind: 'correct-mirror', ...effective },
    };
  }

  const merged: ProgressSnapshot = {
    page: Math.max(owner?.page ?? 0, mirror.page),
    ratio: Math.max(owner?.ratio ?? 0, mirror.ratio),
  };

  // لا شيء في الطرفين: مرآة فارغة لا تُدفع ولا تُصحّح
  if (merged.page === 0 && merged.ratio === 0) {
    return { effective: merged, action: { kind: 'none' } };
  }

  // المقارنة على ما يملكه المالك فقط: الصفحة دائمًا، والنسبة إن كان يحفظها
  const ownerBehind =
    !owner || merged.page > owner.page || (owner.ratio !== null && merged.ratio > owner.ratio);
  if (ownerBehind) {
    return { effective: merged, action: { kind: 'push-to-owner', ...merged } };
  }

  if (merged.page === mirror.page && merged.ratio === mirror.ratio) {
    return { effective: merged, action: { kind: 'confirm-mirror', ...merged } };
  }

  return { effective: merged, action: { kind: 'correct-mirror', ...merged } };
}
