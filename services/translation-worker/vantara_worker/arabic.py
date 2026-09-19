"""رسم النص العربي داخل بالون.

هذه الطبقة ملكنا بقرار (D-04): المحرك الجاهز يعطي `regions` وصورة منظّفة،
ونحن نرسم العربية. سبب القرار مقاس لا مفترض:

  * `Layout.BASIC` يرسم «تحذير!» كـ«اريذحت!» — الاتجاه معكوس، غير قابل للاستخدام.
  * `Layout.RAQM` (HarfBuzz + FriBidi + libraqm، داخل ويل Pillow) يرسم عربية سليمة.
  * RAQM أضيق من BASIC بـ20–23%، فأي معايرة ملء على مقاسات BASIC خاطئة.
  * Pillow لا يفعل font fallback: خط عربي يرسم اللاتيني مربعات فارغة.

راجع `spike/out/arabic-typeset-basic-vs-raqm.png` للدليل البصري.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Iterable, Literal, Sequence

from PIL import Image, ImageDraw, ImageFont, features

# ───────────────────────────── بوابة الإقلاع ─────────────────────────────

RAQM_REQUIRED_MESSAGE = (
    "libraqm غير متوفر في هذه البيئة. بدونه لا يوجد Arabic shaping ولا bidi، "
    "و`direction=\"rtl\"` يرمي KeyError، والناتج عربية معكوسة. "
    "ثبّت ويل Pillow يحمل raqm: pip install --force-reinstall --only-binary :all: Pillow"
)


def raqm_available() -> bool:
    return bool(features.check("raqm"))


def assert_raqm() -> str:
    """يرمي إن لم يكن raqm موجودًا. يُنادى عند إقلاع الـworker.

    الرفض الصريح مقصود: worker يعمل بلا raqm سينتج صفحات تبدو مكتملة ونصها
    معكوس، وهذا أسوأ من worker لا يقلع.
    """
    if not raqm_available():
        raise RuntimeError(RAQM_REQUIRED_MESSAGE)
    return str(features.version("raqm"))


# ────────────────────────────── تقسيم النص ──────────────────────────────

Script = Literal["arabic", "latin", "neutral"]

# النطاقات العربية: الأساسي، التكميلي، الممتد-A، أشكال العرض A و B
_ARABIC = re.compile(
    r"[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]"
)
_LATIN = re.compile(r"[A-Za-zÀ-ɏ]")


def script_of(char: str) -> Script:
    if _ARABIC.match(char):
        return "arabic"
    if _LATIN.match(char):
        return "latin"
    # الأرقام والمسافات والترقيم تتبع ما حولها، فلا تقطع الـrun
    return "neutral"


@dataclass(frozen=True)
class Run:
    text: str
    script: Script


def split_runs(text: str) -> list[Run]:
    """يقسّم النص إلى مقاطع عربية ولاتينية.

    المحارف المحايدة تلتحق بالمقطع الجاري بدل أن تفتح مقطعًا ثالثًا، وإلا
    تفتّت «الفصل 184» إلى ثلاثة مقاطع بلا داعٍ.
    """
    if not text:
        return []

    runs: list[Run] = []
    buffer = text[0]
    current = script_of(text[0])

    for char in text[1:]:
        script = script_of(char)
        if script == "neutral" or script == current:
            buffer += char
            continue
        if current == "neutral":
            # المقطع بدأ محايدًا، فأول محرف حقيقي يحدد هويته
            current = script
            buffer += char
            continue
        runs.append(Run(buffer, current))
        buffer = char
        current = script

    runs.append(Run(buffer, current))
    return runs


def is_mixed(text: str) -> bool:
    scripts = {run.script for run in split_runs(text)} - {"neutral"}
    return len(scripts) > 1


# ─────────────────────────────── الخطوط ────────────────────────────────


@dataclass(frozen=True)
class FontSet:
    """خط لكل نص. Pillow لا يبدّل تلقائيًا، فالتبديل مسؤوليتنا."""

    arabic: str
    latin: str | None = None

    def path_for(self, script: Script) -> str:
        if script == "latin" and self.latin is not None:
            return self.latin
        return self.arabic


@lru_cache(maxsize=256)
def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    """RAQM إلزاميًا. الـcache لأن الملء يجرّب عشرات المقاسات."""
    return ImageFont.truetype(path, size, layout_engine=ImageFont.Layout.RAQM)


# ──────────────────────────── القياس والملء ────────────────────────────

_MEASURE = ImageDraw.Draw(Image.new("L", (1, 1)))


def measure(text: str, fonts: FontSet, size: int) -> float:
    """عرض النص بالبكسل، بجمع عرض كل مقطع بخطه.

    القياس بخط واحد لنص مختلط يعطي رقمًا خاطئًا، لأن المقاييس تختلف بين الخطين.
    """
    total = 0.0
    for run in split_runs(text):
        font = load_font(fonts.path_for(run.script), size)
        total += _MEASURE.textlength(run.text, font=font)
    return total


def wrap(text: str, fonts: FontSet, size: int, max_width: float) -> list[str]:
    """التفاف بالكلمة. الكلمة الأطول من السطر تُترك وحدها ولا تُقطع.

    قطع الكلمة العربية يفصل الحروف الموصولة ويشوّه الشكل، فالتجاوز أهون.
    """
    words = text.split()
    if not words:
        return []

    lines: list[str] = []
    current = ""

    for word in words:
        candidate = f"{current} {word}".strip()
        if not current or measure(candidate, fonts, size) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word

    if current:
        lines.append(current)
    return lines


@dataclass
class Fitted:
    size: int
    lines: list[str]
    line_height: int
    total_height: int
    overflow: bool = False
    warnings: list[str] = field(default_factory=list)


def fit(
    text: str,
    box: tuple[int, int],
    fonts: FontSet,
    *,
    max_size: int = 72,
    min_size: int = 10,
    line_spacing: float = 1.25,
) -> Fitted:
    """أكبر مقاس يُدخل النص في الصندوق.

    يبدأ من الأكبر وينزل: البالون يريد أكبر نص مقروء، لا أصغره. إن لم يدخل
    عند `min_size` نُرجع `overflow=True` بدل أن نصغّر إلى ما لا يُقرأ — القرار
    حينها للمراجعة اليدوية (`NEEDS_REVIEW`)، لا للراسم.
    """
    width, height = box
    warnings: list[str] = []

    if fonts.latin is None and is_mixed(text):
        # بلا خط لاتيني سيُرسم اللاتيني مربعات فارغة، وهذا عطل صامت
        warnings.append("mixed-script text without a latin font: latin will render as tofu")

    for size in range(max_size, min_size - 1, -1):
        lines = wrap(text, fonts, size, width)
        if not lines:
            return Fitted(size, [], 0, 0, warnings=warnings)

        font = load_font(fonts.arabic, size)
        ascent, descent = font.getmetrics()
        line_height = int((ascent + descent) * line_spacing)

        widest = max(measure(line, fonts, size) for line in lines)
        if widest <= width and line_height * len(lines) <= height:
            return Fitted(size, lines, line_height, line_height * len(lines), warnings=warnings)

    lines = wrap(text, fonts, min_size, width)
    font = load_font(fonts.arabic, min_size)
    ascent, descent = font.getmetrics()
    line_height = int((ascent + descent) * line_spacing)
    warnings.append(f"text does not fit {width}x{height} even at {min_size}px")
    return Fitted(
        min_size, lines, line_height, line_height * len(lines), overflow=True, warnings=warnings
    )


# ──────────────────────────────── الرسم ────────────────────────────────


@dataclass
class Region:
    """منطقة نص من محرك الكشف، بإحداثيات الصورة الأصلية."""

    x: int
    y: int
    width: int
    height: int
    text: str


@dataclass
class RenderReport:
    rendered: int = 0
    overflowed: int = 0
    warnings: list[str] = field(default_factory=list)

    @property
    def needs_review(self) -> bool:
        return self.overflowed > 0 or bool(self.warnings)


def draw_line(
    draw: ImageDraw.ImageDraw,
    line: str,
    center_x: float,
    top: float,
    fonts: FontSet,
    size: int,
    fill: str = "black",
) -> None:
    """يرسم سطرًا واحدًا مُمركزًا.

    النص أحادي النص يُرسم بنداء واحد فيتولى RAQM الترتيب والتشكيل كاملًا.
    النص المختلط يُرسم مقطعًا مقطعًا بخطه، من اليمين إلى اليسار حتى يبقى
    ترتيب المقاطع عربيًا.
    """
    runs = split_runs(line)
    total = measure(line, fonts, size)

    if len({run.script for run in runs} - {"neutral"}) <= 1:
        script = next((run.script for run in runs if run.script != "neutral"), "arabic")
        font = load_font(fonts.path_for(script), size)
        draw.text(
            (center_x, top),
            line,
            font=font,
            fill=fill,
            anchor="ma",
            direction="rtl",
            language="ar",
        )
        return

    # يمين الصندوق هو نقطة البداية في نص عربي
    pen = center_x + total / 2
    for run in runs:
        font = load_font(fonts.path_for(run.script), size)
        run_width = _MEASURE.textlength(run.text, font=font)
        pen -= run_width
        draw.text(
            (pen, top),
            run.text,
            font=font,
            fill=fill,
            # كل مقطع بنصّه: العربي rtl والباقي ltr
            direction="rtl" if run.script == "arabic" else "ltr",
            **({"language": "ar"} if run.script == "arabic" else {}),
        )


def render_region(
    image: Image.Image,
    region: Region,
    fonts: FontSet,
    *,
    padding: int = 8,
    fill: str = "black",
    max_size: int = 72,
    min_size: int = 10,
) -> Fitted:
    """يرسم نص منطقة واحدة على الصورة، مُمركزًا أفقيًا ورأسيًا."""
    draw = ImageDraw.Draw(image)
    inner = (max(region.width - padding * 2, 1), max(region.height - padding * 2, 1))

    fitted = fit(region.text, inner, fonts, max_size=max_size, min_size=min_size)
    if not fitted.lines:
        return fitted

    top = region.y + (region.height - fitted.total_height) / 2
    center_x = region.x + region.width / 2

    for line in fitted.lines:
        draw_line(draw, line, center_x, top, fonts, fitted.size, fill=fill)
        top += fitted.line_height

    return fitted


def render_page(
    image: Image.Image,
    regions: Sequence[Region] | Iterable[Region],
    fonts: FontSet,
    **kwargs: object,
) -> RenderReport:
    """يرسم كل مناطق صفحة ويُرجع تقريرًا.

    التقرير هو ما يحدد `READY` من `NEEDS_REVIEW`: منطقة واحدة لم تدخل تكفي
    لتعليم الصفحة للمراجعة، بدل شحنها وكأنها تامة.
    """
    report = RenderReport()
    for region in regions:
        fitted = render_region(image, region, fonts, **kwargs)  # type: ignore[arg-type]
        if fitted.lines:
            report.rendered += 1
        if fitted.overflow:
            report.overflowed += 1
        report.warnings.extend(fitted.warnings)
    # التحذير نفسه يتكرر لكل منطقة؛ التقرير يحمله مرة
    report.warnings = sorted(set(report.warnings))
    return report
