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

/// The 1-based start line of each top-level block of `text`, in document
/// order, index-aligned with [`parse_markdown_body`]'s root children
/// (`parseMarkdownBlockLines`). Source positions never enter the model; this
/// is the one place they surface, for a consumer that correlates source lines
/// with laid-out blocks (the preview's scroll sync). A block the parser gave no
/// position takes its index order; a text past the parser's bounds is one
/// block at line 1, as the layout draws it.
#[must_use]
pub fn parse_markdown_block_lines(text: &str) -> Vec<usize> {
    let Ok(tree) = whiteboard_markdown::parse(text) else {
        return vec![1];
    };
    let blocks = tree.children().map(Vec::as_slice).unwrap_or_default();
    blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            block.position().map_or_else(|| index.saturating_add(1), |p| p.start.line)
        })
        .collect()
}
