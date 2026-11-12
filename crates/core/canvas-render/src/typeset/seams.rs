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
