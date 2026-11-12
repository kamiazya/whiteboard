//! What the examples share: a host with whatever answers a test gives it, and
//! the helpers that lay blocks out with the fake measurer.

use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::theme::markdown::MarkdownTheme;
use whiteboard_canvas_render::typeset::{
    IconRange, ImageRef, InlineSeams, TypesetOptions, Unsupported, typeset_mdast_blocks,
};
use whiteboard_model::mdast::{Flow, Phrasing, Root};
use whiteboard_scene::Scene;

/// A host with whatever answers a test gives it; by default it knows nothing.
#[derive(Default)]
pub(crate) struct Host {
    pub(crate) icons: Vec<IconRange>,
    /// `(from, to)`: every `from` in a text is read as `to`.
    pub(crate) emoji: Option<(&'static str, &'static str)>,
    pub(crate) title: Option<&'static str>,
    pub(crate) embed: Option<&'static str>,
    pub(crate) pending: bool,
    pub(crate) image: Option<ImageRef>,
}

impl InlineSeams for Host {
    fn expand_emoji(&self, text: &str) -> String {
        self.emoji.map_or_else(|| text.to_owned(), |(from, to)| text.replace(from, to))
    }
    fn icon_ranges(&self, _: &str) -> Vec<IconRange> {
        self.icons.clone()
    }
    fn document_title(&self, _: &str) -> Option<String> {
        self.title.map(str::to_owned)
    }
    fn embed_name(&self, _: &str) -> Option<String> {
        self.embed.map(str::to_owned)
    }
    fn embed_pending(&self, _: &str) -> bool {
        self.pending
    }
    fn image_reference(&self, _: &str) -> Option<ImageRef> {
        self.image.clone()
    }
}

/// Bit equality, so a last-bit difference is a failure and no float is compared with `==`.
pub(crate) fn same(got: f64, want: f64) {
    assert_eq!(got.to_bits(), want.to_bits(), "{got} against {want}");
}

pub(crate) const LINE: f64 = 16.0 * 1.55;

pub(crate) fn text(value: &str) -> Phrasing {
    Phrasing::Text { value: value.to_owned() }
}

pub(crate) fn laid(width: f64, blocks: Vec<Flow>) -> Result<Scene, Unsupported> {
    laid_by(&Host::default(), width, blocks)
}

pub(crate) fn laid_by(host: &Host, width: f64, blocks: Vec<Flow>) -> Result<Scene, Unsupported> {
    laid_with(&MarkdownTheme::node(), host, width, blocks)
}

pub(crate) fn laid_with(
    theme: &MarkdownTheme,
    host: &Host,
    width: f64,
    blocks: Vec<Flow>,
) -> Result<Scene, Unsupported> {
    let measure = FakeMeasure::default();
    let options = TypesetOptions::new(&measure, width, "sans-serif", theme, host);
    typeset_mdast_blocks(&Root { children: blocks }, &options)
}

pub(crate) fn paragraph(children: Vec<Phrasing>) -> Flow {
    Flow::Paragraph { children }
}
