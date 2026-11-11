//! The deterministic measurer for tests, ported from
//! `createFakeMeasure` (`test-utils/fake-measure.ts`).
//!
//! Its arithmetic is the TypeScript's in the TypeScript's order, so every
//! double is bit-identical: advance is `((len * factor) * size)` where `len` is
//! the UTF-16 length, and the vertical metrics are fixed ratios of the size.
//! `tests/fake_measure_oracle.rs` holds it to `fake-measure.jsonl`.
//!
//! Not ported: `createFixedMeasure`, whose function-valued advance has no use
//! until a ported test asks for it. A lone surrogate, which a JS string can
//! hold, is not representable in a `&str`.

use crate::measure::{FontDescriptor, Measure, VerticalMetrics};

/// The TypeScript's default `charWidthFactor`.
pub const DEFAULT_CHAR_WIDTH_FACTOR: f64 = 0.6;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FakeMeasure {
    char_width_factor: f64,
}

impl FakeMeasure {
    #[must_use]
    pub const fn new(char_width_factor: f64) -> Self {
        Self { char_width_factor }
    }
}

impl Default for FakeMeasure {
    fn default() -> Self {
        Self::new(DEFAULT_CHAR_WIDTH_FACTOR)
    }
}

/// `String.prototype.length`: UTF-16 code units, so an astral code point is two.
#[must_use]
pub fn utf16_len(text: &str) -> f64 {
    #[expect(clippy::cast_precision_loss, reason = "a string under 2^53 units is exact")]
    let len = text.encode_utf16().count() as f64;
    len
}

impl Measure for FakeMeasure {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        utf16_len(text) * self.char_width_factor * font.size_px
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        VerticalMetrics {
            ascent: font.size_px * 0.8,
            descent: font.size_px * 0.2,
            line_gap: font.size_px * 0.1,
        }
    }
}
