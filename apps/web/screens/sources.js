/**
 * تصفّح المصادر وقراءتها — ككتالوج واحد.
 *
 * ثلاث شاشات: الكتالوج ← عمل ← قراءة. والمصادر الخمسة لا تظهر في أيٍّ منها:
 * القارئ يبحث مرة فتُسأل كلها معًا، والعمل الذي تحمله ثلاثة يصير بطاقةً
 * واحدة، وفصولُه اتحادُ ما عند الثلاثة. وهذا هو الكسب: مصدرٌ واقفٌ عند الفصل
 * ١٢٠٠ وآخر بالغٌ ١٣٠٠، والقارئ يبلغ ١٣٠٠ بلا أن يعرف من أين جاء.
 *
 * ولا خادم محتوى في الطريق: كل نداء يذهب إلى محرّك الإضافات في الطبقة
 * الأصلية، وهو يحمّل إضافة Keiyoushi من ملف ويشغّلها في نفس العملية.
 *
 * قاعدتان تحكمان الملف كله:
 *
 * **كائنات العمل والفصل تُمرَّر كما جاءت.** عقد lib 1.6 يعطي كل عمل حالةً
 * خاصة بالمصدر (`memo`) يحتاجها حين يُسأل عن تفاصيله أو فصوله، وإرسال
 * الرابط وحده يعني أن المصدر يستقبل عملًا لا يعرفه — والعطل يظهر بعد خطوتين
 * من موضعه. فلا تُعاد بناء هذه الكائنات هنا أبدًا، ولا تُختصر إلى معرّف.
 *
 * **لا ندائين متوازيين لنفس العمل على نفس المصدر.** إضافات lib 1.6 تحرس ضد
 * ذلك وترمي `getMangaUpdate must not be called concurrently for same manga`.
 * ولهذا `engine.series()` نداءٌ جامع واحد، والتوازي هنا بين المصادر لا
 * داخل الواحد.
 */

import engine from '../lib/extension-engine.js';
import { createWorkIndex, gather, mergeChapters } from '../lib/catalog.js';

const el = (tag, className, text) => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
};

/**
 * الخطأ يُعرض بنصّه كما جاء من المحرّك.
 *
 * «تعذّر التحميل» لا يقول شيئًا، ورسالة المحرّك تقول أي خطوة سقطت وبأي
 * استثناء — وهي الفرق بين تشخيصٍ في دقيقة وتخمينٍ في ساعة.
 */
function errorBox(error, onRetry) {
	const box = el('div', 'state state--error');
	box.append(el('p', null, String(error?.message ?? error)));
	if (onRetry) {
		const retry = el('button', 'btn btn--small', 'أعد المحاولة');
		retry.type = 'button';
		retry.addEventListener('click', onRetry);
		box.append(retry);
	}
	return box;
}

const busy = (text) => el('div', 'state', text);

/** رسالة تقول أي مصادر سقطت ولماذا، بلا أن تحجب ما نجح. */
function failureNote(failed) {
	const note = el('div', 'state state--dim');
	note.append(el('p', null, `${failed.length} من المصادر لم تردّ:`));
	for (const { source, error } of failed) {
		note.append(el('p', null, `${source.label} — ${String(error?.message ?? error)}`));
	}
	return note;
}

/** بطاقة عمل. الغلاف قد يغيب ويصل من مصدر لاحق، والبطاقة تبقى قابلة للنقر. */
function workCard(work, onOpen) {
	const card = el('button', 'tile');
	card.type = 'button';
	const shot = el('div', 'tile__shot');
	const cover = el('img', 'tile__cover');
	cover.loading = 'lazy';
	cover.decoding = 'async';
	cover.alt = '';
	shot.append(cover);
	card.append(shot, el('div', 'tile__title', work.title || '—'));
	card.addEventListener('click', () => onOpen(work));
	const paint = (url) => {
		if (!url) {
			shot.classList.add('tile__shot--blank');
			return;
		}
		shot.classList.remove('tile__shot--blank');
		cover.src = url;
	};
	cover.addEventListener('error', () => shot.classList.add('tile__shot--blank'));
	paint(work.thumbnailUrl);
	return { card, paint, hasCover: () => Boolean(cover.getAttribute('src')) };
}

