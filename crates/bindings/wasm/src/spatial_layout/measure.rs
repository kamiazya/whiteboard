//! The measurer a request names. Each repeats the host's arithmetic exactly:
//! the fake measurer and the ratio estimate read no face, and the font-table
//! measurer sums each code point's own advance, as the Node measurer does.

use whiteboard_canvas_render::constant_ratio::ConstantRatioMeasure;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::Measure;

use super::fonts::held;
use super::request::MeasureSpec;

/// `then` over the measurer `spec` names; `None` when it names a handle no
/// registration holds.
pub(super) fn with_measurer<R>(
    spec: &MeasureSpec,
    then: impl FnOnce(&dyn Measure) -> R,
) -> Option<R> {
    match spec {
        MeasureSpec::Fake(factor) => Some(then(&FakeMeasure::new(*factor))),
        MeasureSpec::Ratio => Some(then(&ConstantRatioMeasure)),
        MeasureSpec::Fonts(handle) => {
            let fonts = held();
            let measurer = fonts.measurer(*handle)?;
            Some(then(&measurer))
        }
    }
}
