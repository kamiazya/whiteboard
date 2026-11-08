//! `patch_anchor_groups` agrees with a full rebuild: the side-choice search
//! evaluates every trial through the patch, so a one-edge re-side must land
//! exactly the partition `build_anchor_groups` derives from scratch, and a
//! re-side to the sides an edge already has must change nothing.
//!
//! The TypeScript twin is `anchor-groups.properties.test.ts`.

use whiteboard_edge_routing::edge_anchors::{
    AnchorGroups, anchor_context, build_anchor_groups, patch_anchor_groups,
};
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_rules::SidePair;
use whiteboard_edge_routing::edge_sides::EdgeAnchorPair;
use whiteboard_edge_routing::geometry::Rect;
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::routing_input::{EdgeId, RoutableEdge, RoutingEnd, RoutingNode};
use whiteboard_proptest::proptest::prelude::{Just, Strategy, prop, prop_assert_eq, prop_oneof};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Debug)]
struct Layout {
    nodes: Vec<RoutingNode>,
    edges: Vec<RoutableEdge>,
    sides: JsMap<EdgeId, SidePair>,
    target: usize,
    next: SidePair,
}

fn side() -> impl Strategy<Value = Side> {
    prop_oneof![Just(Side::Top), Just(Side::Right), Just(Side::Bottom), Just(Side::Left)]
}

fn pair() -> impl Strategy<Value = SidePair> {
    (side(), side()).prop_map(|(from_side, to_side)| SidePair { from_side, to_side, around: false })
}

/// Deliberately dense: with few nodes and many edges, sides collide, so groups
/// hold several ends and a re-side changes fan-out fractions instead of moving
/// a lone end between empty sides.
fn layout() -> impl Strategy<Value = Layout> {
    let boxes = prop::collection::vec((-400i32..=400, -400i32..=400, 20i32..=200, 20i32..=200), 6);
    let links = prop::collection::vec((0u32..=5, 0u32..=5, pair()), 1..=12);
    (2u32..=6, boxes, links, 0usize..1000, pair()).prop_map(|(count, boxes, links, index, next)| {
        let nodes = (0..count)
            .zip(&boxes)
            .map(|(id, &(x, y, w, h))| RoutingNode {
                id,
                rect: Rect { x: f64::from(x), y: f64::from(y), w: f64::from(w), h: f64::from(h) },
            })
            .collect();
        let end = |node| RoutingEnd::Node { node, side: None, arrowhead: None };
        let edges: Vec<RoutableEdge> = (0u32..)
            .zip(&links)
            .map(|(id, &(from, to, _))| RoutableEdge {
                id,
                from: end(from % count),
                to: end(to % count),
                bends: None,
            })
            .collect();
        let sides = (0u32..).zip(&links).map(|(id, &(_, _, sides))| (id, sides)).collect();
        let target = index % edges.len();
        Layout { nodes, edges, sides, target, next }
    })
}

/// Group membership as a comparable value: the alignment pass reads sizes and
/// placement reads the members, so both are compared, in key order.
type Shape = (Vec<(EdgeId, EdgeAnchorPair)>, Vec<(String, usize)>);

fn shape_of(g: &AnchorGroups) -> Shape {
    let mut entries: Vec<(EdgeId, EdgeAnchorPair)> =
        g.entries.iter().map(|(id, pair)| (*id, *pair)).collect();
    entries.sort_by_key(|(id, _)| *id);
    let mut sizes: Vec<(String, usize)> =
        g.groups.iter().map(|(key, members)| (format!("{key:?}"), members.len())).collect();
    sizes.sort();
    (entries, sizes)
}

#[test]
fn a_one_edge_re_side_lands_the_same_partition_either_way() {
    let moved = Floor::new("a re-side that changed the partition");
    check(layout(), None, |l| {
        let ctx = anchor_context(&l.nodes, &l.edges);
        let base = build_anchor_groups(&ctx, &l.sides);
        let mut trial = l.sides.clone();
        trial.set(l.edges[l.target].id, l.next);
        let patched = patch_anchor_groups(&ctx, &base, &trial, l.target);
        let rebuilt = build_anchor_groups(&ctx, &trial);
        moved.draw(shape_of(&rebuilt) != shape_of(&base));
        prop_assert_eq!(shape_of(&patched), shape_of(&rebuilt));
        Ok(())
    });
    // Measured 183 to 188 of 200.
    moved.assert(150);
}

#[test]
fn re_siding_to_the_sides_it_already_has_is_the_identity() {
    check(layout(), None, |l| {
        let ctx = anchor_context(&l.nodes, &l.edges);
        let base = build_anchor_groups(&ctx, &l.sides);
        let patched = patch_anchor_groups(&ctx, &base, &l.sides, l.target);
        prop_assert_eq!(shape_of(&patched), shape_of(&base));
        Ok(())
    });
}
