//! The digest as properties, each stated from the boxes and flags alone, with
//! integer arithmetic and a cell-by-cell raster where the port uses doubles and
//! spans, so none of the port's code states what it is judged by.

use std::cmp::Ordering;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::scene_digest::{SceneDigest, scene_digest};
use whiteboard_model::spatial::EdgeSide;
use whiteboard_proptest::proptest::prelude::{Strategy, any, prop, prop_assert, prop_assert_eq};
use whiteboard_proptest::proptest::test_runner::TestCaseError;
use whiteboard_proptest::{Floor, check};
use whiteboard_scene::{
    BoundingBox, EdgeEnd, GlyphSceneNode, ProposalChrome, ResolvedEdgeNode, Scene, SceneNode,
    ShapeSceneNode,
};

/// A box on integer coordinates, so every comparison below is exact in `i64`.
type IntBox = (i64, i64, i64, i64);

fn real(v: i64) -> f64 {
    f64::from(i32::try_from(v).unwrap_or(0))
}

fn bbox(int_box: IntBox) -> BoundingBox {
    BoundingBox { x: real(int_box.0), y: real(int_box.1), w: real(int_box.2), h: real(int_box.3) }
}

/// Coordinates that land on grid lines as often as between them, and extents
/// that are zero, one cell or arbitrary.
fn coordinate() -> impl Strategy<Value = i64> {
    prop::strategy::Union::new_weighted(vec![
        (1, (0_i64..=12).prop_map(|n| n * 20).boxed()),
        (1, (0_i64..=260).boxed()),
    ])
}

fn extent() -> impl Strategy<Value = i64> {
    prop::strategy::Union::new_weighted(vec![
        (1, prop::sample::select(vec![0_i64, 20, 40, 24, 48]).boxed()),
        (2, (0_i64..=90).boxed()),
    ])
}

fn int_box() -> impl Strategy<Value = IntBox> {
    (coordinate(), coordinate(), extent(), extent())
}

fn id_of(index: usize) -> String {
    format!("n{index:02}")
}

fn shape(id: Option<String>, b: IntBox, comment: bool, proposal: bool, flags: u8) -> SceneNode {
    SceneNode::Shape(Box::new(ShapeSceneNode {
        truncated: flags & 1 == 1,
        overflows: flags & 2 == 2,
        id,
        bbox: bbox(b),
        comment_chrome: comment,
        proposal_chrome: proposal.then(|| ProposalChrome { proposal_id: "p".into() }),
        radius: None,
        shape: None,
        appearance: None,
        task_box: None,
        ink: None,
    }))
}

fn edge() -> SceneNode {
    SceneNode::Edge(Box::new(ResolvedEdgeNode {
        id: "e".into(),
        jumps: None,
        path: vec![],
        from_side: EdgeSide::Right,
        to_side: EdgeSide::Left,
        from_end: EdgeEnd::None,
        to_end: EdgeEnd::Arrow,
        rounded: false,
        ink: None,
        comment_chrome: false,
        appearance: None,
    }))
}

fn digest_of(scene: &Scene) -> Result<SceneDigest, TestCaseError> {
    scene_digest(scene).map_err(|e| TestCaseError::fail(format!("{e:?}")))
}

fn scene(nodes: Vec<SceneNode>) -> Scene {
    Scene { nodes, legend: None }
}

type Inset = (i64, i64, i64, i64);

/// The box `inset` leaves inside `outer`, each side moved in by up to a third.
fn inside(outer: IntBox, inset: Inset) -> IntBox {
    let ninth = |extent: i64, share: i64| extent * share / 9;
    let (left, right) = (ninth(outer.2, inset.0), ninth(outer.2, inset.2));
    let (top, bottom) = (ninth(outer.3, inset.1), ninth(outer.3, inset.3));
    (outer.0 + left, outer.1 + top, outer.2 - left - right, outer.3 - top - bottom)
}

fn inset() -> impl Strategy<Value = Option<Inset>> {
    prop::option::of((0_i64..=3, 0_i64..=3, 0_i64..=3, 0_i64..=3))
}

/// A box, and often a second inside it and a third inside that (sharing a
/// border now and then), so containment, ties among parents and chains of it
/// are reached.
fn nested() -> impl Strategy<Value = Vec<IntBox>> {
    (int_box(), inset(), inset()).prop_map(|(outer, first, second)| {
        let mut boxes = vec![outer];
        if let Some(i) = first {
            boxes.push(inside(outer, i));
            if let (Some(j), Some(&mid)) = (second, boxes.last()) {
                boxes.push(inside(mid, j));
            }
        }
        boxes
    })
}

