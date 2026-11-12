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
