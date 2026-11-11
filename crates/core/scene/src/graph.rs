//! The closed `SceneNode` union and everything it is built from.
//!
//! Scene nodes keep their semantic provenance (heading level, list structure,
//! link targets) as fields rather than flattening it to paint, because a
//! reader that is not looking at pixels recovers the document from them.

use crate::appearance::{Appearance, BoundingBox, SceneInk};
use crate::contribution::ScenePoint;
use crate::legend::SceneLegend;
use whiteboard_model::spatial::EdgeSide;

#[cfg(feature = "oracle")]
mod wire {
    use super::{ListItemNode, TableCellSceneNode, TableRowSceneNode, TextRunNode};
    use serde::Deserialize;
    use serde::de::{Deserializer, Error};
    use whiteboard_model::spatial::EdgeSide;

    pub(super) fn side<'de, D: Deserializer<'de>>(deserializer: D) -> Result<EdgeSide, D::Error> {
        let wire = String::deserialize(deserializer)?;
        EdgeSide::from_wire(&wire).ok_or_else(|| D::Error::custom("not an edge side"))
    }

    // A run, item, row and cell are structs held in a list that the TypeScript
    // tags with their `kind`, which a struct cannot be tagged with; each list is
    // read through a one-variant tagged enum, so the tag is checked and the
    // struct still refuses a field it does not know.
    macro_rules! tagged_list {
        ($read:ident, $wire:ident, $tag:literal, $ty:ty) => {
            #[derive(Deserialize)]
            #[serde(tag = "kind")]
            enum $wire {
                #[serde(rename = $tag)]
                Only($ty),
            }

            pub(super) fn $read<'de, D: Deserializer<'de>>(
                deserializer: D,
            ) -> Result<Vec<$ty>, D::Error> {
                let tagged = Vec::<$wire>::deserialize(deserializer)?;
                Ok(tagged.into_iter().map(|$wire::Only(inner)| inner).collect())
            }
        };
    }

    tagged_list!(runs, RunWire, "textRun", TextRunNode);
    tagged_list!(items, ItemWire, "listItem", ListItemNode);
    tagged_list!(rows, RowWire, "tableRow", TableRowSceneNode);
    tagged_list!(cells, CellWire, "tableCell", TableCellSceneNode);

    pub(super) fn optional_runs<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Vec<TextRunNode>>, D::Error> {
        #[derive(Deserialize)]
        #[serde(transparent)]
        struct Runs(#[serde(deserialize_with = "runs")] Vec<TextRunNode>);
        Ok(Option::<Runs>::deserialize(deserializer)?.map(|Runs(runs)| runs))
    }
}

/// A single styled run of inline text, positioned within its parent block.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(deny_unknown_fields, rename_all = "camelCase")
)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the six presence-only flags are the scene vocabulary's own fields, one per `?: true` in the TypeScript"
)]
pub struct TextRunNode {
    pub bbox: BoundingBox,
    pub text: String,
    #[cfg_attr(feature = "oracle", serde(default))]
    pub emphasis: bool,
    #[cfg_attr(feature = "oracle", serde(default))]
    pub strong: bool,
    #[cfg_attr(feature = "oracle", serde(default))]
    pub code: bool,
    #[cfg_attr(feature = "oracle", serde(default))]
    pub deleted: bool,
    /// Present when the run is, or is inside, a link.
    pub link: Option<LinkProvenance>,
    /// The text was cut to fit; the backend fades the trailing edge.
    #[cfg_attr(feature = "oracle", serde(default))]
    pub truncated: bool,
    /// The run's text is wider than the width it was fitted to and nothing narrower exists.
    #[cfg_attr(feature = "oracle", serde(default))]
    pub overflows: bool,
    pub appearance: Option<Appearance>,
    /// Paint this instead of the run's glyphs, in the run's own box.
    pub paints: Option<RunPaint>,
    /// A filled box painted behind the run, inset from `bbox` by `backdrop_pad_x_px`.
    pub backdrop: Option<Appearance>,
    pub backdrop_pad_x_px: Option<f64>,
    /// The canvas element this run is the label of.
    pub annotates: Option<Annotates>,
    /// Distance from `bbox.y` down to the text baseline.
    pub baseline: Option<f64>,
}

/// What a run paints in place of its glyphs. An icon is named, not carried,
/// so a deployment's own icon set is followed.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(deny_unknown_fields, tag = "kind", rename_all = "camelCase")
)]
pub enum RunPaint {
    Image { src: String },
    Icon { name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(rename_all = "camelCase"))]
pub enum AnnotatesKind {
    Edge,
    Node,
}

/// The canvas element a label annotates.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct Annotates {
    pub kind: AnnotatesKind,
    pub id: String,
}

