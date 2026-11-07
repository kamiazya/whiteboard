//! Touching boxes are marked, not routed: canvas-render's
//! `layout/edges/edge-contact.ts`, ported function for function. The
//! reasoning is written once, in the TypeScript; `Math.min`/`Math.max` are
//! [`js_min`]/[`js_max`] here, and a NaN takes the branch the TypeScript's
//! comparisons give it.

#![expect(clippy::float_cmp, reason = "the TypeScript compares with ===")]
#![expect(
    clippy::manual_midpoint,
    reason = "`f64::midpoint` avoids the overflow `(a + b) / 2` has, which the TypeScript does not"
)]

use crate::edge_geometry::Side;
use crate::edge_rules::fully_contains;
use crate::geometry::{Point, Rect};
use crate::routing_input::{RoutableEdge, RoutingNode, rect_at_end};
use whiteboard_det::math::{js_max, js_min};

const CONTACT_MARK_PX: f64 = 10.0;
const MIN_CONTACT_MARK_PX: f64 = 1.0;

/// The arrowhead mark between two touching boxes and the sides it sits on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Contact {
    pub path: [Point; 2],
    pub from_side: Side,
    pub to_side: Side,
}

#[derive(Clone, Copy)]
struct Span {
    near: f64,
    far: f64,
}

const fn span_x(r: Rect) -> Span {
    Span { near: r.x, far: r.x + r.w }
}

const fn span_y(r: Rect) -> Span {
    Span { near: r.y, far: r.y + r.h }
}

fn overlap(a: Span, b: Span) -> f64 {
    js_min(a.far, b.far) - js_max(a.near, b.near)
}

fn contact_between(from: Rect, to: Rect) -> Option<Contact> {
    let ox = overlap(span_x(from), span_x(to));
    let oy = overlap(span_y(from), span_y(to));
    if ox < 0.0 || oy < 0.0 {
        return None;
    }
    if fully_contains(from, to) || fully_contains(to, from) {
        return None;
    }
    let x_first = ox / (from.w + to.w) <= oy / (from.h + to.h);
    let order = if x_first { [true, false] } else { [false, true] };
    order.into_iter().find_map(|along_x| contact_along(from, to, along_x))
}

fn contact_along(from: Rect, to: Rect, along_x: bool) -> Option<Contact> {
    let (from_span, to_span, from_cross, to_cross) = if along_x {
        (span_x(from), span_x(to), span_y(from), span_y(to))
    } else {
        (span_y(from), span_y(to), span_x(from), span_x(to))
    };
    if overlap(from_cross, to_cross) <= 0.0 {
        return None;
    }
    let from_centre = (from_span.near + from_span.far) / 2.0;
    let to_centre = (to_span.near + to_span.far) / 2.0;
    if from_centre == to_centre {
        return None;
    }
    let forward = to_centre > from_centre;
    let tip_along = if forward { to_span.near } else { to_span.far };
    let room = if forward { tip_along - from_span.near } else { from_span.far - tip_along };
    let length = js_min(CONTACT_MARK_PX, room);
    if length < MIN_CONTACT_MARK_PX {
        return None;
    }
    let tail_along = if forward { tip_along - length } else { tip_along + length };
    let cross_mid =
        (js_max(from_cross.near, to_cross.near) + js_min(from_cross.far, to_cross.far)) / 2.0;
    let at = |along: f64| {
        if along_x { Point { x: along, y: cross_mid } } else { Point { x: cross_mid, y: along } }
    };
    let (from_side, to_side) = match (along_x, forward) {
        (true, true) => (Side::Right, Side::Left),
        (true, false) => (Side::Left, Side::Right),
        (false, true) => (Side::Bottom, Side::Top),
        (false, false) => (Side::Top, Side::Bottom),
    };
    Some(Contact { path: [at(tail_along), at(tip_along)], from_side, to_side })
}

/// The contact between the boxes, unless a named side disagrees with it.
#[must_use]
pub fn contact_for(edge: &RoutableEdge, from_rect: Rect, to_rect: Rect) -> Option<Contact> {
    let contact = contact_between(from_rect, to_rect)?;
    if edge.from.side().is_some_and(|named| named != contact.from_side)
        || edge.to.side().is_some_and(|named| named != contact.to_side)
    {
        return None;
    }
    Some(contact)
}

/// Whether the edge is drawn as a contact mark rather than routed, as
/// `marksContact`: never when it has bends.
#[must_use]
pub fn marks_contact(nodes: &[RoutingNode], edge: &RoutableEdge) -> bool {
    if edge.bends.as_ref().is_some_and(|b| !b.is_empty()) {
        return false;
    }
    let (Some(from_rect), Some(to_rect)) =
        (rect_at_end(nodes, &edge.from), rect_at_end(nodes, &edge.to))
    else {
        return false;
    };
    contact_for(edge, from_rect, to_rect).is_some()
}

#[cfg(test)]
mod tests {
    use super::{Contact, contact_for};
    use crate::edge_geometry::Side;
    use crate::geometry::{Point, Rect};
    use crate::routing_input::{RoutableEdge, RoutingEnd};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn edge(from_side: Option<Side>) -> RoutableEdge {
        RoutableEdge {
            id: 0,
            from: RoutingEnd::Node { node: 1, side: from_side, arrowhead: None },
            to: RoutingEnd::Node { node: 2, side: None, arrowhead: None },
            bends: None,
        }
    }

    #[test]
    fn boxes_sharing_a_border_get_a_mark_on_the_targets_facing_side() {
        let from = Rect { x: 0.0, y: 0.0, w: 50.0, h: 40.0 };
        let to = Rect { x: 50.0, y: 0.0, w: 50.0, h: 40.0 };
        let mark = Contact {
            path: [Point { x: 40.0, y: 20.0 }, Point { x: 50.0, y: 20.0 }],
            from_side: Side::Right,
            to_side: Side::Left,
        };
        assert_eq!(contact_for(&edge(None), from, to), Some(mark));
        assert_eq!(contact_for(&edge(Some(Side::Top)), from, to), None);
        let apart = Rect { x: 60.0, ..to };
        assert_eq!(contact_for(&edge(None), from, apart), None);
    }
}
