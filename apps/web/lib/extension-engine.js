/**
 * محرّك الإضافات — جهة القارئ.
 *
 * الطبقة الأصلية (`ExtensionEnginePlugin.kt`) تحمّل إضافة Keiyoushi من ملف
 * وتشغّلها في نفس العملية. هذا الملف لا يعرف عن المصادر شيئًا: لا روابط ولا
 * بصمات ولا أسماء مضيفات. بيان المصادر يسكن في `Sources.kt` وحده، ويُقرأ
 * بـ`sources()`.
 *
 * ومقصودٌ ألّا يكون هنا بديلٌ يعمل على الويب. القارئ على المتصفح لا يستطيع
 * تحميل DEX، وبديلٌ يرجع بيانات تشبه الحقيقية يجعل شاشةً مكسورة تبدو سليمة
 * — وهذا أسوأ من شاشة تقول «غير متاح». فـ`isAvailable()` تُسأل أولًا.
 */

/** الجسر، أو `null` على الويب. يُقرأ عند كل نداء: Capacitor يحقنه قبل JS. */
function bridge() {
	return globalThis.Capacitor?.Plugins?.ExtensionEngine ?? null;
}

/** هل المحرّك موجود أصلًا؟ تُسأل قبل عرض أي واجهة مصادر. */
export function isAvailable() {
	return bridge() !== null;
}

function required() {
	const plugin = bridge();
	if (!plugin) {
		throw new Error('محرّك الإضافات غير متاح — هذه الشاشة تعمل داخل التطبيق فقط');
	}
	return plugin;
}

/**
 * بيان المصادر: `{ id, label, lib, ready }`.
 *
 * `ready` يقول إن المصدر محمَّل في الذاكرة الآن، فالنداء التالي عليه فوري.
 */
export async function sources() {
	const { sources: list } = await required().sources();
	return list ?? [];
}

/**
 * تنزيل ⇒ تحقّق بصمة ⇒ تحميل. يُنادى مرة قبل تصفّح مصدر.
 *
 * أول نداء يلمس الشبكة وقد يطول (تنزيل حزمة ~٦٠ كيلوبايت ثم فكّ DEX)، وما
 * بعده يُخدَم من الذاكرة. فالواجهة تُظهر «جارٍ فتح المصدر» على هذا وحده.
 */
export async function prepare(sourceId) {
	return required().prepare({ sourceId });
}

/** الرائج — الواجهة الأولى عند فتح مصدر. `{ mangas, hasNextPage, page }`. */
export async function popular(sourceId, page = 1) {
	return required().popular({ sourceId, page });
}

/** آخر التحديثات — ومنه يأتي «الجلب التلقائي» للفصول الجديدة. */
export async function latest(sourceId, page = 1) {
	return required().latest({ sourceId, page });
}

export async function search(sourceId, query, page = 1) {
	return required().search({ sourceId, query, page });
}

/**
 * تفاصيل عمل وفصوله معًا: `{ manga, chapters }`.
 *
 * نداءٌ واحد لا اثنان، وهذا شرط صحة لا تحسين: إضافات lib 1.6 ترمي
 * `getMangaUpdate must not be called concurrently for same manga` حين يصلها
 * طلبان لنفس العمل في وقت واحد. فلا تُشطر هذه إلى نداءين متوازيين ثانيةً.
 *
 * ويأخذ كائن العمل كاملًا لا رابطه: عقد lib 1.6 يعطي كل عمل حالةً خاصة
 * بالمصدر (`memo`) يحتاجها حين يُسأل عنه، وإرسال الرابط وحده يعني أن
 * المصدر يستقبل عملًا لا يعرفه. فمرّر ما جاءك كما جاءك.
 */
export async function series(sourceId, manga) {
	const out = await required().series({ sourceId, manga });
	return { manga: out.manga, chapters: out.chapters ?? [] };
}

/** فصول عمل. نفس قاعدة `memo`: مرّر كائن العمل كما جاءك من البحث أو الرائج. */
export async function chapters(sourceId, manga) {
	const { chapters: list } = await required().chapters({ sourceId, manga });
	return list ?? [];
}

/** صفحات فصل. مرّر كائن الفصل كما جاءك من `chapters()`. */
export async function pages(sourceId, chapter) {
	const { pages: list } = await required().pages({ sourceId, chapter });
	return list ?? [];
}

/**
 * رابط صورة صفحة، جاهزًا لـ`<img src>`.
 *
 * الطبقة الأصلية تنزّل بعميل المصدر وترويساته — مضيفات الصور تردّ 403 بلا
 * `Referer` الصحيح — ثم تكتب الملف في كاش التطبيق وترجع مساره. و
 * `convertFileSrc` يحوّله إلى رابط يقرؤه الـWebView من خادم Capacitor
 * المحلي، فلا تمرّ بايتات الصورة عبر جسر JSON ولا تسكن ذاكرة الصفحة.
 */
export async function pageImage(sourceId, page) {
	const result = await required().image({ sourceId, page });
	const convert = globalThis.Capacitor?.convertFileSrc;
	return {
		...result,
		src: convert ? convert(result.path) : result.dataUrl ?? result.path,
	};
}

/** إفراغ كاش الصفحات. يُنادى من «امسح التنزيلات» أو عند ضيق التخزين. */
export async function clearImageCache() {
	return required().clearImageCache();
}

export default {
	isAvailable,
	sources,
	prepare,
	popular,
	latest,
	search,
	series,
	chapters,
	pages,
	pageImage,
	clearImageCache,
};
