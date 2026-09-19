/**
 * استخراج لون الحساب.
 *
 * خلفية شاشة الحسابات تتناغم مع صورة الحساب الذي في المنتصف. الفكرة قريبة من
 * Discord، والطابع مختلف: VANTARA أهدأ وأغمق، فالخلفية لا تُصارع الصورة ولا
 * النص فوقها.
 *
 * أربع خطوات، وكل واحدة تمنع عيبًا محددًا:
 *
 *   استخراج   — أكثر لونين تكرارًا في الصورة، موزونين بالتشبّع.
 *   تحقق      — صورة رمادية تُعطي رماديًا لا بنفسجيًا مُختلقًا.
 *   إغماق     — سقف على الإضاءة والتشبّع: خلفية فاتحة تُفقد النص الأبيض.
 *   تخزين     — التحليل مرة واحدة لكل صورة، لا مرة في كل رسم.
 */

/** الكاش في الذاكرة: التمرير بين الحسابات لا يعيد التحليل. */
const cache = new Map();

/** التخزين الدائم: أول فتح بعد الإقلاع لا يعيد التحليل أيضًا. */
const STORE_KEY = 'vantara.palette.v1';

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    // نافذة خاصة أو تخزين محجوب: الكاش يبقى في الذاكرة وحدها
    return {};
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // الحصة ممتلئة: التخزين تحسين لا شرط
  }
}

/** لوحة VANTARA الافتراضية: بنفسجي هادئ على أسود عميق. */
export const DEFAULT_PALETTE = Object.freeze({
  primary: '#4a2d73',
  secondary: '#1a1030',
  base: '#050506',
  accent: '#9a42ff',
  achromatic: false,
});

// ───────────────────────────── تحويلات ─────────────────────────────

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const hue = ((h % 1) + 1) % 1;
  let r;
  let g;
  let b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    r = channel(hue + 1 / 3);
    g = channel(hue);
    b = channel(hue - 1 / 3);
  }
  const hex = (value) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// ───────────────────────────── الاستخراج ─────────────────────────────

/** 24 دلوًا للتدرّج اللوني، ودلو منفصل لما لا لون له. */
const HUE_BUCKETS = 24;
/** تحت هذا التشبّع يُحسب البكسل رماديًا لا لونًا. */
const CHROMA_FLOOR = 0.12;

/**
 * أقوى تدرّجين في الصورة.
 *
 * الوزن بالتشبّع مضروبًا في قربه من الإضاءة المتوسطة: بلا ذلك تفوز مساحات
 * الأسود والأبيض الكبيرة دائمًا، فتُعطي كل صورة نفس الرمادي.
 */
function analyze(pixels) {
  const buckets = new Float64Array(HUE_BUCKETS);
  const sums = new Float64Array(HUE_BUCKETS * 2);
  let chromaticWeight = 0;
  let achromaticWeight = 0;
  let lightnessSum = 0;
  let counted = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    if (alpha < 128) continue;
    const [h, s, l] = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    counted += 1;
    lightnessSum += l;
    // الأطراف تُهمَل: الأسود الخالص والأبيض الخالص لا يحملان تدرّجًا مفيدًا
    const midness = 1 - Math.abs(l - 0.5) * 2;
    if (s < CHROMA_FLOOR) {
      achromaticWeight += 1;
      continue;
    }
    const weight = s * (0.25 + 0.75 * midness);
    chromaticWeight += weight;
    const bucket = Math.min(HUE_BUCKETS - 1, Math.floor(h * HUE_BUCKETS));
    buckets[bucket] += weight;
    sums[bucket * 2] += s * weight;
    sums[bucket * 2 + 1] += l * weight;
  }

  if (counted === 0) return null;

  // صورة أبيض وأسود: لا تختلق لها لونًا
  const achromatic = chromaticWeight <= 0 || achromaticWeight > counted * 0.92;
  const meanLightness = lightnessSum / counted;
  if (achromatic) return { achromatic: true, meanLightness };

  let best = 0;
  for (let i = 1; i < HUE_BUCKETS; i += 1) if (buckets[i] > buckets[best]) best = i;

  // الثاني يجب أن يبعد عن الأول: دلو مجاور يعطي نفس اللون مرتين، فتبدو
  // الخلفية مسطّحة بلا عمق
  let second = -1;
  for (let i = 0; i < HUE_BUCKETS; i += 1) {
    const ring = Math.min(Math.abs(i - best), HUE_BUCKETS - Math.abs(i - best));
    if (ring < 2) continue;
    if (second < 0 || buckets[i] > buckets[second]) second = i;
  }

  const hueOf = (bucket) => (bucket + 0.5) / HUE_BUCKETS;
  const satOf = (bucket) => (buckets[bucket] > 0 ? sums[bucket * 2] / buckets[bucket] : 0.4);

  // دلو ثانٍ ضعيف جدًا: تناسق مشتق (قريب على العجلة) أهدأ من لون عابر
  const secondUsable = second >= 0 && buckets[second] > buckets[best] * 0.18;
  return {
    achromatic: false,
    meanLightness,
    primary: { h: hueOf(best), s: satOf(best) },
    secondary: secondUsable
      ? { h: hueOf(second), s: satOf(second) }
      : { h: hueOf(best) - 0.055, s: satOf(best) * 0.85 },
  };
}

