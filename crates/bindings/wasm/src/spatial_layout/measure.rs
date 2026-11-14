//! The measurer a request names, and what it cannot repeat exactly.
//!
//! The font-table measurer sums each code point's own advance, where the Node
//! measurer's opentype.js first applies the face's `GSUB` `ccmp` and `liga`
//! lookups: over the vendored Roboto the two part only where a mark follows
//! what it modifies (`font-measure.jsonl`'s `substituted` class, held within a
//! tenth of an em rather than bit for bit). A text holding a mark or a format
//! character is therefore one the core cannot measure as the host does, and
//! the layout that asks for it is declined; the fake measurer and the ratio
//! estimate read no face and repeat the host's arithmetic exactly.

use std::cell::Cell;

use whiteboard_canvas_render::constant_ratio::ConstantRatioMeasure;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::font_measure::FontTableMeasurer;
use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle, Measure, VerticalMetrics};
use whiteboard_canvas_render::segment_joins::joins_preceding;

use super::request::MeasureSpec;

/// A measurer, and whether it was asked a text it cannot answer exactly.
pub(super) struct Measurer<'f> {
    inner: Box<dyn Measure + 'f>,
    /// Whether a text holding a mark or format character is inexact here.
    by_face: bool,
    inexact: Cell<bool>,
}

impl Measurer<'_> {
    /// Whether a text it measured is one the host's measurer answers otherwise.
    pub(super) fn inexact(&self) -> bool {
        self.inexact.get()
    }
}

impl Measure for Measurer<'_> {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        if self.by_face && text.chars().any(joins_preceding) {
            self.inexact.set(true);
        }
        self.inner.advance_width(text, font)
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        self.inner.vertical_metrics(font)
    }
}

/// The measurer `spec` names over `fonts`; `None` when a face is not where it
/// says or does not parse.
pub(super) fn measurer<'f>(spec: &MeasureSpec, fonts: &'f [u8]) -> Option<Measurer<'f>> {
    let (inner, by_face): (Box<dyn Measure + 'f>, bool) = match spec {
        MeasureSpec::Fake(factor) => (Box::new(FakeMeasure::new(*factor)), false),
        MeasureSpec::Ratio => (Box::new(ConstantRatioMeasure), false),
        MeasureSpec::Fonts(faces) => {
            let mut measurer = FontTableMeasurer::new();
            for face in faces {
                let style = if face.italic { FontStyle::Italic } else { FontStyle::Normal };
                let bytes = fonts.get(face.from..face.to)?;
                measurer = measurer.with_face(&face.family, face.bold, style, bytes).ok()?;
            }
            (Box::new(measurer), true)
        }
    };
    Some(Measurer { inner, by_face, inexact: Cell::new(false) })
}
