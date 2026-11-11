//! The measurer of last resort, ported from `constantRatioMeasureText` and
//! `isFullWidthCodePoint` (`packages/canvas-render/src/measure.ts`).
//!
//! It answers a deterministic estimate when no font is reachable, and it is the
//! per-code-point fallback of [`FontTableMeasurer`](crate::font_measure::FontTableMeasurer)
//! for a glyph its face lacks. Its output matches no real font; what matters is
//! that every caller degrades in ONE way. `tests/constant_ratio_oracle.rs` holds
//! it to the TypeScript's recorded answers bit for bit.

use crate::measure::{FontDescriptor, Measure, VerticalMetrics, clamp_advance};

/// What a Latin-ish glyph costs, in em.
const RATIO_ADVANCE: f64 = 0.55;
const RATIO_ASCENT: f64 = 0.75;
const RATIO_DESCENT: f64 = 0.25;
const RATIO_LINE_GAP: f64 = 0.1;

/// Whether a code point occupies a full em rather than the ~half a Latin letter
/// takes: the fullwidth and CJK blocks. The ranges are the TypeScript's, in its
/// order.
#[must_use]
pub const fn is_full_width_code_point(code_point: u32) -> bool {
    matches!(
        code_point,
        0x1100..=0x115f // Hangul Jamo
        | 0x3000..=0x303f // CJK symbols and punctuation
        | 0x3040..=0x30ff // hiragana and katakana
        | 0x3400..=0x4dbf // CJK extension A
        | 0x4e00..=0x9fff // CJK unified ideographs
        | 0xac00..=0xd7a3 // Hangul syllables
        | 0xf900..=0xfaff // CJK compatibility ideographs
        | 0xff00..=0xff60 // fullwidth forms
        | 0x1f300..=0x1faff // emoji
    )
}

/// The advance of `text` at `size_px`: a full em for a wide code point, 0.55 em
/// for any other, summed in em and scaled once, as the TypeScript does.
#[must_use]
pub fn estimate_advance(text: &str, size_px: f64) -> f64 {
    let size = clamp_advance(size_px);
    let mut em = 0.0_f64;
    for ch in text.chars() {
        em += if is_full_width_code_point(u32::from(ch)) { 1.0 } else { RATIO_ADVANCE };
    }
    clamp_advance(em * size)
}

/// The vertical half: fixed ratios of the clamped size.
#[must_use]
pub fn estimate_vertical(size_px: f64) -> VerticalMetrics {
    let size = clamp_advance(size_px);
    VerticalMetrics {
        ascent: size * RATIO_ASCENT,
        descent: size * RATIO_DESCENT,
        line_gap: size * RATIO_LINE_GAP,
    }
}

/// `constantRatioMeasureText` as a [`Measure`].
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ConstantRatioMeasure;

impl Measure for ConstantRatioMeasure {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        estimate_advance(text, font.size_px)
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        estimate_vertical(font.size_px)
    }
}
