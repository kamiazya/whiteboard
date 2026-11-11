//! The scene vocabulary: what a laid-out spatial document IS, as types.
//!
//! `packages/scene` ported. The scene stays inside the core (owner decision
//! q53), so nothing here is a published contract and no shipped build can
//! read or write one as JSON; the `oracle` feature derives `Deserialize` so a
//! test can replay the scenes the TypeScript recorded.
//!
//! Types only, as the package is. The closure-taking half of
//! `contribution.ts` (`ShapeContribution`, `NodeDecoration`,
//! `RenderContribution`) is deferred to the slice that ports a renderer
//! plugin contribution: its Rust shape is a trait over data the plugin
//! crate owns, and writing it before a second caller exists would guess.
//! `NodeOutline`, `ScenePoint` and `DecorationContext` are its data and are
//! here.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression, never a blanket
// allow. Test builds are exempt; clippy's non-test pass still checks every
// line of production code.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

mod appearance;
mod contribution;
mod graph;
mod legend;

pub use appearance::{Appearance, BoundingBox, Glow, SceneInk, SceneInkFill, SceneInkStyle};
pub use contribution::{DecorationContext, NodeOutline, ScenePoint};
pub use graph::{
    Annotates, AnnotatesKind, BlockquoteNode, CodeBlockNode, EdgeEnd, EdgeJumpPoint,
    EmbedPlaceholderNode, EmbedReason, EmbedResolvedNode, GlyphSceneNode, GroupSceneNode,
    HeadingBlockNode, IconSceneNode, ImageFit, ImageSceneNode, LinkProvenance, ListBlockNode,
    ListItemNode, ParagraphBlockNode, ProposalChrome, RawHtmlNode, ResolvedEdgeNode, RunPaint,
    Scene, SceneNode, ShapeSceneNode, SvgFragmentNode, SvgFragmentRole, TableBlockNode,
    TableCellSceneNode, TableRowSceneNode, TaskBox, TextRunNode, ThematicBreakNode,
    UnresolvedReferenceNode,
};
pub use legend::{LegendEntry, LegendKey, LegendKind, LegendSwatch, SceneLegend, Uncarried};