// ───────────────────────────── الإغماق ─────────────────────────────

/** سقف التشبّع: فوقه تصير الخلفية صاخبة، والمطلوب هدوء. */
const MAX_SATURATION = 0.52;
/** سقف الإضاءة: فوقه يضعف النص الأبيض فوق الخلفية. */
const PRIMARY_LIGHTNESS = 0.24;
const SECONDARY_LIGHTNESS = 0.12;

function harmonize(analysis) {
  if (!analysis) return { ...DEFAULT_PALETTE };

  if (analysis.achromatic) {
    // أسود ورمادي وأبيض خافت. الصورة الفاتحة تأخذ رماديًا أرفع قليلًا حتى لا
    // تبدو الخلفية منفصلة عنها تمامًا
    const lift = analysis.meanLightness > 0.55 ? 0.05 : 0;
    return {
      primary: hslToHex(0, 0, 0.17 + lift),
      secondary: hslToHex(0, 0, 0.09 + lift),
      base: '#050506',
      accent: hslToHex(0, 0, 0.72),
      achromatic: true,
    };
  }

  const s1 = Math.min(MAX_SATURATION, Math.max(0.2, analysis.primary.s));
  const s2 = Math.min(MAX_SATURATION, Math.max(0.16, analysis.secondary.s));
  return {
    primary: hslToHex(analysis.primary.h, s1, PRIMARY_LIGHTNESS),
    secondary: hslToHex(analysis.secondary.h, s2, SECONDARY_LIGHTNESS),
    base: '#050506',
    // النبرة وحدها ترفع إضاءتها: تُستخدم للحدود والتوهّج لا للخلفية
    accent: hslToHex(analysis.primary.h, Math.min(0.72, s1 + 0.24), 0.62),
    achromatic: false,
  };
}

// ───────────────────────────── الواجهة ─────────────────────────────

const SAMPLE_SIZE = 24;

function sample(image) {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  try {
    return context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    // صورة من أصل آخر بلا CORS: القماش يُلطَّخ وتُرفض القراءة
    return null;
  }
}

/**
 * لوحة الحساب من صورته.
 *
 * تُعيد الافتراضية عند أي تعذّر — صورة لا تُحمَّل أو قماش مُلطَّخ — لا تفشل:
 * شاشة الدخول يجب أن تعمل حتى بلا صورة واحدة.
 */
export async function paletteFor(src) {
  if (!src) return { ...DEFAULT_PALETTE };
  const hit = cache.get(src);
  if (hit) return hit;

  const store = loadStore();
  if (store[src]) {
    cache.set(src, store[src]);
    return store[src];
  }

  const palette = await new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.addEventListener('load', () => resolve(harmonize(analyze(sample(image)))), { once: true });
    image.addEventListener('error', () => resolve({ ...DEFAULT_PALETTE }), { once: true });
    image.src = src;
  });

  cache.set(src, palette);
  store[src] = palette;
  saveStore(store);
  return palette;
}

/** لوحة فورية بلا تحليل: لأول رسم قبل أن تُحمَّل الصورة. */
export function cachedPalette(src) {
  if (!src) return { ...DEFAULT_PALETTE };
  return cache.get(src) ?? loadStore()[src] ?? { ...DEFAULT_PALETTE };
}

/**
 * لوحة مشتقة من نص.
 *
 * حساب بلا صورة يستحق لونًا ثابتًا خاصًا به لا الافتراضي: ثلاثة حسابات بلا
 * صور تعني ثلاث خلفيات متطابقة، فيضيع الإحساس بأن الخلفية تتبع الحساب.
 */
export function paletteFromName(name) {
  let hash = 0;
  for (const char of String(name ?? '')) hash = (hash * 31 + char.codePointAt(0)) % 360;
  // نطاق بنفسجي–أزرق فقط: هوية VANTARA لا تتحول إلى قوس قزح
  const hue = (250 + (hash % 70)) / 360;
  return {
    primary: hslToHex(hue, 0.42, PRIMARY_LIGHTNESS),
    secondary: hslToHex(hue - 0.05, 0.36, SECONDARY_LIGHTNESS),
    base: '#050506',
    accent: hslToHex(hue, 0.66, 0.62),
    achromatic: false,
  };
}
