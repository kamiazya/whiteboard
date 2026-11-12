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
mod embed;
mod furniture;
mod list;
mod options;
mod phrasing;
mod seams;
mod section;
mod segments;
mod table;
mod task_checkbox;
mod text;
mod wrap;

pub use blocks::typeset_mdast_blocks;
pub use options::TypesetOptions;
pub use seams::{
    CanvasMiniature, CanvasSummary, CodeToken, CodeTokenLines, CodeTokenizer, DiagramRenderer,
    EmbedBox, EmbedResolver, Embedded, IconRange, ImageRef, InlineSeams, MathRenderer, Miniature,
    NestedLayoutBudget, Rendered, SyntaxFills, TokenRole,
};
pub use section::select_markdown_section;
