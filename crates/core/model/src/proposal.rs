//! The proposal layer as the canvas reads it (`packages/model/src/proposal.ts`
//! and the conflict check of `proposal-apply.ts`, ADR-0029): a batch of
//! anchored changes, each carrying the value it assumed its anchor held, and
//! whether that anchor still holds it.
//!
//! Plain data, like [`crate::annotation`]: the zod schema is the contract, and
//! a proposal reaches this crate already read. Only what a layout reads is
//! held — the author, the timestamps and a passage change's anchor and text
//! stay with the TypeScript until something here reads them.

use crate::node_content::{
    frame_background, frame_background_style, frame_label, node_file, node_subpath, node_text,
    node_url,
};
use crate::spatial::{
    BackgroundStyle, Bends, CanvasColor, CanvasEdge, CanvasLine, EdgeEnd, ExtensionFacets, LineEnd,
    SpatialCanvas, SpatialNode,
};

/// Where one change stands (`proposedChangeStatusSchema`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChangeStatus {
    #[default]
    Open,
    Adopted,
    Dismissed,
}

/// What a `node.patch` may change (`nodePatchFieldsSchema`); a field the patch
/// sets is `Some`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NodePatchFields {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub color: Option<CanvasColor>,
    pub text: Option<String>,
    pub file: Option<String>,
    pub subpath: Option<String>,
    pub url: Option<String>,
    pub label: Option<String>,
    pub background: Option<String>,
    pub background_style: Option<BackgroundStyle>,
}

/// What an `edge.patch` or `line.patch` may change: everything the element has
/// but its identity (and an edge's tags), its ends of the element's own kind.
#[derive(Debug, Clone, PartialEq)]
pub struct ElementPatchFields<End> {
    pub from: Option<End>,
    pub to: Option<End>,
    pub color: Option<CanvasColor>,
    pub label: Option<String>,
    pub bends: Option<Bends>,
    pub facets: Option<ExtensionFacets>,
}

impl<End> Default for ElementPatchFields<End> {
    fn default() -> Self {
        Self { from: None, to: None, color: None, label: None, bends: None, facets: None }
    }
}

/// A change whose subject is the canvas (`SpatialProposedChange`), stored
/// resolved: a real id and real geometry, never a draft.
#[derive(Debug, Clone, PartialEq)]
pub enum SpatialChange {
    NodeAdd {
        node: SpatialNode,
    },
    NodePatch {
        node_id: String,
        patch: NodePatchFields,
        assumed: NodePatchFields,
    },
    /// The prior is the whole node, since a removal touches all of it.
    NodeRemove {
        node_id: String,
        assumed: SpatialNode,
    },
    EdgeAdd {
        edge: CanvasEdge,
    },
    EdgePatch {
        edge_id: String,
        patch: ElementPatchFields<EdgeEnd>,
        assumed: ElementPatchFields<EdgeEnd>,
    },
    EdgeRemove {
        edge_id: String,
        assumed: CanvasEdge,
    },
    LineAdd {
        line: CanvasLine,
    },
    LinePatch {
        line_id: String,
        patch: ElementPatchFields<LineEnd>,
        assumed: ElementPatchFields<LineEnd>,
    },
    LineRemove {
        line_id: String,
        assumed: CanvasLine,
    },
}

/// What a change does: to the canvas, or to a passage of the body, which the
/// canvas only counts.
#[derive(Debug, Clone, PartialEq)]
pub enum ChangeOp {
    Spatial(Box<SpatialChange>),
    BodyReplace,
}

/// One anchored change (`proposedChangeSchema`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProposedChange {
    pub id: String,
    pub status: ChangeStatus,
    pub op: ChangeOp,
}

/// The batch that arrived together (`proposalSchema`).
#[derive(Debug, Clone, PartialEq)]
pub struct Proposal {
    pub id: String,
    pub changes: Vec<ProposedChange>,
}

/// `Object.is` over two doubles a schema keeps finite: the same bits, so `-0`
/// is not `0`.
fn same_number(current: f64, prior: Option<f64>) -> bool {
    prior.is_some_and(|prior| prior.to_bits() == current.to_bits())
}

/// Whether any field a node patch SETS no longer holds what the prior said,
/// each read through the patch's own vocabulary (`nodePatchField`): `text` is
/// what the anchor showed, not a field it stores.
fn node_patch_differs(
    node: &SpatialNode,
    patch: &NodePatchFields,
    prior: &NodePatchFields,
) -> bool {
    let numbers = [
        (patch.x, node.x, prior.x),
        (patch.y, node.y, prior.y),
        (patch.width, node.width, prior.width),
        (patch.height, node.height, prior.height),
    ];
    let texts = [
        (&patch.text, node_text(node), &prior.text),
        (&patch.file, node_file(node), &prior.file),
        (&patch.subpath, node_subpath(node), &prior.subpath),
        (&patch.url, node_url(node), &prior.url),
        (&patch.label, frame_label(node), &prior.label),
        (&patch.background, frame_background(node), &prior.background),
    ];
    numbers.iter().any(|(set, held, said)| set.is_some() && !same_number(*held, *said))
        || texts.iter().any(|(set, held, said)| set.is_some() && *held != said.as_deref())
        || patch.color.is_some() && node.color != prior.color
        || patch.background_style.is_some()
            && frame_background_style(node) != prior.background_style
}

