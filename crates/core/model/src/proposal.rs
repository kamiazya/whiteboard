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
use crate::{Map, Value};

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

/// A number agrees the way a removal's prior compares it (`sameValue`, by
/// JSON): `0` and `-0` are one position.
fn same_number(current: f64, prior: Option<f64>) -> bool {
    prior == Some(current)
}

/// Whether two values agree the way `sameValue` compares them: a mapping's
/// keys in any order, since the order is how a writer built it rather than
/// what it holds, and a sequence's items in order. A number agrees with `-0`
/// as `0`, which `f64`'s equality already says.
fn same_value(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Map(left), Value::Map(right)) => same_map(left, right),
        (Value::Seq(left), Value::Seq(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| same_value(a, b))
        }
        _ => left == right,
    }
}

/// Two mappings with the same keys holding agreeing values. A mapping's keys
/// are unique (the reader keeps the last of a repeated one), so the same
/// count plus every left key found on the right is the same key set.
fn same_map(left: &Map, right: &Map) -> bool {
    left.len() == right.len()
        && left.iter().all(|(key, value)| {
            right.iter().any(|(other, held)| other == key && same_value(value, held))
        })
}

fn same_facets(left: Option<&ExtensionFacets>, right: Option<&ExtensionFacets>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => same_map(left, right),
        (left, right) => left.is_none() && right.is_none(),
    }
}

/// A removal's prior against the element held: every field equal, the facets
/// bucket by [`same_map`] rather than in written order.
fn same_element<T: Clone + PartialEq>(
    held: &T,
    prior: &T,
    facets: fn(&mut T) -> &mut Option<ExtensionFacets>,
) -> bool {
    let (mut held, mut prior) = (held.clone(), prior.clone());
    let (held_facets, prior_facets) = (facets(&mut held).take(), facets(&mut prior).take());
    same_facets(held_facets.as_ref(), prior_facets.as_ref()) && held == prior
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

/// An element's patchable fields as it stands: it always has both ends.
struct Held<'a, End> {
    from: &'a End,
    to: &'a End,
    color: Option<&'a CanvasColor>,
    label: Option<&'a str>,
    bends: Option<&'a Bends>,
    facets: Option<&'a ExtensionFacets>,
}

/// Whether any field an element patch SETS no longer holds what the prior
/// said (`differsFromPrior`). By value: a prior read from the record never
/// shares an object with the board, so an end, a bend list or a facet bucket
/// agrees when its content does.
fn element_patch_differs<End: PartialEq>(
    held: &Held<'_, End>,
    patch: &ElementPatchFields<End>,
    prior: &ElementPatchFields<End>,
) -> bool {
    patch.from.is_some() && prior.from.as_ref() != Some(held.from)
        || patch.to.is_some() && prior.to.as_ref() != Some(held.to)
        || patch.color.is_some() && prior.color.as_ref() != held.color
        || patch.label.is_some() && prior.label.as_deref() != held.label
        || patch.bends.is_some() && prior.bends.as_ref() != held.bends
        || patch.facets.is_some() && !same_facets(prior.facets.as_ref(), held.facets)
}

fn edge_patch_differs(
    edge: &CanvasEdge,
    patch: &ElementPatchFields<EdgeEnd>,
    prior: &ElementPatchFields<EdgeEnd>,
) -> bool {
    let held = Held {
        from: &edge.from,
        to: &edge.to,
        color: edge.color.as_ref(),
        label: edge.label.as_deref(),
        bends: edge.bends.as_ref(),
        facets: edge.facets.as_ref(),
    };
    element_patch_differs(&held, patch, prior)
}

