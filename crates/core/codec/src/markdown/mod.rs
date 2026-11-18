//! A markdown body read into the model tree a layout reads:
//! `whiteboard-markdown`'s `CommonMark`, GFM and math parse, then the
//! conversion to `whiteboard_model::mdast`. It is the only implementation: the
//! TypeScript parser it was ported from is gone, and its recorded answers
//! (`packages/codec/src/markdown/oracle`) are what this is held to.
//!
//! The `[[…]]`/`![[…]]` syntax is not parsed here: it stays in the text nodes,
//! and [`crate::references`] reads it from them in a separate pass.

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

/// [`parse_markdown_body`]'s tree with the 1-based start line of each of its
/// top-level blocks, from the ONE parse: index-aligned
/// with the root's children. Source positions never enter the model; this is the
/// one place they surface, for a consumer that correlates source lines with
/// laid-out blocks (the preview's scroll sync). A block the parser gave no
/// position takes its index order.
///
/// # Errors
///
/// As [`parse_markdown_body`].
pub fn parse_markdown_body_with_lines(text: &str) -> Result<(Root, Vec<usize>), Refusal> {
    let tree = whiteboard_markdown::parse(text)?;
    let blocks = tree.children().map(Vec::as_slice).unwrap_or_default();
    let lines = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            block.position().map_or_else(|| index.saturating_add(1), |p| p.start.line)
        })
        .collect();
    Ok((convert::root(&tree), lines))
}

/// The start lines of `text`'s top-level blocks, as
/// [`parse_markdown_body_with_lines`] answers them; a text past the parser's
/// bounds is one block at line 1, as the layout draws it.
#[must_use]
pub fn parse_markdown_block_lines(text: &str) -> Vec<usize> {
    parse_markdown_body_with_lines(text).map_or_else(|_| vec![1], |(_, lines)| lines)
}

mod excerpt;

pub use excerpt::markdown_excerpt;