/// An element's patchable fields as `Object.is` compares them (`differsFromPrior`):
/// a colour or a label by value, an end, a bend list or a facet bucket by
/// IDENTITY. A prior read from the record never shares an object with the
/// canvas, so an object field agrees only when both are absent, which leaves
/// its presence the whole of what is compared.
#[derive(Clone, Copy)]
struct Compared<'a> {
    /// Whether `from`, `to`, `bends` and `facets` are present, in that order.
    objects: [bool; 4],
    color: Option<&'a CanvasColor>,
    label: Option<&'a str>,
}

impl<End> ElementPatchFields<End> {
    fn compared(&self) -> Compared<'_> {
        Compared {
            objects: [
                self.from.is_some(),
                self.to.is_some(),
                self.bends.is_some(),
                self.facets.is_some(),
            ],
            color: self.color.as_ref(),
            label: self.label.as_deref(),
        }
    }
}

/// An element as it stands: it always has both ends.
fn held<'a>(
    color: Option<&'a CanvasColor>,
    label: Option<&'a str>,
    bends: Option<&Bends>,
    facets: Option<&ExtensionFacets>,
) -> Compared<'a> {
    Compared { objects: [true, true, bends.is_some(), facets.is_some()], color, label }
}

/// Whether any field an element patch SETS no longer holds what the prior
/// said; an end, which an element always has, never agrees.
fn element_patch_differs(current: Compared<'_>, patch: Compared<'_>, prior: Compared<'_>) -> bool {
    let objects = patch.objects.iter().zip(current.objects).zip(prior.objects);
    objects.into_iter().any(|((&set, held), said)| set && (held || said))
        || patch.color.is_some() && current.color != prior.color
        || patch.label.is_some() && current.label != prior.label
}

fn edge_patch_differs(
    edge: &CanvasEdge,
    patch: &ElementPatchFields<EdgeEnd>,
    prior: &ElementPatchFields<EdgeEnd>,
) -> bool {
    let current =
        held(edge.color.as_ref(), edge.label.as_deref(), edge.bends.as_ref(), edge.facets.as_ref());
    element_patch_differs(current, patch.compared(), prior.compared())
}

fn line_patch_differs(
    line: &CanvasLine,
    patch: &ElementPatchFields<LineEnd>,
    prior: &ElementPatchFields<LineEnd>,
) -> bool {
    let current =
        held(line.color.as_ref(), line.label.as_deref(), line.bends.as_ref(), line.facets.as_ref());
    element_patch_differs(current, patch.compared(), prior.compared())
}

/// Whether the anchor still holds what the proposal assumed it held
/// (`canvasChangeConflicts`, decision 5). An edit to a field the change never
/// touches is somebody else's work, not a collision; a prior that omits a
/// field claims the anchor held nothing there. The element being gone is a
/// conflict for every arm that names one, and an addition collides only with
/// an element already holding its id. A removal's prior is the whole element,
/// so anything about it changing is a collision.
#[must_use]
pub fn canvas_change_conflicts(change: &SpatialChange, canvas: &SpatialCanvas) -> bool {
    let node = |id: &str| canvas.nodes.iter().find(|node| node.id == id);
    let edge = |id: &str| canvas.edges.iter().find(|edge| edge.id == id);
    let lines = canvas.lines.as_deref().unwrap_or_default();
    let line = |id: &str| lines.iter().find(|line| line.id == id);
    match change {
        SpatialChange::NodeAdd { node: added } => node(&added.id).is_some(),
        SpatialChange::EdgeAdd { edge: added } => edge(&added.id).is_some(),
        SpatialChange::LineAdd { line: added } => line(&added.id).is_some(),
        SpatialChange::NodePatch { node_id, patch, assumed } => {
            node(node_id).is_none_or(|held| node_patch_differs(held, patch, assumed))
        }
        SpatialChange::EdgePatch { edge_id, patch, assumed } => {
            edge(edge_id).is_none_or(|held| edge_patch_differs(held, patch, assumed))
        }
        SpatialChange::LinePatch { line_id, patch, assumed } => {
            line(line_id).is_none_or(|held| line_patch_differs(held, patch, assumed))
        }
        SpatialChange::NodeRemove { node_id, assumed } => node(node_id) != Some(assumed),
        SpatialChange::EdgeRemove { edge_id, assumed } => edge(edge_id) != Some(assumed),
        SpatialChange::LineRemove { line_id, assumed } => line(line_id) != Some(assumed),
    }
}