/// Boards whose every node is an addressable shape with its own id.
fn shape_board() -> impl Strategy<Value = Vec<IntBox>> {
    prop::collection::vec(nested(), 1..=8).prop_map(|groups| groups.concat())
}

fn shape_scene(boxes: &[IntBox]) -> Scene {
    scene(
        boxes.iter().enumerate().map(|(i, b)| shape(Some(id_of(i)), *b, false, false, 0)).collect(),
    )
}

fn right_bottom((x, y, w, h): IntBox) -> (i64, i64) {
    (x + w, y + h)
}

fn overlaps_by_area(a: IntBox, b: IntBox) -> bool {
    let (ar, ab) = right_bottom(a);
    let (br, bb) = right_bottom(b);
    ar.min(br) - a.0.max(b.0) > 0 && ab.min(bb) - a.1.max(b.1) > 0
}

fn strictly_inside(parent: IntBox, child: IntBox) -> bool {
    let (pr, pb) = right_bottom(parent);
    let (cr, cb) = right_bottom(child);
    child.0 >= parent.0
        && child.1 >= parent.1
        && cr <= pr
        && cb <= pb
        && parent.2 * parent.3 > child.2 * child.3
}

fn near(a: IntBox, b: IntBox) -> bool {
    let (ar, ab) = right_bottom(a);
    let (br, bb) = right_bottom(b);
    let dx = (a.0 - br).max(b.0 - ar).max(0);
    let dy = (a.1 - bb).max(b.1 - ab).max(0);
    dx * dx + dy * dy <= 24 * 24
}

#[test]
fn overlaps_are_the_pairs_sharing_area_each_listed_once_in_order() {
    let some = Floor::new("a board with an overlap");
    let none = Floor::new("a board of boxes that all touch or miss");
    check(shape_board(), None, |boxes| {
        let digest = digest_of(&shape_scene(&boxes))?;
        let mut expected: Vec<[String; 2]> = Vec::new();
        for (i, a) in boxes.iter().enumerate() {
            for (j, b) in boxes.iter().enumerate().skip(i + 1) {
                if overlaps_by_area(*a, *b) {
                    expected.push([id_of(i), id_of(j)]);
                }
            }
        }
        expected.sort();
        some.draw(!expected.is_empty());
        none.draw(expected.is_empty());
        prop_assert_eq!(digest.overlaps, expected);
        prop_assert!(!digest.partial || digest.free_regions.is_empty());
        Ok(())
    });
    some.assert(100);
    none.assert(5);
}

#[test]
fn a_child_is_held_by_the_smallest_box_that_strictly_contains_it() {
    let held = Floor::new("a board with a containment");
    let tied = Floor::new("a child with two candidate parents");
    check(shape_board(), None, |boxes| {
        let digest = digest_of(&shape_scene(&boxes))?;
        let mut expected: Vec<(String, String)> = Vec::new();
        let mut has_tie = false;
        for (c, child) in boxes.iter().enumerate() {
            let parents: Vec<(i64, usize)> = boxes
                .iter()
                .enumerate()
                .filter(|(p, parent)| *p != c && strictly_inside(**parent, *child))
                .map(|(p, parent)| (parent.2 * parent.3, p))
                .collect();
            has_tie |= parents.len() > 1;
            if let Some((_, p)) = parents.iter().min() {
                expected.push((id_of(c), id_of(*p)));
            }
        }
        tied.draw(has_tie);
        expected.sort();
        held.draw(!expected.is_empty());
        let got: Vec<(String, String)> =
            digest.containment.iter().map(|c| (c.child.clone(), c.parent.clone())).collect();
        prop_assert_eq!(got, expected);
        Ok(())
    });
    held.assert(100);
    tied.assert(60);
}

/// Components by repeated relabelling to the smallest label, a different
/// algorithm from the port's walk.
fn reference_clusters(boxes: &[IntBox]) -> Vec<Vec<String>> {
    let mut label: Vec<usize> = (0..boxes.len()).collect();
    for _ in 0..boxes.len() {
        for i in 0..boxes.len() {
            for j in 0..boxes.len() {
                if near(boxes[i], boxes[j]) {
                    let low = label[i].min(label[j]);
                    label[i] = low;
                    label[j] = low;
                }
            }
        }
    }
    let mut groups: Vec<Vec<String>> = Vec::new();
    for root in 0..boxes.len() {
        let members: Vec<String> =
            (0..boxes.len()).filter(|i| label[*i] == root).map(id_of).collect();
        if !members.is_empty() {
            groups.push(members);
        }
    }
    groups
}

