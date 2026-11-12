//! The markdown typesetter, ported from `layout/nodes/mdast-blocks.ts` and its
//! neighbours (ADR-0054 step 7): a model mdast tree laid out as scene
//! nodes, held to the recorded `typeset.jsonl` (`tests/typeset_oracle.rs`).
//!
//! What is here is the inline layer, the blocks made of it (a paragraph, a
//! heading) and the blocks with no children of their own (a rule, raw html, a
//! definition, display math, a fence). Everything a host knows and this crate does not (shortcodes,
//! document titles, a picture's source) is asked through [`InlineSeams`].

mod blocks;
mod code;
mod furniture;
mod options;
mod phrasing;
mod seams;
mod segments;
mod text;
mod wrap;

pub use blocks::{Unsupported, typeset_mdast_blocks};
pub use options::TypesetOptions;
pub use seams::{
    CodeToken, CodeTokenLines, CodeTokenizer, DiagramRenderer, IconRange, ImageRef, InlineSeams,
    MathRenderer, Rendered, SyntaxFills, TokenRole,
};
