//! What the typesetter asks its host, because the host is where the answer is.
//!
//! Emoji and icon shortcodes, document titles, embed names and a picture's
//! source live in the plugin and in the keeper, neither of which is in this
//! crate. A host that knows none of them answers `None`, an empty list or the
//! text unchanged, and the layout degrades as the TypeScript does with an
//! absent seam: labels fall back to the id, a picture to its alt text.
//!
//! The TypeScript guards a THROWING seam to "no answer"; a Rust host cannot
//! throw, so it answers `None` itself.

/// One icon shortcode a run of text holds: the UTF-16 range of the colon pair
/// (as the host's JavaScript answers it) and the icon it draws. A range that is
/// reversed, past the text, or not on a code point boundary names no icon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconRange {
    pub from: usize,
    pub to: usize,
    pub name: String,
}

/// A renderable picture. `width` and `height` are its natural size in px when
/// the host has decoded it.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageRef {
    pub href: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

pub trait InlineSeams {
    /// `expandEmojiShortcodes`: `:rocket:` read as its character.
    fn expand_emoji(&self, text: &str) -> String;

    /// `iconShortcodeRanges`: every `:icon-name:` the text resolves, in order.
    fn icon_ranges(&self, text: &str) -> Vec<IconRange>;

    /// The current name of a linked document (`resolveTitle`).
    fn document_title(&self, document_id: &str) -> Option<String>;

    /// The name the loaded document carries (`resolveEmbed(id)?.title`).
    fn embed_name(&self, document_id: &str) -> Option<String>;

    /// An embed target asked for and not yet answered (`isEmbedPending`).
    fn embed_pending(&self, document_id: &str) -> bool;

    /// What `resolveReference(url)?.image` answers.
    fn image_reference(&self, url: &str) -> Option<ImageRef>;
}

/// The token roles a highlighter names: roles, not colours, so the palette
/// stays with the one appearance producer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenRole {
    Keyword,
    String,
    Number,
    Comment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeToken {
    pub text: String,
    pub role: Option<TokenRole>,
}

/// One list of tokens per SOURCE line.
pub type CodeTokenLines = Vec<Vec<CodeToken>>;

/// Tokenises a fenced block (`highlightCode`). Its work budget is the host's:
/// a host that has spent it answers `None`, and so does one that does not know
/// the language, fails, or has nothing to say.
pub trait CodeTokenizer {
    fn tokenize(&self, lang: &str, value: &str) -> Option<CodeTokenLines>;
}

/// What a math or diagram renderer answers: markup alone, or markup with the
/// size it knows.
#[derive(Debug, Clone, PartialEq)]
pub enum Rendered {
    Markup(String),
    Fragment { svg: String, width: Option<f64>, height: Option<f64> },
}

/// Renders display math (`renderMath`); `None` for a renderer that has no
/// answer or failed, which the layout draws as the source.
pub trait MathRenderer {
    fn render_math(&self, value: &str) -> Option<Rendered>;
}

/// Renders a fence as a diagram (`renderDiagram`); `None` keeps the code block.
pub trait DiagramRenderer {
    fn render_diagram(&self, lang: &str, value: &str) -> Option<Rendered>;
}

/// The fill of each token role.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyntaxFills {
    pub keyword: Option<String>,
    pub string: Option<String>,
    pub number: Option<String>,
    pub comment: Option<String>,
}

impl SyntaxFills {
    #[must_use]
    pub fn fill(&self, role: TokenRole) -> Option<&str> {
        let fill = match role {
            TokenRole::Keyword => &self.keyword,
            TokenRole::String => &self.string,
            TokenRole::Number => &self.number,
            TokenRole::Comment => &self.comment,
        };
        fill.as_deref()
    }
}

/// What a fragment keeps of a canvas target: how many elements it holds (the
/// nested-layout budget is charged by that), and whether it holds none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanvasSummary {
    pub elements: usize,
    pub empty: bool,
}

/// What an embed target resolves to: a markdown document's parsed body, or a
/// canvas, which the host summarises because laying one out is the composer's.
#[derive(Debug, Clone, PartialEq)]
pub enum Embedded {
    Document {
        title: Option<String>,
        root: whiteboard_model::mdast::Root,
    },
    /// `canvas` is `None` when the fragment names nothing in the canvas.
    Canvas {
        title: Option<String>,
        canvas: Option<CanvasSummary>,
    },
}

impl Embedded {
    #[must_use]
    pub fn title(&self) -> Option<&str> {
        match self {
            Self::Document { title, .. } | Self::Canvas { title, .. } => title.as_deref(),
        }
    }
}

/// Resolves an embed target (`resolveEmbed`). Its presence is what makes a
/// paragraph that is only an embed a block; `None` is a target not loaded.
pub trait EmbedResolver {
    fn resolve_embed(&self, document_id: &str, fragment: Option<&str>) -> Option<Embedded>;
}

/// The box a canvas picture may occupy, in the body's own coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EmbedBox {
    pub x: f64,
    pub y: f64,
    pub max_width: f64,
    pub max_height: f64,
}

/// A canvas picture already placed in its box; `w` and `h` are the extent used.
#[derive(Debug, Clone, PartialEq)]
pub struct Miniature {
    pub nodes: Vec<whiteboard_scene::SceneNode>,
    pub w: f64,
    pub h: f64,
}

/// Draws a canvas target into its box (`layoutEmbeddedCanvas`). Absent, a canvas
/// embed is unresolvable; answering `None` keeps the framed title alone.
/// `path` is the recursion path INCLUDING the canvas being drawn.
pub trait CanvasMiniature {
    fn miniature(
        &self,
        document_id: &str,
        fragment: Option<&str>,
        space: &EmbedBox,
        path: &[String],
    ) -> Option<Miniature>;
}

/// The nested-layout account an embed spends from, shared by every embed of one
/// render: a count of layouts and a count of canvas elements.
#[derive(Debug)]
pub struct NestedLayoutBudget {
    layouts: std::cell::Cell<usize>,
    elements: std::cell::Cell<usize>,
}

impl NestedLayoutBudget {
    /// Layouts one render may nest.
    pub const LAYOUTS: usize = 128;
    /// Canvas elements one render may nest: a full canvas's nodes, and its
    /// edges and lines.
    pub const ELEMENTS: usize = 4000;

    #[must_use]
    pub fn new() -> Self {
        Self {
            layouts: std::cell::Cell::new(Self::LAYOUTS),
            elements: std::cell::Cell::new(Self::ELEMENTS),
        }
    }

    /// Spends one layout and `elements`; false, spending nothing, once either is out.
    pub(super) fn spend(&self, elements: usize) -> bool {
        if self.layouts.get() == 0 || elements > self.elements.get() {
            return false;
        }
        self.layouts.set(self.layouts.get().saturating_sub(1));
        self.elements.set(self.elements.get().saturating_sub(elements));
        true
    }
}

impl Default for NestedLayoutBudget {
    fn default() -> Self {
        Self::new()
    }
}