#[test]
fn clusters_are_the_components_of_the_within_24_relation() {
    let several = Floor::new("a board of more than one cluster");
    let joined = Floor::new("a board with a cluster of several boxes");
    check(shape_board(), None, |boxes| {
        let digest = digest_of(&shape_scene(&boxes))?;
        let expected = reference_clusters(&boxes);
        several.draw(expected.len() > 1);
        joined.draw(expected.iter().any(|g| g.len() > 1));
        prop_assert_eq!(digest.clusters, expected);
        Ok(())
    });
    several.assert(90);
    joined.assert(100);
}

/// The free runs, found by asking each cell of the grid whether any box covers
/// it, a cell being half open: a box on its right or bottom edge does not.
fn reference_free(boxes: &[IntBox]) -> Vec<BoundingBox> {
    let min_x = boxes.iter().map(|b| b.0).min().unwrap_or(0);
    let min_y = boxes.iter().map(|b| b.1).min().unwrap_or(0);
    let max_x = boxes.iter().map(|b| b.0 + b.2).max().unwrap_or(0);
    let max_y = boxes.iter().map(|b| b.1 + b.3).max().unwrap_or(0);
    let cols = ((max_x - min_x + 19) / 20).max(1);
    let rows = ((max_y - min_y + 19) / 20).max(1);
    let mut free = Vec::new();
    for r in 0..rows {
        let mut start: Option<i64> = None;
        for c in 0..=cols {
            let (cx, cy) = (min_x + c * 20, min_y + r * 20);
            let covered = boxes
                .iter()
                .any(|b| b.0 < cx + 20 && b.0 + b.2 > cx && b.1 < cy + 20 && b.1 + b.3 > cy);
            let is_free = c < cols && !covered;
            match (is_free, start) {
                (true, None) => start = Some(c),
                (false, Some(from)) => {
                    free.push(bbox((min_x + from * 20, cy, (c - from) * 20, 20)));
                    start = None;
                }
                _ => {}
            }
        }
    }
    free
}

#[test]
fn free_regions_are_the_cells_no_box_covers_and_none_a_box_overlaps() {
    let some = Floor::new("a board with a free region");
    let rows = Floor::new("a board whose free regions span rows");
    check(shape_board(), None, |boxes| {
        let digest = digest_of(&shape_scene(&boxes))?;
        let expected = reference_free(&boxes);
        some.draw(!expected.is_empty());
        rows.draw(expected.iter().any(|r| r.y.to_bits() != expected[0].y.to_bits()));
        prop_assert_eq!(&digest.free_regions, &expected);
        let covering = |r: &BoundingBox, b: &IntBox| {
            let b = bbox(*b);
            b.w > 0.0
                && b.h > 0.0
                && b.x < r.x + r.w
                && b.x + b.w > r.x
                && b.y < r.y + r.h
                && b.y + b.h > r.y
        };
        prop_assert!(
            !digest.free_regions.iter().any(|r| boxes.iter().any(|b| covering(r, b))),
            "a free region under a box"
        );
        Ok(())
    });
    some.assert(100);
    rows.assert(100);
}

/// One node of a mixed board.
#[derive(Debug, Clone)]
enum Item {
    Shape { id: bool, comment: bool, proposal: bool, flags: u8, b: IntBox },
    Glyph(IntBox),
    Edge,
}

fn item() -> impl Strategy<Value = Item> {
    prop::strategy::Union::new_weighted(vec![
        (
            5,
            (any::<bool>(), 0_u8..4, int_box())
                .prop_map(|(id, flags, b)| Item::Shape {
                    id,
                    comment: false,
                    proposal: false,
                    flags,
                    b,
                })
                .boxed(),
        ),
        (
            2,
            (any::<bool>(), any::<bool>(), 0_u8..4, int_box())
                .prop_map(|(comment, proposal, flags, b)| Item::Shape {
                    id: true,
                    comment,
                    proposal,
                    flags,
                    b,
                })
                .boxed(),
        ),
        (1, int_box().prop_map(Item::Glyph).boxed()),
        (1, prop::strategy::Just(Item::Edge).boxed()),
    ])
}