// ───────────────────────────── ١) الكتالوج ─────────────────────────────

/**
 * الرائج من كل المصادر، والبحث يستبدله.
 *
 * أول فتح ينزّل حزم الإضافات ويتحقق من بصماتها ويفكّ الـDEX، وقد يطول بضع
 * ثوانٍ لكل مصدر؛ وما بعده من الذاكرة. ولهذا تُبتلع كل دفعة عند وصولها بدل
 * انتظار الخمسة: أسرع مصدر يملأ الشاشة بينما أبطؤهم ما زال ينزّل.
 */
export async function screenCatalog({ mount, topbar, bottomNav, go, setScreen, standalone }) {
	setScreen?.('EXPLORE');
	const wrap = el('main', 'page');
	// بلا حساب لا رئيسية نرجع إليها: إعادة التحميل تعيد الإقلاع فتظهر شاشة
	// «اضبط عنوان الخادم» كما كانت، وهو المخرج الوحيد الصادق هنا.
	wrap.append(
		topbar({
			title: 'استكشاف',
			back: standalone ? () => globalThis.location.reload() : () => go({ name: 'home' }),
		}),
	);
	const body = el('div', 'page__body');

	const form = el('form', 'search');
	const input = el('input', 'search__input');
	input.type = 'search';
	input.placeholder = 'ابحث…';
	const submit = el('button', 'search__go', 'بحث');
	submit.type = 'submit';
	form.append(input, submit);

	const status = el('div');
	const grid = el('div', 'tiles');
	const footer = el('div', 'tiles__more');
	body.append(form, status, grid, footer);
	wrap.append(body);
	if (!standalone) wrap.append(bottomNav('explore'));
	mount(wrap);

	// لا بديل وهمي على الويب: شاشةٌ تعرض بيانات تشبه الحقيقية تجعل
	// المكسور يبدو سليمًا، وهذا أسوأ من قول «غير متاح» صراحة.
	if (!engine.isAvailable()) {
		body.append(
			el('div', 'state', 'المصادر تعمل داخل تطبيق أندرويد فقط — محرّك الإضافات ليس في المتصفح.'),
		);
		return;
	}

	let sources;
	try {
		sources = await engine.sources();
	} catch (error) {
		status.replaceChildren(
			errorBox(error, () => void screenCatalog({ mount, topbar, bottomNav, go, setScreen, standalone })),
		);
		return;
	}

	let mode = { kind: 'popular', query: '' };
	let index = createWorkIndex();
	let cards = new Map();
	let cursor = new Map();
	let loading = false;
	/**
	 * أي بحثٍ تخصّ النتائج الواصلة.
	 *
	 * المصادر قد تتأخّر ثوانيَ، والقارئ يبحث عن شيء آخر أثناء ذلك. بلا هذا
	 * العدّاد كانت نتائج البحث القديم تُسكب في شبكة البحث الجديد — أو يُهمل
	 * البحث الجديد كله لأن `loading` ما زالت مرفوعة.
	 */
	let generation = 0;

	function reset() {
		generation += 1;
		index = createWorkIndex();
		cards = new Map();
		cursor = new Map(sources.map((source) => [source.id, { page: 0, hasNext: true }]));
		grid.replaceChildren();
		footer.replaceChildren();
	}

	function absorb(source, mangas) {
		for (const manga of mangas) {
			const added = index.add({ sourceId: source.id, label: source.label, manga });
			if (!added) continue;
			if (added.isNew) {
				const card = workCard(added.work, (work) => go({ name: 'work', work, standalone }));
				cards.set(added.work.key, card);
				grid.append(card.card);
			} else {
				// غلافٌ وصل من مصدر لاحق يملأ بطاقةً رُسمت فارغة
				const card = cards.get(added.work.key);
				if (card && !card.hasCover()) card.paint(added.work.thumbnailUrl);
			}
		}
	}

	async function load() {
		if (loading) return;
		loading = true;
		const mine = generation;
		footer.replaceChildren();
		const wanted = sources.filter((source) => cursor.get(source.id).hasNext);
		if (wanted.length === 0) {
			loading = false;
			return;
		}

		let done = 0;
		const progress = busy(`جارٍ سؤال المصادر… ٠/${wanted.length}`);
		status.replaceChildren(progress);

		const { failed } = await gather(wanted, async (source) => {
			const slot = cursor.get(source.id);
			const page = slot.page + 1;
			try {
				const result =
					mode.kind === 'search'
						? await engine.search(source.id, mode.query, page)
						: await engine.popular(source.id, page);
				if (generation !== mine) return;
				slot.page = page;
				slot.hasNext = Boolean(result.hasNextPage);
				absorb(source, result.mangas ?? []);
			} finally {
				done += 1;
				if (generation === mine) {
					progress.textContent = `جارٍ سؤال المصادر… ${done}/${wanted.length}`;
				}
			}
		});

		loading = false;
		// بحثٌ جديد وصل ونحن ننتظر: هذه النتائج لا تخصّ ما يُعرض الآن، ونداء
		// البحث الجديد كان قد ارتدّ عن `loading` فيُستأنف هنا
		if (generation !== mine) {
			void load();
			return;
		}

		// مصدرٌ سقط لا يُسأل ثانيةً في هذا البحث، وسقوطُه لا يمنع «المزيد» من البقية
		for (const { source } of failed) cursor.get(source.id).hasNext = false;

		const found = index.list().length;
		status.replaceChildren();
		if (found === 0) {
			status.append(
				failed.length === sources.length
					? errorBox(failed[0].error, () => void load())
					: el('div', 'state', 'لا نتائج.'),
			);
		}
		if (failed.length > 0 && found > 0) status.append(failureNote(failed));

		if (sources.some((source) => cursor.get(source.id).hasNext)) {
			const more = el('button', 'btn btn--ghost', 'المزيد');
			more.type = 'button';
			more.addEventListener('click', () => void load());
			footer.append(more);
		}
	}

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		const query = input.value.trim();
		mode = query ? { kind: 'search', query } : { kind: 'popular', query: '' };
		reset();
		void load();
	});

	reset();
	await load();
}

