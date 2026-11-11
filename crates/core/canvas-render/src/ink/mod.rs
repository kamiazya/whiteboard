//! How a style inks chrome other than crisp (ADR-0030 decision 7): pure
//! functions from semantic geometry to the strokes a hand would draw.

mod sketch;
mod sketch_shape;

pub use sketch::{SketchEdgeOptions, sketch_edge};
pub use sketch_shape::{SketchInk, sketch_shape};

/// How far (px) sketch ink may leave the semantic geometry it draws.
pub const SKETCH_INK_REACH_PX: f64 = 8.0;
/// Outline and edge passes: the strokes a consumer sees first are these, in order.
pub const SKETCH_PASSES: usize = 2;
