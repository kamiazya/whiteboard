//! The part of a canvas a `#fragment` names, as a canvas of its own
//! (`selectCanvasFragment` in `canvas-fragment.ts`).
//!
//! Two spellings, resolved readable-first and durable-second (ADR-0019): a
//! bare fragment is a GROUP's label, the counterpart of a markdown heading,
//! and `^` followed by a node id is the durable form. An exact label wins over
//! a case-insensitive one; among equals the first in document order.

use std::collections::BTreeSet;

use whiteboard_model::checks::is_js_space;
use whiteboard_model::frames::members_of;
use whiteboard_model::node_content::{frame_label, is_frame};
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};

/// The canvas narrowed to the node `fragment` names: a group with every node
/// its box holds, any other node alone. An edge comes along only when both of
/// its ends do; the lines and everything else the canvas carries are kept as
/// they are. `None` when the fragment is blank or names nothing.
#[must_use]
pub fn select_canvas_fragment(canvas: &SpatialCanvas, fragment: &str) -> Option<SpatialCanvas> {
    let wanted = fragment.trim_matches(is_js_space);
    if wanted.is_empty() {
        return None;
    }
    let root = match wanted.strip_prefix('^') {
        Some(id) => canvas.nodes.iter().find(|node| node.id == id),
        None => group_by_label(&canvas.nodes, wanted),
    }?;
    let mut ids = BTreeSet::from([root.id.as_str()]);
    if is_frame(root) {
        ids.extend(members_of(&canvas.nodes, root).map(|member| member.id.as_str()));
    }
    let mut part = canvas.clone();
    part.nodes.retain(|node| ids.contains(node.id.as_str()));
    part.edges.retain(|edge| {
        ids.contains(edge.from.node.as_str()) && ids.contains(edge.to.node.as_str())
    });
    Some(part)
}

/// The first group labelled exactly `label` once trimmed, else the first
/// labelled it ignoring case.
fn group_by_label<'n>(nodes: &'n [SpatialNode], label: &str) -> Option<&'n SpatialNode> {
    let labelled: Vec<(&SpatialNode, &str)> = nodes
        .iter()
        .filter_map(|node| Some((node, frame_label(node)?.trim_matches(is_js_space))))
        .collect();
    let folded = label.to_lowercase();
    labelled
        .iter()
        .find(|(_, own)| *own == label)
        .or_else(|| labelled.iter().find(|(_, own)| own.to_lowercase() == folded))
        .map(|(node, _)| *node)
}

#[cfg(test)]
mod tests {
    use whiteboard_model::spatial::{
        CanvasEdge, EdgeEnd, NodeResource, SpatialCanvas, SpatialNode,
    };

    use super::select_canvas_fragment;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn group(id: &str, x: f64, label: &str) -> SpatialNode {
        let label = Some(label.to_owned());
        SpatialNode {
            id: id.to_owned(),
            x,
            width: 100.0,
            height: 100.0,
            label,
            ..SpatialNode::default()
        }
    }

    fn card(id: &str, x: f64) -> SpatialNode {
        let resource =
            Some(NodeResource { content: Some(id.to_owned()), ..NodeResource::default() });
        SpatialNode {
            id: id.to_owned(),
            x,
            y: 10.0,
            width: 10.0,
            height: 10.0,
            resource,
            ..SpatialNode::default()
        }
    }

    fn edge(id: &str, from: &str, to: &str) -> CanvasEdge {
        let end = |node: &str| EdgeEnd { node: node.to_owned(), ..EdgeEnd::default() };
        CanvasEdge { id: id.to_owned(), from: end(from), to: end(to), ..CanvasEdge::default() }
    }

    fn board() -> SpatialCanvas {
        SpatialCanvas {
            nodes: vec![
                group("lower", 0.0, "plan"),
                card("a", 10.0),
                group("exact", 200.0, "Plan"),
                card("b", 210.0),
            ],
            edges: vec![edge("ab", "a", "b"), edge("aa", "a", "a")],
            ..SpatialCanvas::default()
        }
    }

    fn ids(part: Option<SpatialCanvas>) -> Option<(Vec<String>, Vec<String>)> {
        part.map(|c| {
            (
                c.nodes.into_iter().map(|n| n.id).collect(),
                c.edges.into_iter().map(|e| e.id).collect(),
            )
        })
    }

    #[test]
    fn an_exact_label_wins_over_an_earlier_case_insensitive_one() {
        let want = Some((vec!["exact".to_owned(), "b".to_owned()], vec![]));
        assert_eq!(ids(select_canvas_fragment(&board(), " Plan ")), want);
        let lower = Some((vec!["lower".to_owned(), "a".to_owned()], vec!["aa".to_owned()]));
        assert_eq!(ids(select_canvas_fragment(&board(), "PLAN")), lower);
    }

    #[test]
    fn a_durable_id_selects_a_card_alone_and_blank_names_nothing() {
        let want = Some((vec!["a".to_owned()], vec!["aa".to_owned()]));
        assert_eq!(ids(select_canvas_fragment(&board(), "^a")), want);
        assert_eq!(select_canvas_fragment(&board(), "^nope"), None);
        assert_eq!(select_canvas_fragment(&board(), " \u{feff}"), None);
        assert_eq!(select_canvas_fragment(&board(), "a"), None);
    }
}
