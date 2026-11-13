//! The scene vocabulary: what a laid-out spatial document IS, as types.
//!
//! `packages/scene` ported. The scene stays inside the core (owner decision
//! q53), so nothing here is a published contract and no shipped build can
//! read or write one as JSON; the `oracle` feature derives `Deserialize` so a
//! test can replay the scenes the TypeScript recorded.
//!
//! Types, as the package is, and one trait: [`NodeDecoration`], what a
//! plugin's decoration implements (`contribution.ts`'s `NodeDecoration`), so
//! the renderer iterates contributions rather than naming a plugin. The rest of
//! `contribution.ts`'s closure-taking half (`ShapeContribution`,
//! `RenderContribution`) waits for a second caller; `NodeOutline`, `ScenePoint`
//! and `DecorationContext` are its data and are here.

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
pub use contribution::{DecorationContext, NodeDecoration, NodeOutline, ScenePoint};
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