/// Semantic provenance for an inline link-like run.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(
        deny_unknown_fields,
        tag = "kind",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )
)]
pub enum LinkProvenance {
    Link { href: String, title: Option<String> },
    WikiLink { document_id: String, alias: Option<String>, fragment: Option<String> },
    Embed { document_id: String, fragment: Option<String> },
}

/// The proposal layer's chrome marker, carrying the proposal it belongs to.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(deny_unknown_fields, rename_all = "camelCase")
)]
pub struct ProposalChrome {
    pub proposal_id: String,
}

/// A task item's checkbox, in the given state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct TaskBox {
    pub checked: bool,
}

/// The box chrome of a canvas node.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(deny_unknown_fields, rename_all = "camelCase")
)]
pub struct ShapeSceneNode {
    /// The content had to be cut to fit this box.
    #[cfg_attr(feature = "oracle", serde(default))]
    pub truncated: bool,
    #[cfg_attr(feature = "oracle", serde(default))]
    pub overflows: bool,
    /// The document node this chrome belongs to, when the scene was built from one.
    pub id: Option<String>,
    pub bbox: BoundingBox,
    /// This shape is comment-layer chrome, never a document node.
    #[cfg_attr(feature = "oracle", serde(default))]
    pub comment_chrome: bool,
    pub proposal_chrome: Option<ProposalChrome>,
    /// Uniform corner radius of the rect form.
    pub radius: Option<f64>,
    /// A namespaced silhouette id (`visual.diamond`); absent is the rect.
    pub shape: Option<String>,
    pub appearance: Option<Appearance>,
    pub task_box: Option<TaskBox>,
    pub ink: Option<SceneInk>,
}

/// A vendored-icon glyph drawn at `bbox`.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct IconSceneNode {
    pub bbox: BoundingBox,
    pub icon: String,
    pub appearance: Option<Appearance>,
}

/// A character badge drawn as one centred text glyph sized to `bbox`.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct GlyphSceneNode {
    pub bbox: BoundingBox,
    pub glyph: String,
}

/// A block-level heading; `level` is the semantic depth, 1 to 6.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct HeadingBlockNode {
    pub bbox: BoundingBox,
    pub level: u8,
    #[cfg_attr(feature = "oracle", serde(deserialize_with = "wire::runs"))]
    pub runs: Vec<TextRunNode>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct ParagraphBlockNode {
    pub bbox: BoundingBox,
    #[cfg_attr(feature = "oracle", serde(deserialize_with = "wire::runs"))]
    pub runs: Vec<TextRunNode>,
}

/// One item within a list; keeps its ordinal and nesting.

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct ListItemNode {
    pub bbox: BoundingBox,
    /// 1-based when the parent list is ordered.
    pub ordinal: Option<f64>,
    pub checked: Option<bool>,
    pub children: Vec<SceneNode>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct ListBlockNode {
    pub bbox: BoundingBox,
    pub ordered: bool,
    /// Nesting depth from the document root; top-level lists are 0.
    pub depth: f64,
    #[cfg_attr(feature = "oracle", serde(deserialize_with = "wire::items"))]
    pub items: Vec<ListItemNode>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct CodeBlockNode {
    pub bbox: BoundingBox,
    /// The fence's source, verbatim.
    pub value: String,
    pub lang: Option<String>,
    /// One run per source line, already positioned.
    #[cfg_attr(feature = "oracle", serde(default, deserialize_with = "wire::optional_runs"))]
    pub runs: Option<Vec<TextRunNode>>,
    /// The panel painted behind `runs`.
    pub appearance: Option<Appearance>,
    pub radius: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct BlockquoteNode {
    pub bbox: BoundingBox,
    /// The quoted blocks, preceded by the accent bar as a shape.
    pub children: Vec<SceneNode>,
    pub appearance: Option<Appearance>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct ThematicBreakNode {
    pub bbox: BoundingBox,
    pub appearance: Option<Appearance>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct TableCellSceneNode {
    pub bbox: BoundingBox,
    #[cfg_attr(feature = "oracle", serde(deserialize_with = "wire::runs"))]
    pub runs: Vec<TextRunNode>,
    pub appearance: Option<Appearance>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct TableRowSceneNode {
    pub bbox: BoundingBox,
    #[cfg_attr(feature = "oracle", serde(deserialize_with = "wire::cells"))]
    pub cells: Vec<TableCellSceneNode>,
    /// True for the header row, whose cells are laid out bold.
    pub header: Option<bool>,
    /// The hairline along the row's bottom edge.
    pub appearance: Option<Appearance>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct TableBlockNode {
    pub bbox: BoundingBox,
    #[cfg_attr(feature = "oracle", serde(deserialize_with = "wire::rows"))]
    pub rows: Vec<TableRowSceneNode>,
}

/// Raw HTML passed through verbatim.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct RawHtmlNode {
    pub bbox: BoundingBox,
    pub value: String,
}

/// An unresolved link or image reference.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct UnresolvedReferenceNode {
    pub bbox: BoundingBox,
    pub identifier: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(rename_all = "camelCase"))]
pub enum SvgFragmentRole {
    Presentation,
}

/// The math and diagram seam: an already well-formed SVG fragment, emitted
/// verbatim. Its well-formedness is the supplier's precondition.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct SvgFragmentNode {
    pub bbox: BoundingBox,
    pub svg: String,
    pub role: Option<SvgFragmentRole>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(rename_all = "camelCase"))]
pub enum EmbedReason {
    Cycle,
    DepthCap,
    Budget,
    Unresolvable,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(deny_unknown_fields, rename_all = "camelCase")
)]
pub struct EmbedPlaceholderNode {
    pub bbox: BoundingBox,
    pub document_id: String,
    pub title: String,
    pub reason: EmbedReason,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(deny_unknown_fields, rename_all = "camelCase")
)]
pub struct EmbedResolvedNode {
    pub bbox: BoundingBox,
    pub document_id: String,
    pub children: Vec<SceneNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(rename_all = "camelCase"))]