fn node_of(index: usize, item: &Item) -> SceneNode {
    match item {
        Item::Shape { id, comment, proposal, flags, b } => {
            shape(id.then(|| id_of(index)), *b, *comment, *proposal, *flags)
        }
        Item::Glyph(b) => SceneNode::Glyph(GlyphSceneNode { bbox: bbox(*b), glyph: "g".into() }),
        Item::Edge => edge(),
    }
}

/// What the digest should name, from the items alone: the addressable shapes
/// with their flags, or else a positional name for every node with a box.
fn expected_entries(items: &[Item]) -> (Vec<(String, IntBox, bool, bool)>, bool) {
    let addressable: Vec<(String, IntBox, bool, bool)> = items
        .iter()
        .enumerate()
        .filter_map(|(i, it)| match it {
            Item::Shape { id: true, comment: false, proposal: false, flags, b } => {
                Some((id_of(i), *b, flags & 1 == 1, flags & 2 == 2))
            }
            _ => None,
        })
        .collect();
    if !addressable.is_empty() {
        return (addressable, true);
    }
    let positional = items
        .iter()
        .filter_map(|it| match it {
            Item::Shape { b, .. } | Item::Glyph(b) => Some(*b),
            Item::Edge => None,
        })
        .enumerate()
        .map(|(n, b)| (format!("n{n}"), b, false, false))
        .collect();
    (positional, false)
}

#[test]
fn entries_are_the_addressable_shapes_or_else_every_node_with_a_box() {
    let addressed = Floor::new("a board with an addressable shape");
    let fallback = Floor::new("a board with none, falling back to positions");
    let chrome = Floor::new("a board holding comment or proposal chrome beside a node");
    check(prop::collection::vec(item(), 0..=14), None, |items| {
        let nodes: Vec<SceneNode> =
            items.iter().enumerate().map(|(i, it)| node_of(i, it)).collect();
        let digest = digest_of(&scene(nodes))?;
        let (expected, is_addressed) = expected_entries(&items);
        addressed.draw(is_addressed);
        fallback.draw(!is_addressed && !expected.is_empty());
        chrome.draw(
            is_addressed
                && items.iter().any(|it| {
                    matches!(
                        it,
                        Item::Shape { comment: true, .. } | Item::Shape { proposal: true, .. }
                    )
                }),
        );
        prop_assert_eq!(digest.nodes.len(), expected.len());
        for (z, (node, (id, b, truncated, overflows))) in
            digest.nodes.iter().zip(&expected).enumerate()
        {
            prop_assert_eq!(&node.id, id);
            prop_assert_eq!(node.bbox, bbox(*b));
            prop_assert_eq!((node.z, node.truncated, node.overflows), (z, *truncated, *overflows));
        }
        Ok(())
    });
    addressed.assert(100);
    fallback.assert(6);
    chrome.assert(60);
}

#[test]
fn the_json_reads_back_as_the_digest_for_any_ids() {
    let escaped = Floor::new("a board naming an id that JSON must escape");
    let ids = prop::collection::vec(any::<String>(), 1..=6);
    check(ids, None, |ids| {
        let nodes = ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                shape(
                    Some(id.clone()),
                    (i64::try_from(i).unwrap_or(0) * 7, 0, 10, 10),
                    false,
                    false,
                    3,
                )
            })
            .collect();
        let digest = digest_of(&scene(nodes))?;
        escaped.draw(ids.iter().any(|id| id.chars().any(|c| c == '"' || c == '\\' || c < ' ')));
        let parsed: serde_json::Value = serde_json::from_str(&digest.to_json())
            .map_err(|e| TestCaseError::fail(e.to_string()))?;
        let names = |key: &str| -> Vec<String> {
            parsed[key]
                .as_array()
                .map(|a| a.iter().filter_map(|n| n["id"].as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        prop_assert_eq!(names("nodes"), ids.clone());
        prop_assert_eq!(parsed["partial"].as_bool(), Some(false));
        let clustered: Vec<String> = parsed["clusters"]
            .as_array()
            .map(|g| {
                g.iter()
                    .flat_map(|c| c.as_array().cloned().unwrap_or_default())
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let mut sorted = ids.clone();
        sorted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        sorted.dedup();
        let mut seen = clustered;
        seen.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        seen.dedup();
        prop_assert_eq!(seen.cmp(&sorted), Ordering::Equal);
        Ok(())
    });
    escaped.assert(80);
}
