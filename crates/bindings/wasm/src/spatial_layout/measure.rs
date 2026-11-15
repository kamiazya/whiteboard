//! The measurer a request names. Each repeats the host's arithmetic exactly:
//! the fake measurer and the ratio estimate read no face, the font-table
//! measurer sums each code point's own advance, as the Node measurer does,
//! and the host's measurer is the host's.

use whiteboard_canvas_render::constant_ratio::ConstantRatioMeasure;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::Measure;

use super::fonts::held;
use super::host_measure::{Host, HostMeasure};
use super::request::MeasureSpec;

/// Why a request's measurer cannot measure.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Unmeasured {
    /// It names a handle no registration holds.
    FontHandle,
    /// It names the host's measurer and none was handed over, or the host
    /// did not answer every text the layout asked about.
    Host,
}

/// `then` over the measurer `spec` names.
pub(super) fn with_measurer<R>(
    spec: &MeasureSpec,
    host: Option<&dyn Host>,
    then: impl FnOnce(&dyn Measure) -> R,
) -> Result<R, Unmeasured> {
    match spec {
        MeasureSpec::Fake(factor) => Ok(then(&FakeMeasure::new(*factor))),
        MeasureSpec::Ratio => Ok(then(&ConstantRatioMeasure)),
        MeasureSpec::Fonts(handle) => {
            let fonts = held();
            let measurer = fonts.measurer(*handle).ok_or(Unmeasured::FontHandle)?;
            Ok(then(&measurer))
        }
        MeasureSpec::Host => {
            let measurer = HostMeasure::new(host.ok_or(Unmeasured::Host)?);
            let answer = then(&measurer);
            if measurer.failed() { Err(Unmeasured::Host) } else { Ok(answer) }
        }
    }
}