pub enum ImageFit {
    Contain,
    Cover,
}

/// A raster or vector image; `href` is emitted verbatim. The box is the
/// frame, not necessarily the painted extent.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct ImageSceneNode {
    pub bbox: BoundingBox,
    pub href: String,
    pub alt: Option<String>,
    pub fit: Option<ImageFit>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct GroupSceneNode {
    pub bbox: BoundingBox,
    pub label: Option<String>,
    pub children: Vec<SceneNode>,
}

/// A point where an edge hops over an earlier edge, on path segment `segment`.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct EdgeJumpPoint {
    pub segment: f64,
    pub x: f64,
    pub y: f64,
}

/// Whether an end of an edge carries an arrowhead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(rename_all = "camelCase"))]
pub enum EdgeEnd {
    None,
    Arrow,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(deny_unknown_fields, rename_all = "camelCase")
)]
pub struct ResolvedEdgeNode {
    pub id: String,
    /// Line-jump hops, present only when the canvas enables them.
    pub jumps: Option<Vec<EdgeJumpPoint>>,
    pub path: Vec<ScenePoint>,
    #[cfg_attr(feature = "oracle", serde(deserialize_with = "wire::side"))]
    pub from_side: EdgeSide,
    #[cfg_attr(feature = "oracle", serde(deserialize_with = "wire::side"))]
    pub to_side: EdgeSide,
    /// Always resolved by the producer, so no constructor can forget which
    /// ends carry an arrowhead.
    pub from_end: EdgeEnd,
    pub to_end: EdgeEnd,
    /// Draw the corners of `path` rounded: a hint, the path stays the geometry.
    #[cfg_attr(feature = "oracle", serde(default))]
    pub rounded: bool,
    pub ink: Option<SceneInk>,
    /// This edge is comment-layer chrome, never a document edge.
    #[cfg_attr(feature = "oracle", serde(default))]
    pub comment_chrome: bool,
    pub appearance: Option<Appearance>,
}

/// One laid-out thing, in paint order.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    feature = "oracle",
    derive(serde::Deserialize),
    serde(tag = "kind", rename_all = "camelCase")
)]
pub enum SceneNode {
    Heading(HeadingBlockNode),
    Paragraph(ParagraphBlockNode),
    List(ListBlockNode),
    CodeBlock(CodeBlockNode),
    Blockquote(BlockquoteNode),
    ThematicBreak(ThematicBreakNode),
    Table(TableBlockNode),
    RawHtml(RawHtmlNode),
    UnresolvedReference(UnresolvedReferenceNode),
    SvgFragment(SvgFragmentNode),
    EmbedPlaceholder(EmbedPlaceholderNode),
    EmbedResolved(EmbedResolvedNode),
    Group(GroupSceneNode),
    TextRun(Box<TextRunNode>),
    Edge(Box<ResolvedEdgeNode>),
    Shape(Box<ShapeSceneNode>),
    Image(ImageSceneNode),
    Icon(IconSceneNode),
    Glyph(GlyphSceneNode),
}

/// A fully laid-out document: ordered top-level nodes in paint order.
#[derive(Debug, Clone, PartialEq, Default)]
#[cfg_attr(feature = "oracle", derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct Scene {
    pub nodes: Vec<SceneNode>,
    /// Present only when the board has something to say about its colour.
    pub legend: Option<SceneLegend>,
}