fn line_patch_differs(
    line: &CanvasLine,
    patch: &ElementPatchFields<LineEnd>,
    prior: &ElementPatchFields<LineEnd>,
) -> bool {
    let held = Held {
        from: &line.from,
        to: &line.to,
        color: line.color.as_ref(),
        label: line.label.as_deref(),
        bends: line.bends.as_ref(),
        facets: line.facets.as_ref(),
    };
    element_patch_differs(&held, patch, prior)
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
        SpatialChange::NodeRemove { node_id, assumed } => {
            node(node_id).is_none_or(|held| !same_element(held, assumed, |node| &mut node.facets))
        }
        SpatialChange::EdgeRemove { edge_id, assumed } => {
            edge(edge_id).is_none_or(|held| !same_element(held, assumed, |edge| &mut edge.facets))
        }
        SpatialChange::LineRemove { line_id, assumed } => {
            line(line_id).is_none_or(|held| !same_element(held, assumed, |line| &mut line.facets))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spatial::{CanvasPoint, EdgeSide, LineEndNode};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn untouched<End>() -> ElementPatchFields<End> {
        ElementPatchFields {
            from: None,
            to: None,
            color: None,
            label: None,
            bends: None,
            facets: None,
        }
    }

    fn edge() -> CanvasEdge {
        CanvasEdge {
            id: "e".into(),
            from: EdgeEnd { node: "a".into(), side: Some(EdgeSide::Right), end: None },
            to: EdgeEnd { node: "b".into(), ..EdgeEnd::default() },
            bends: Some(vec![CanvasPoint { x: 5.0, y: 6.0 }]),
            facets: Some(vec![("visual.edges/v0".into(), Value::String("curved".into()))]),
            ..CanvasEdge::default()
        }
    }

    fn board(edge: CanvasEdge, line: CanvasLine) -> SpatialCanvas {
        SpatialCanvas { edges: vec![edge], lines: Some(vec![line]), ..SpatialCanvas::default() }
    }

    fn line() -> CanvasLine {
        CanvasLine {
            id: "l".into(),
            to: LineEnd::LineEndNode(LineEndNode { node: "a".into(), ..LineEndNode::default() }),
            bends: Some(vec![CanvasPoint { x: 1.0, y: 2.0 }]),
            facets: Some(vec![("visual.stroke/v0".into(), Value::Null)]),
            ..CanvasLine::default()
        }
    }

    /// Every field an element patch can set, its prior copied from what is
    /// held: the copy is a different object and the same value.
    fn copied<End: Clone>(
        from: &End,
        to: &End,
        bends: Option<&Bends>,
        facets: Option<&ExtensionFacets>,
    ) -> [ElementPatchFields<End>; 4] {
        [
            ElementPatchFields { from: Some(from.clone()), ..untouched() },
            ElementPatchFields { to: Some(to.clone()), ..untouched() },
            ElementPatchFields { bends: bends.cloned(), ..untouched() },
            ElementPatchFields { facets: facets.cloned(), ..untouched() },
        ]
    }

    #[test]
    fn an_edge_patch_whose_prior_copies_the_held_value_fits() {
        let held = edge();
        let canvas = board(held.clone(), line());
        for prior in copied(&held.from, &held.to, held.bends.as_ref(), held.facets.as_ref()) {
            let change = SpatialChange::EdgePatch {
                edge_id: "e".into(),
                patch: prior.clone(),
                assumed: prior.clone(),
            };
            assert!(!canvas_change_conflicts(&change, &canvas), "{prior:?}");
            let stale = SpatialChange::EdgePatch {
                edge_id: "e".into(),
                patch: prior,
                assumed: untouched(),
            };
            assert!(canvas_change_conflicts(&stale, &canvas));
        }
    }

    #[test]
    fn a_line_patch_whose_prior_copies_the_held_value_fits() {
        let held = line();
        let canvas = board(edge(), held.clone());
        for prior in copied(&held.from, &held.to, held.bends.as_ref(), held.facets.as_ref()) {
            let change = SpatialChange::LinePatch {
                line_id: "l".into(),
                patch: prior.clone(),
                assumed: prior.clone(),
            };
            assert!(!canvas_change_conflicts(&change, &canvas), "{prior:?}");
            let stale = SpatialChange::LinePatch {
                line_id: "l".into(),
                patch: prior,
                assumed: untouched(),
            };
            assert!(canvas_change_conflicts(&stale, &canvas));
        }
    }

    fn map(entries: &[(&str, Value)]) -> Value {
        Value::Map(entries.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect())
    }

    /// Two buckets holding the same values, listed in different orders at the
    /// top level and inside.
    fn buckets(inner_b: f64) -> (ExtensionFacets, ExtensionFacets) {
        let held = vec![
            ("visual.edges/v0".to_owned(), map(&[("style", Value::String("curved".into()))])),
            ("x.y/v0".to_owned(), map(&[("b", Value::Number(1.0)), ("a", Value::Number(2.0))])),
        ];
        let reordered = vec![
            ("x.y/v0".to_owned(), map(&[("a", Value::Number(2.0)), ("b", Value::Number(inner_b))])),
            ("visual.edges/v0".to_owned(), map(&[("style", Value::String("curved".into()))])),
        ];
        (held, reordered)
    }

    #[test]
    fn a_prior_whose_keys_are_in_another_order_still_fits() {
        let (held_facets, reordered) = buckets(1.0);
        let held = CanvasEdge { facets: Some(held_facets.clone()), ..edge() };
        let canvas = board(held.clone(), line());
        let prior = ElementPatchFields {
            from: Some(held.from.clone()),
            facets: Some(reordered.clone()),
            ..untouched()
        };
        let patch =
            SpatialChange::EdgePatch { edge_id: "e".into(), patch: prior.clone(), assumed: prior };
        assert!(!canvas_change_conflicts(&patch, &canvas));
        let removal = SpatialChange::EdgeRemove {
            edge_id: "e".into(),
            assumed: CanvasEdge { facets: Some(reordered.clone()), ..held.clone() },
        };
        assert!(!canvas_change_conflicts(&removal, &canvas));
        let inked = SpatialCanvas {
            lines: Some(vec![CanvasLine { facets: Some(held_facets.clone()), ..line() }]),
            nodes: vec![SpatialNode {
                id: "n".into(),
                facets: Some(held_facets),
                ..SpatialNode::default()
            }],
            ..canvas.clone()
        };
        let line_removal = SpatialChange::LineRemove {
            line_id: "l".into(),
            assumed: CanvasLine { facets: Some(reordered.clone()), ..line() },
        };
        assert!(!canvas_change_conflicts(&line_removal, &inked));
        let node_removal = SpatialChange::NodeRemove {
            node_id: "n".into(),
            assumed: SpatialNode {
                id: "n".into(),
                facets: Some(reordered),
                ..SpatialNode::default()
            },
        };
        assert!(!canvas_change_conflicts(&node_removal, &inked));
    }

    #[test]
    fn a_prior_whose_facet_value_moved_still_conflicts() {
        let (held_facets, moved) = buckets(3.0);
        let held = CanvasEdge { facets: Some(held_facets.clone()), ..edge() };
        let canvas = SpatialCanvas {
            lines: Some(vec![CanvasLine { facets: Some(held_facets.clone()), ..line() }]),
            nodes: vec![SpatialNode {
                id: "n".into(),
                facets: Some(held_facets),
                ..SpatialNode::default()
            }],
            ..board(held.clone(), line())
        };
        let prior = ElementPatchFields { facets: Some(moved.clone()), ..untouched() };
        let patch =
            SpatialChange::EdgePatch { edge_id: "e".into(), patch: prior.clone(), assumed: prior };
        assert!(canvas_change_conflicts(&patch, &canvas));
        let line_prior = ElementPatchFields { facets: Some(moved.clone()), ..untouched() };
        let line_patch = SpatialChange::LinePatch {
            line_id: "l".into(),
            patch: line_prior.clone(),
            assumed: line_prior,
        };
        assert!(canvas_change_conflicts(&line_patch, &canvas));
        let removals = [
            SpatialChange::EdgeRemove {
                edge_id: "e".into(),
                assumed: CanvasEdge { facets: Some(moved.clone()), ..held },
            },
            SpatialChange::LineRemove {
                line_id: "l".into(),
                assumed: CanvasLine { facets: Some(moved.clone()), ..line() },
            },
            SpatialChange::NodeRemove {
                node_id: "n".into(),
                assumed: SpatialNode {
                    id: "n".into(),
                    facets: Some(moved),
                    ..SpatialNode::default()
                },
            },
        ];
        for removal in removals {
            assert!(canvas_change_conflicts(&removal, &canvas), "{removal:?}");
        }
    }

    #[test]
    fn values_agree_by_content_and_not_by_key_order() {
        let n = Value::Number;
        let ab = map(&[("a", n(1.0)), ("b", n(2.0))]);
        let ba = map(&[("b", n(2.0)), ("a", n(1.0))]);
        assert!(same_value(&ab, &ba));
        assert!(same_value(&Value::Seq(vec![ab.clone()]), &Value::Seq(vec![ba.clone()])));
        assert!(!same_value(&Value::Seq(vec![ab.clone()]), &Value::Seq(vec![ab.clone(), ba])));
        assert!(!same_value(&Value::Seq(vec![n(1.0), n(2.0)]), &Value::Seq(vec![n(2.0), n(1.0)])));
        assert!(!same_value(&ab, &map(&[("a", n(1.0))])));
        assert!(!same_value(&map(&[("a", n(1.0))]), &ab));
        assert!(!same_value(&ab, &map(&[("a", n(1.0)), ("c", n(2.0))])));
        assert!(same_value(&n(-0.0), &n(0.0)));
        assert!(!same_value(&n(1.0), &Value::String("1".into())));
    }

    #[test]
    fn absent_facets_agree_only_with_absent_facets() {
        let some = vec![("x.y/v0".to_owned(), Value::Null)];
        assert!(same_facets(None, None));
        assert!(!same_facets(Some(&some), None));
        assert!(!same_facets(None, Some(&some)));
        assert!(!same_facets(Some(&some), Some(&Vec::new())));
    }

    #[test]
    fn a_removal_whose_element_moved_beside_agreeing_facets_conflicts() {
        let (held_facets, reordered) = buckets(1.0);
        let held = CanvasEdge { facets: Some(held_facets), ..edge() };
        let canvas = board(held.clone(), line());
        let relabelled = SpatialChange::EdgeRemove {
            edge_id: "e".into(),
            assumed: CanvasEdge { facets: Some(reordered), label: Some("x".into()), ..held },
        };
        assert!(canvas_change_conflicts(&relabelled, &canvas));
    }

    #[test]
    fn a_prior_of_zero_fits_a_node_at_negative_zero() {
        let node = SpatialNode {
            id: "n".into(),
            x: -0.0,
            width: 1.0,
            height: 1.0,
            ..SpatialNode::default()
        };
        let canvas = SpatialCanvas { nodes: vec![node], ..SpatialCanvas::default() };
        let change = SpatialChange::NodePatch {
            node_id: "n".into(),
            patch: NodePatchFields { x: Some(4.0), ..NodePatchFields::default() },
            assumed: NodePatchFields { x: Some(0.0), ..NodePatchFields::default() },
        };
        assert!(!canvas_change_conflicts(&change, &canvas));
    }
}
