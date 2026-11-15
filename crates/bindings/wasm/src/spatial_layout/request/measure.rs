//! The measurer a request names: the fake measurer at its factor, the ratio
//! estimate, the font-table measurer over faces registered beforehand
//! ([`super::super::fonts`]), named by the handle registering them answered,
//! or the host's own measurer, handed to the call beside the request.

use whiteboard_model::Value;

use super::flag_of;
use crate::json_canvas_wire::{Fields, number_of, string_of};

/// One face of a font-table measurer: where its bytes sit in the bytes
/// registered with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Face {
    pub(crate) family: String,
    pub(crate) bold: bool,
    pub(crate) italic: bool,
    pub(crate) from: usize,
    pub(crate) to: usize,
}

/// The measurer the host's own `measure` is, named as data.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MeasureSpec {
    /// `createFakeMeasure(factor)`.
    Fake(f64),
    /// `constantRatioMeasureText`, the estimate with no font.
    Ratio,
    /// The Node measurer over the faces registered under this handle.
    Fonts(u32),
    /// The host's measurer, asked mid-layout ([`super::super::host_measure`]).
    Host,
}

/// A whole number that indexes the registered bytes: a fraction, a sign, an
/// exponent or a non-finite number spells no index, so its text does not parse.
fn offset_of(value: &Value) -> Option<usize> {
    format!("{}", number_of(value)?).parse().ok()
}

/// A surface id, or a font handle: a whole number a `u32` holds.
pub(super) fn surface_of(value: &Value) -> Option<u32> {
    u32::try_from(offset_of(value)?).ok()
}

pub(crate) fn face_of(value: &Value) -> Option<Face> {
    let mut f = Fields::of(value)?;
    let face = Face {
        family: f.field("family", string_of)??,
        bold: f.field("bold", flag_of)??,
        italic: f.field("italic", flag_of)??,
        from: f.field("from", offset_of)??,
        to: f.field("to", offset_of)??,
    };
    f.all_named().then_some(face)
}

pub(super) fn measure_of(value: &Value) -> Option<MeasureSpec> {
    let mut f = Fields::of(value)?;
    let spec = match f.field("kind", string_of)??.as_str() {
        "fake" => MeasureSpec::Fake(f.field("factor", number_of)??),
        "ratio" => MeasureSpec::Ratio,
        "host" => MeasureSpec::Host,
        "fonts" => MeasureSpec::Fonts(f.field("handle", surface_of)??),
        _ => return None,
    };
    f.all_named().then_some(spec)
}
