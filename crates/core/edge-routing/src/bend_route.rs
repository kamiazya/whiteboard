//! An edge drawn through its stored bends: canvas-render's
//! `layout/edges/bend-route.ts`, ported function for function. The
//! reasoning is written once, in the TypeScript.

use crate::edge_geometry::{Side, side_point};
use crate::geometry::{Point, Rect};
use crate::routing_input::RoutableEdge;
use whiteboard_det::math::{js_max, js_min};

/// The point on `rect`'s border nearest `toward`, clamped into the box
/// first; the first of four on a tie.
fn facing(rect: Rect, toward: Point) -> Point {
    let x = js_min(js_max(toward.x, rect.x), rect.x + rect.w);
    let y = js_min(js_max(toward.y, rect.y), rect.y + rect.h);
    let gaps = [
        (y - rect.y, Point { x, y: rect.y }),
        (rect.y + rect.h - y, Point { x, y: rect.y + rect.h }),
        (x - rect.x, Point { x: rect.x, y }),
        (rect.x + rect.w - x, Point { x: rect.x + rect.w, y }),
    ];
    let [top, others @ ..] = gaps;
    others.into_iter().fold(top, |best, gap| if gap.0 < best.0 { gap } else { best }).1
}

fn endpoint(rect: Rect, anchor: Option<Point>, side: Option<Side>, toward: Point) -> Point {
    anchor.unwrap_or_else(|| side.map_or_else(|| facing(rect, toward), |s| side_point(rect, s)))
}

/// What the anchor pass resolved for each end, as `BendRouteEnds`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BendRouteEnds {
    pub from: Option<Point>,
    pub to: Option<Point>,
    pub from_side: Option<Side>,
    pub to_side: Option<Side>,
}

/// The path through the edge's bends, or `None` when it has none or any of
/// them is not finite.
#[must_use]
pub fn bend_route(
    edge: &RoutableEdge,
    from_rect: Rect,
    to_rect: Rect,
    ends: &BendRouteEnds,
) -> Option<Vec<Point>> {
    let bends = edge.bends.as_ref()?;
    let (&first, &last) = (bends.first()?, bends.last()?);
    if !bends.iter().all(|b| b.x.is_finite() && b.y.is_finite()) {
        return None;
    }
    let mut path = vec![endpoint(from_rect, ends.from, ends.from_side, first)];
    path.extend(bends.iter().copied());
    path.push(endpoint(to_rect, ends.to, ends.to_side, last));
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::{BendRouteEnds, bend_route};
    use crate::geometry::{Point, Rect};
    use crate::routing_input::{RoutableEdge, RoutingEnd};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_bent_edge_leaves_each_box_at_the_border_point_nearest_its_first_bend() {
        let on = |node| RoutingEnd::Node { node, side: None, arrowhead: None };
        let edge = RoutableEdge {
            id: 0,
            from: on(1),
            to: on(2),
            bends: Some(vec![Point { x: 50.0, y: -30.0 }]),
        };
        let from = Rect { x: 0.0, y: 0.0, w: 40.0, h: 40.0 };
        let to = Rect { x: 100.0, y: 0.0, w: 40.0, h: 40.0 };
        let path = bend_route(&edge, from, to, &BendRouteEnds::default());
        assert_eq!(
            path,
            Some(vec![
                Point { x: 40.0, y: 0.0 },
                Point { x: 50.0, y: -30.0 },
                Point { x: 100.0, y: 0.0 }
            ])
        );
        let unbent = RoutableEdge { bends: None, ..edge };
        assert_eq!(bend_route(&unbent, from, to, &BendRouteEnds::default()), None);
    }
}
