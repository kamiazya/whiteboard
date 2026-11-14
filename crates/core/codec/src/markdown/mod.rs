//! A markdown body read into the model tree a layout reads
//! (`packages/codec/src/markdown/pipeline.ts`'s `parseMarkdownBody`):
//! `whiteboard-markdown`'s `CommonMark`, GFM and math parse, then the
//! conversion to `whiteboard_model::mdast` (`from-remark.ts`'s
//! `fromRemarkRoot`).
//!
//! The `[[…]]`/`![[…]]` syntax is not parsed here, as it is not in the
//! TypeScript: it stays in the text nodes, and [`crate::references`] reads it
//! from them in a separate pass.

mod convert;

pub use whiteboard_markdown::Refusal;
use whiteboard_model::mdast::Root;

/// The model tree of `text`.
///
/// # Errors
///
/// A [`Refusal`] when `text` is past one of the parser's bounds
/// (`whiteboard_markdown::limits`). The TypeScript reads such a text, and a
/// caller answers it from there.
pub fn parse_markdown_body(text: &str) -> Result<Root, Refusal> {
    whiteboard_markdown::parse(text).map(|tree| convert::root(&tree))
}
