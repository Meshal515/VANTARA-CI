"""اختبارات الراسم العربي.

الاختبار الحاسم ليس «هل رُسم شيء» بل «هل يختلف RAQM عن BASIC» — لأن التشابه
يعني أن التشكيل والـbidi لا يعملان، وهو العطل الصامت الذي يُنتج صفحات معكوسة.
"""

from __future__ import annotations

import pytest
from PIL import Image, ImageDraw, ImageFont

from vantara_worker.arabic import (
    FontSet,
    Region,
    assert_raqm,
    fit,
    is_mixed,
    measure,
    raqm_available,
    render_page,
    render_region,
    script_of,
    split_runs,
    wrap,
)

ARABIC_FONT = "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf"
LATIN_FONT = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"

pytestmark = pytest.mark.skipif(not raqm_available(), reason="needs libraqm")


@pytest.fixture
def fonts() -> FontSet:
    return FontSet(arabic=ARABIC_FONT, latin=LATIN_FONT)


@pytest.fixture
def arabic_only() -> FontSet:
    return FontSet(arabic=ARABIC_FONT)


def test_raqm_is_present_and_versioned() -> None:
    assert assert_raqm()


def test_shaping_actually_changes_the_layout() -> None:
    """RAQM أضيق من BASIC. لو تساويا فالتشكيل لا يعمل."""
    text = "تحذير! تحذير!"
    basic = ImageFont.truetype(ARABIC_FONT, 32, layout_engine=ImageFont.Layout.BASIC)
    raqm = ImageFont.truetype(ARABIC_FONT, 32, layout_engine=ImageFont.Layout.RAQM)
    draw = ImageDraw.Draw(Image.new("L", (1, 1)))

    basic_width = draw.textlength(text, font=basic)
    raqm_width = draw.textlength(text, font=raqm)

    assert raqm_width < basic_width
    # القياس في الـspike: 158.6 مقابل 201.0 ⇒ ~21%
    assert 0.10 < (basic_width - raqm_width) / basic_width < 0.40


def test_rtl_direction_requires_raqm() -> None:
    """`direction="rtl"` يرمي على BASIC — وهذا نصف سبب اشتراط raqm."""
    basic = ImageFont.truetype(ARABIC_FONT, 24, layout_engine=ImageFont.Layout.BASIC)
    draw = ImageDraw.Draw(Image.new("RGB", (200, 60), "white"))
    with pytest.raises(KeyError):
        draw.text((10, 10), "تحذير", font=basic, direction="rtl", language="ar")


class TestRuns:
    def test_classifies_scripts(self) -> None:
        assert script_of("ت") == "arabic"
        assert script_of("A") == "latin"
        assert script_of("1") == "neutral"
        assert script_of(" ") == "neutral"

    def test_pure_arabic_is_one_run(self) -> None:
        runs = split_runs("كشف جسم طائر")
        assert len(runs) == 1
        assert runs[0].script == "arabic"

    def test_digits_do_not_split_a_run(self) -> None:
        # «الفصل 184» مقطع واحد، لا ثلاثة
        runs = split_runs("الفصل 184")
        assert len(runs) == 1

    def test_mixed_text_splits(self) -> None:
        runs = split_runs("الفصل Nano Machine هنا")
        assert [run.script for run in runs] == ["arabic", "latin", "arabic"]

    def test_detects_mixed(self) -> None:
        assert is_mixed("اسم Sung Jin-Woo")
        assert not is_mixed("سونغ جين وو")
        assert not is_mixed("")

    def test_empty_text_has_no_runs(self) -> None:
        assert split_runs("") == []


class TestMeasuring:
    def test_mixed_measurement_uses_both_fonts(self, fonts: FontSet) -> None:
        text = "اسم Sung Jin-Woo"
        both = measure(text, fonts, 24)
        arabic_only = measure(text, FontSet(arabic=ARABIC_FONT), 24)
        # خط واحد لنص مختلط يعطي رقمًا مختلفًا ⇒ القياس بمقطع-مقطع ضروري
        assert both != arabic_only

    def test_longer_text_measures_wider(self, fonts: FontSet) -> None:
        assert measure("جسم طائر", fonts, 24) < measure("جسم طائر على بعد كيلومترين", fonts, 24)