// ───────────────────────────── ٢) عمل واحد ─────────────────────────────

/**
 * عملٌ واحد وفصولُه مجموعةً من كل مصدر يحمله.
 *
 * النسخة الأولى تُسأل بـ`series` فتأتي بالوصف والفصول معًا في نداء واحد،
 * والبقية بـ`chapters` وحدها — وصفُها لا يعنينا وقد جاء من الأولى. والتوازي
 * بين المصادر لا داخل المصدر الواحد، وهذا شرط صحة لا سرعة.
 */
export async function screenWork({ mount, topbar, bottomNav, go, setScreen, standalone, work }) {
	setScreen?.('SERIES');
	const wrap = el('main', 'page');
	wrap.append(
		topbar({
			title: work.title || 'عمل',
			back: () => go({ name: 'sources', standalone }),
		}),
	);
	const body = el('div', 'page__body');

	const head = el('section', 'work');
	const cover = el('img', 'work__cover');
	cover.alt = '';
	if (work.thumbnailUrl) cover.src = work.thumbnailUrl;
	const meta = el('div', 'work__meta');
	meta.append(el('h1', 'work__title', work.title || '—'));
	const description = el('p', 'work__desc', '');
	meta.append(description);
	head.append(cover, meta);

	const status = el('div');
	const list = el('ul', 'chapters');
	body.append(head, status, list);
	wrap.append(body);
	if (!standalone) wrap.append(bottomNav('explore'));
	mount(wrap);

	const primary = work.editions[0];
	let done = 0;
	const progress = busy(`جارٍ جمع الفصول… ٠/${work.editions.length}`);
	status.replaceChildren(progress);

	const { ok, failed } = await gather(work.editions, async (edition) => {
		try {
			if (edition === primary) {
				const out = await engine.series(edition.sourceId, edition.manga);
				if (out.manga?.description) description.textContent = out.manga.description;
				return { ...edition, chapters: out.chapters };
			}
			return { ...edition, chapters: await engine.chapters(edition.sourceId, edition.manga) };
		} finally {
			done += 1;
			progress.textContent = `جارٍ جمع الفصول… ${done}/${work.editions.length}`;
		}
	});

	const merged = mergeChapters(ok.map((result) => result.value));
	status.replaceChildren();

	if (merged.length === 0) {
		status.append(
			failed.length > 0
				? errorBox(failed[0].error, () =>
						void screenWork({ mount, topbar, bottomNav, go, setScreen, standalone, work }),
					)
				: el('div', 'state', 'لا فصول في هذا العمل.'),
		);
		return;
	}

	// عدد المصادر يقول للقارئ من أين جاءت الفصول الزائدة، بلا وسم كل سطر
	const from = ok.length > 1 ? `${merged.length} فصل من ${ok.length} مصادر` : `${merged.length} فصل`;
	status.append(el('div', 'state', from));
	if (failed.length > 0) status.append(failureNote(failed));

	// الأسطر تُبنى في قطعة واحدة ثم تُلحق مرة: عملٌ بألف فصل يضيف ألف عقدة،
	// وإلحاقُها واحدةً واحدة يُعيد حساب التخطيط ألف مرة.
	const fragment = document.createDocumentFragment();
	for (const row of merged) {
		const item = el('li');
		const button = el('button', 'chapter');
		button.type = 'button';
		button.append(el('span', 'chapter__name', row.chapter.name || '—'));
		if (row.chapter.scanlator) button.append(el('span', 'pill', row.chapter.scanlator));
		button.addEventListener('click', () =>
			go({
				name: 'extReader',
				sourceId: row.sourceId,
				manga: row.manga,
				chapter: row.chapter,
				work,
				standalone,
			}),
		);
		item.append(button);
		fragment.append(item);
	}
	list.append(fragment);
}

