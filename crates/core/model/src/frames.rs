//! What "in a frame" means (`frameHolds` and `membersOf` in
//! `packages/model/src/spatial.ts`): membership is geometric, so no stored list
//! says who is in a frame, and this is the one place that decides it.

use crate::spatial::SpatialNode;

/// Whether a frame's box holds a node's whole box, edges inclusive, so a node
/// flush with the frame's border is a member. A frame holds itself by this rule.
#[must_use]
pub fn frame_holds(frame: &SpatialNode, node: &SpatialNode) -> bool {
    node.x >= frame.x
        && node.y >= frame.y
        && node.x + node.width <= frame.x + frame.width
        && node.y + node.height <= frame.y + frame.height
}

/// The nodes a frame holds, the frame itself (by id) excluded, in the order given.
pub fn members_of<'n>(
    nodes: &'n [SpatialNode],
    frame: &'n SpatialNode,
) -> impl Iterator<Item = &'n SpatialNode> {
    nodes.iter().filter(move |node| node.id != frame.id && frame_holds(frame, node))
}

#[cfg(test)]
mod tests {
    use super::{frame_holds, members_of};
    use crate::spatial::SpatialNode;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn node(id: &str, x: f64, y: f64, width: f64, height: f64) -> SpatialNode {
        SpatialNode { id: id.to_owned(), x, y, width, height, ..SpatialNode::default() }
    }

    #[test]
    fn a_node_flush_with_any_side_is_held() {
        let frame = node("f", 10.0, 20.0, 100.0, 50.0);
        assert!(frame_holds(&frame, &node("near", 10.0, 20.0, 5.0, 5.0)));
        assert!(frame_holds(&frame, &node("far", 105.0, 65.0, 5.0, 5.0)));
        assert!(frame_holds(&frame, &frame));
    }

    #[test]
    fn a_node_past_any_side_is_not() {
        let frame = node("f", 10.0, 20.0, 100.0, 50.0);
        for (x, y) in [(9.0, 30.0), (20.0, 19.0), (106.0, 30.0), (20.0, 66.0)] {
            assert!(!frame_holds(&frame, &node("n", x, y, 5.0, 5.0)), "({x}, {y})");
        }
    }

    #[test]
    fn a_frame_is_not_its_own_member() {
        let nodes = [node("f", 0.0, 0.0, 10.0, 10.0), node("a", 1.0, 1.0, 2.0, 2.0)];
        let held: Vec<&str> = members_of(&nodes, &nodes[0]).map(|n| n.id.as_str()).collect();
        assert_eq!(held, ["a"]);
    }
}