class TestWrap:
    def test_wraps_to_width(self, fonts: FontSet) -> None:
        lines = wrap("من أنت؟ ولماذا تتبعني منذ البارحة؟", fonts, 28, 200)
        assert len(lines) > 1
        for line in lines:
            assert measure(line, fonts, 28) <= 200 or " " not in line

    def test_does_not_break_a_word(self, fonts: FontSet) -> None:
        # قطع الكلمة العربية يفصل حروفها الموصولة، فالتجاوز أهون
        lines = wrap("استثنائية", fonts, 48, 10)
        assert lines == ["استثنائية"]

    def test_empty_text_wraps_to_nothing(self, fonts: FontSet) -> None:
        assert wrap("   ", fonts, 24, 100) == []


class TestFit:
    def test_picks_the_largest_readable_size(self, fonts: FontSet) -> None:
        small = fit("تحذير!", (120, 40), fonts)
        large = fit("تحذير!", (600, 300), fonts)
        assert large.size > small.size
        assert not large.overflow

    def test_real_bubble_lines_all_fit(self, fonts: FontSet) -> None:
        # النصوص من صفحة حقيقية: Nano Machine فصل 1، Azora
        samples = [
            "تحذير! تحذير!",
            "كشف جسم طائر على بعد 2 كم.",
            "جسم طائر...؟",
            "من أنت؟ ولماذا تتبعني منذ البارحة؟",
        ]
        for text in samples:
            fitted = fit(text, (420, 130), fonts)
            assert fitted.lines, text
            assert not fitted.overflow, text
            assert fitted.total_height <= 130

    def test_flags_overflow_instead_of_shrinking_past_legibility(self, fonts: FontSet) -> None:
        fitted = fit("نص طويل جدًا " * 40, (80, 40), fonts)
        assert fitted.overflow
        assert fitted.size >= 10
        assert any("does not fit" in w for w in fitted.warnings)

    def test_warns_when_mixed_text_has_no_latin_font(self, arabic_only: FontSet) -> None:
        fitted = fit("اسم Sung Jin-Woo", (400, 120), arabic_only)
        assert any("latin" in w for w in fitted.warnings)

    def test_no_warning_for_pure_arabic_without_latin_font(self, arabic_only: FontSet) -> None:
        assert fit("جسم طائر", (400, 120), arabic_only).warnings == []


class TestRender:
    def test_draws_ink_inside_the_region(self, fonts: FontSet) -> None:
        image = Image.new("RGB", (500, 200), "white")
        region = Region(x=40, y=30, width=420, height=130, text="كشف جسم طائر على بعد 2 كم.")
        fitted = render_region(image, region, fonts)

        assert fitted.lines
        crop = image.crop((region.x, region.y, region.x + region.width, region.y + region.height))
        assert crop.convert("L").getextrema()[0] < 128, "no dark pixels — nothing was drawn"

    def test_leaves_the_area_outside_the_region_untouched(self, fonts: FontSet) -> None:
        image = Image.new("RGB", (500, 300), "white")
        render_region(image, Region(50, 50, 200, 80, "تحذير!"), fonts)
        # شريط أسفل المنطقة يجب أن يبقى أبيض
        outside = image.crop((0, 200, 500, 300)).convert("L")
        assert outside.getextrema() == (255, 255)

    def test_page_report_counts_and_flags_review(self, fonts: FontSet) -> None:
        image = Image.new("RGB", (600, 400), "white")
        regions = [
            Region(20, 20, 260, 90, "تحذير! تحذير!"),
            Region(20, 140, 260, 90, "جسم طائر...؟"),
            Region(320, 20, 60, 30, "نص طويل لا يدخل هنا مطلقًا " * 6),
        ]
        report = render_page(image, regions, fonts)

        assert report.rendered == 3
        assert report.overflowed == 1
        assert report.needs_review

    def test_clean_page_does_not_need_review(self, fonts: FontSet) -> None:
        image = Image.new("RGB", (600, 400), "white")
        report = render_page(image, [Region(20, 20, 400, 120, "تحذير! تحذير!")], fonts)
        assert report.rendered == 1
        assert report.overflowed == 0
        assert not report.needs_review

    def test_mixed_script_region_renders_both_scripts(self, fonts: FontSet) -> None:
        image = Image.new("RGB", (600, 160), "white")
        fitted = render_region(image, Region(20, 20, 560, 120, "اسمه Sung Jin-Woo"), fonts)
        assert fitted.lines
        assert not fitted.warnings
        assert image.convert("L").getextrema()[0] < 128
