//! Lays blocks out with the fake measurer and whatever host a test gives.

use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::theme::markdown::MarkdownTheme;
use whiteboard_canvas_render::typeset::{TypesetOptions, typeset_mdast_blocks};
use whiteboard_model::mdast::{Flow, Root};
use whiteboard_scene::Scene;

use super::examples::Host;

pub(crate) fn laid(width: f64, blocks: Vec<Flow>) -> Scene {
    laid_by(&Host::default(), width, blocks)
}

pub(crate) fn laid_by(host: &Host, width: f64, blocks: Vec<Flow>) -> Scene {
    laid_with(&MarkdownTheme::node(), host, width, blocks)
}

pub(crate) fn laid_with(
    theme: &MarkdownTheme,
    host: &Host,
    width: f64,
    blocks: Vec<Flow>,
) -> Scene {
    let measure = FakeMeasure::default();
    let options = TypesetOptions::new(&measure, width, "sans-serif", theme, host);
    typeset_mdast_blocks(&Root { children: blocks }, &options)
}
