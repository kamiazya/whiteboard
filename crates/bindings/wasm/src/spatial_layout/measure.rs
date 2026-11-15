//! The measurer a request names. Each repeats the host's arithmetic exactly:
//! the fake measurer and the ratio estimate read no face, and the font-table
//! measurer sums each code point's own advance, as the Node measurer does.

use whiteboard_canvas_render::constant_ratio::ConstantRatioMeasure;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::font_measure::FontTableMeasurer;
use whiteboard_canvas_render::measure::{FontStyle, Measure};

use super::request::MeasureSpec;

/// The measurer `spec` names over `fonts`; `None` when a face is not where it
/// says or does not parse.
pub(super) fn measurer<'f>(spec: &MeasureSpec, fonts: &'f [u8]) -> Option<Box<dyn Measure + 'f>> {
    Some(match spec {
        MeasureSpec::Fake(factor) => Box::new(FakeMeasure::new(*factor)),
        MeasureSpec::Ratio => Box::new(ConstantRatioMeasure),
        MeasureSpec::Fonts(faces) => {
            let mut measurer = FontTableMeasurer::new();
            for face in faces {
                let style = if face.italic { FontStyle::Italic } else { FontStyle::Normal };
                let bytes = fonts.get(face.from..face.to)?;
                measurer = measurer.with_face(&face.family, face.bold, style, bytes).ok()?;
            }
            Box::new(measurer)
        }
    })
}
