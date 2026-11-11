//! The text-measurement seam, ported from `packages/canvas-render/src/measure.ts`.
//!
//! Layout never measures text itself: it asks a [`Measure`]. Three kinds of
//! implementer are planned (ADR-0054, "The measure-seam spike"): the native
//! [`FakeMeasure`](crate::fake_measure::FakeMeasure), a font-table measurer, and
//! a wasm-only host callback. The trait is object-safe so a layout can take a
//! `&dyn Measure` and the implementer is chosen by the root.
//!
//! The TypeScript contract answers a whole [`TextMetrics`] per `(text, font)`.
//! Here the answer is split in two, because the host callback crosses with one
//! `f64` and the vertical metrics are properties of the font in both real
//! measurers: [`Measure::advance_width`] is per text and font, and
//! [`Measure::vertical_metrics`] per font. [`Measure::measure`] puts them back
//! together for a caller that wants the TypeScript's shape. The one behaviour
//! this narrows is a measurer whose ascent varies with the text; none of the
//! TypeScript implementers but the browser's fallback path does.

/// A font's slant, which is all the TypeScript descriptor distinguishes.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum FontStyle {
    Normal,
    Italic,
}

/// What a layout asks a measurer to measure in.
#[derive(Clone, Debug, PartialEq)]
pub struct FontDescriptor {
    pub family: String,
    /// Declared here and resolved by the measurer; layout never picks a font.
    pub fallback_chain: Vec<String>,
    /// 100-900 on the CSS numeric scale. Not clamped: it is a number to the
    /// TypeScript too.
    pub weight: f64,
    pub style: FontStyle,
    /// Font size in CSS px.
    pub size_px: f64,
}

/// The per-font half of an answer, in CSS px scaled to the font's size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VerticalMetrics {
    pub ascent: f64,
    pub descent: f64,
    pub line_gap: f64,
}

/// The TypeScript's `TextMetrics`: every field in CSS px already scaled to
/// `size_px`, never in font design units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextMetrics {
    pub advance_width: f64,
    pub ascent: f64,
    pub descent: f64,
    pub line_gap: f64,
}

/// Measures text. Layout guarantees `text` holds no newline.
///
/// Every method takes `&self`: a measurer may keep a cache behind it
/// ([`MeasureMemo`](crate::measure_memo::MeasureMemo)) and a host callback has
/// no state of its own to mutate.
pub trait Measure {
    /// The advance of `text` in `font`, in CSS px. A non-finite or negative
    /// answer is a violation of the contract; layout applies [`clamp_advance`]
    /// before it reaches geometry.
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64;

    /// The ascent, descent and line gap of `font`.
    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics;

    /// Both halves, in the TypeScript's shape.
    fn measure(&self, text: &str, font: &FontDescriptor) -> TextMetrics {
        let VerticalMetrics { ascent, descent, line_gap } = self.vertical_metrics(font);
        TextMetrics { advance_width: self.advance_width(text, font), ascent, descent, line_gap }
    }
}

impl<M: Measure + ?Sized> Measure for &M {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        (**self).advance_width(text, font)
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        (**self).vertical_metrics(font)
    }
}

/// Clamps a measurer's advance to a finite, non-negative value, as
/// `clampAdvance` does: NaN, infinity and a negative all become 0 (and `-0`
/// stays `-0`, which compares `>= 0`).
#[must_use]
pub fn clamp_advance(advance_width: f64) -> f64 {
    if advance_width.is_finite() && advance_width >= 0.0 { advance_width } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    /// Bit equality, so `-0` and a NaN are told apart.
    fn same(got: f64, want: f64) {
        assert_eq!(got.to_bits(), want.to_bits(), "{got} against {want}");
    }

    #[test]
    fn a_clamped_advance_is_finite_and_not_negative() {
        same(clamp_advance(12.5), 12.5);
        same(clamp_advance(0.0), 0.0);
        same(clamp_advance(-0.5), 0.0);
        same(clamp_advance(f64::NAN), 0.0);
        same(clamp_advance(f64::INFINITY), 0.0);
        same(clamp_advance(f64::NEG_INFINITY), 0.0);
        same(clamp_advance(f64::MAX), f64::MAX);
    }

    #[test]
    fn negative_zero_survives_the_clamp_as_typescript_leaves_it() {
        same(clamp_advance(-0.0), -0.0);
    }
}