// ───────────────────────────── ٣) القراءة ─────────────────────────────

/** كم صفحة تُجلب معًا. ثلاثٌ تكفي للتمرير المتصل بلا أن تخنق شبكة الجوال. */
const PAGE_CONCURRENCY = 3;

export async function screenExtReader({
	mount,
	topbar,
	go,
	setScreen,
	standalone,
	sourceId,
	manga,
	chapter,
	work,
}) {
	setScreen?.('READER');
	const wrap = el('main', 'page');
	wrap.append(
		topbar({
			title: chapter.name || 'قراءة',
			back: () => go({ name: 'work', work, standalone }),
		}),
	);
	const shell = el('div', 'reader');
	const flow = el('div', 'reader__flow');
	const status = el('div');
	shell.append(status, flow);
	wrap.append(shell);
	mount(wrap);

	status.replaceChildren(busy('جارٍ جلب الصفحات…'));
	let pages;
	try {
		pages = await engine.pages(sourceId, chapter);
	} catch (error) {
		status.replaceChildren(
			errorBox(error, () =>
				void screenExtReader({ mount, topbar, go, setScreen, standalone, sourceId, manga, chapter, work }),
			),
		);
		return;
	}

	if (pages.length === 0) {
		status.replaceChildren(el('div', 'state', 'الفصل بلا صفحات.'));
		return;
	}
	status.replaceChildren();

	// الإطارات تُبنى كلها أولًا فيصير للتمرير طولٌ من البداية، ثم تُملأ.
	// وبلا ذلك يقفز المحتوى تحت الإصبع كلما وصلت صورة.
	const slots = pages.map((page) => {
		const frame = el('div', 'reader__frame');
		flow.append(frame);
		return { page, frame };
	});

	async function draw(slot) {
		const image = await engine.pageImage(sourceId, slot.page);
		const img = el('img', 'reader__image');
		img.alt = '';
		img.decoding = 'async';
		img.src = image.src;
		slot.frame.replaceChildren(img);
	}

	// صفحة تسقط لا تُسقط الفصل: يُعرض سببها في مكانها، وتُعاد محاولتها
	// وحدها — وما بعدها يبقى يُجلب.
	async function attempt(slot) {
		try {
			slot.frame.classList.remove('reader__frame--error');
			await draw(slot);
		} catch (error) {
			slot.frame.classList.add('reader__frame--error');
			slot.frame.replaceChildren(errorBox(error, () => void attempt(slot)));
		}
	}

	let next = 0;
	async function worker() {
		while (next < slots.length) {
			const slot = slots[next];
			next += 1;
			await attempt(slot);
		}
	}

	await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, () => worker()));
}
