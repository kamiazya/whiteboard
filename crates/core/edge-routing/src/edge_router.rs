//! The path between two placed anchors: canvas-render's
//! `layout/edges/edge-router.ts`, ported function for function.
//!
//! The reasoning behind each pass is written once, in the TypeScript. Rust
//! works for the same answer in two places:
//! - `bestCandidate`'s comparator treats lengths within 1e-6 as equal, which
//!   is not transitive, so it sorts with [`js_sort_by`], V8's own algorithm.
//! - `resolvedSides` derives the default sides lazily, and only when a side is
//!   unnamed. Deriving is pure, so whether it runs changes nothing.

#![expect(clippy::float_cmp, reason = "the TypeScript compares with ===")]

use crate::bend_route::{BendRouteEnds, bend_route};
use crate::edge_contact::contact_for;
use crate::edge_geometry::{
    Side, bounding_box_of, contains_point, outward_normal, path_is_clear, path_length,
    segment_crosses_rect, side_point, union_rect, without_repeats,
};
use crate::edge_rules::{bend_count, interior_ink_through};
use crate::edge_sides::{
    EdgeAnchorPair, ORTHOGONAL_STUB_PX, derive_default_sides, self_edge_loop_control_points,
};
use crate::geometry::{Point, Rect};
use crate::grid_route::route_on_grid;
use crate::routing_budget::RoutingBudget;
use crate::routing_input::{Arrowhead, RoutableEdge, RoutingNode, rect_at_end};
use crate::side_slides::{
    FacingEnds, deepened_corridor, slid_for_approach, slide_along_side, try_zero_bend_slide,
};
use crate::straight_detour::{
    DetourObstacle, SquareEnds, approaches_sideways, corner_detour, square_ends, strict_interior,
};
use whiteboard_det::math::compare_numbers;
use whiteboard_det::sort::js_sort_by;

const ROUTE_MARGIN_PX: f64 = 8.0;
const LABEL_MARGIN_PX: f64 = 2.0;
const OBSTACLE_CLEARANCE_PX: f64 = 16.0;

/// As `DETOUR_REACH_PX`.
pub const DETOUR_REACH_PX: f64 = OBSTACLE_CLEARANCE_PX;

/// An edge's routing style, as `EdgeRoutingStyle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutingStyle {
    Straight,
    Orthogonal,
    Curved,
}

/// A routed edge, as the `ResolvedEdgeNode` `routeEdge` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutedEdge {
    pub path: Vec<Point>,
    pub rounded: bool,
    pub from_side: Side,
    pub to_side: Side,
    pub from_end: Arrowhead,
    pub to_end: Arrowhead,
}

fn ordering_value(o: core::cmp::Ordering) -> f64 {
    match o {
        core::cmp::Ordering::Less => -1.0,
        core::cmp::Ordering::Equal => 0.0,
        core::cmp::Ordering::Greater => 1.0,
    }
}

/// The best of `candidates`: least endpoint-body ink, then shortest (within
/// 1e-6), then fewest bends; the first clear of the inflated boxes, else of
/// the raw ones, else the best regardless.
fn best_candidate(
    candidates: Vec<Vec<Point>>,
    inflated: &[Rect],
    raw: &[Rect],
    endpoint_rects: &[Rect],
) -> Vec<Point> {
    let mut scored: Vec<(f64, f64, f64, Vec<Point>)> = candidates
        .into_iter()
        .map(|path| {
            (
                interior_ink_through(&path, endpoint_rects),
                path_length(&path),
                bend_count(&path),
                path,
            )
        })
        .collect();
    js_sort_by(&mut scored, |a, b| {
        if a.0 != b.0 {
            return ordering_value(compare_numbers(a.0, b.0));
        }
        if (a.1 - b.1).abs() > 1e-6 {
            return ordering_value(compare_numbers(a.1, b.1));
        }
        ordering_value(compare_numbers(a.2, b.2))
    });
    let ranked: Vec<Vec<Point>> = scored.into_iter().map(|c| c.3).collect();
    let pick = ranked
        .iter()
        .position(|p| path_is_clear(p, inflated))
        .or_else(|| ranked.iter().position(|p| path_is_clear(p, raw)))
        .unwrap_or(0);
    ranked.into_iter().nth(pick).unwrap_or_default()
}

/// The four ways around `region`, as `detourCandidates`.
#[must_use]
pub fn detour_candidates(start: Point, end: Point, region: Rect) -> [Vec<Point>; 4] {
    let above = region.y - OBSTACLE_CLEARANCE_PX;
    let below = region.y + region.h + OBSTACLE_CLEARANCE_PX;
    let left_of = region.x - OBSTACLE_CLEARANCE_PX;
    let right_of = region.x + region.w + OBSTACLE_CLEARANCE_PX;
    [
        vec![start, Point { x: start.x, y: above }, Point { x: end.x, y: above }, end],
        vec![start, Point { x: start.x, y: below }, Point { x: end.x, y: below }, end],
        vec![start, Point { x: left_of, y: start.y }, Point { x: left_of, y: end.y }, end],
        vec![start, Point { x: right_of, y: start.y }, Point { x: right_of, y: end.y }, end],
    ]
}

fn blocking_region(start: Point, end: Point, obstacles: &[Rect]) -> Option<Rect> {
    let crossing: Vec<Rect> =
        obstacles.iter().copied().filter(|&r| segment_crosses_rect(start, end, r)).collect();
    union_rect(&crossing)
}

/// The obstacles a route avoids: inflated for preference, raw for the rule.
pub struct RouteObstacles {
    pub inflated: Vec<Rect>,
    pub raw: Vec<Rect>,
}

fn route_straight(
    start: Point,
    end: Point,
    obstacles: &RouteObstacles,
    own: &[Rect],
    around: bool,
) -> Vec<Point> {
    let (inflated, raw) = (&obstacles.inflated, &obstacles.raw);
    let Some(region) = blocking_region(start, end, inflated) else { return vec![start, end] };
    let candidates = || detour_candidates(start, end, region).to_vec();
    if around {
        return best_candidate(candidates(), inflated, raw, &[]);
    }
    let detour: Vec<DetourObstacle> = inflated
        .iter()
        .zip(raw)
        .map(|(&block, &body)| DetourObstacle { block, body, escapable: true })
        .chain(own.iter().map(|&body| DetourObstacle {
            block: strict_interior(body),
            body,
            escapable: false,
        }))
        .collect();
    corner_detour(start, end, &detour, OBSTACLE_CLEARANCE_PX)
        .unwrap_or_else(|| best_candidate(candidates(), inflated, raw, &[]))
}

/// One end of a route: its anchor's side, box and stub depth.
#[derive(Debug, Clone, Copy)]
pub struct RouteEnd {
    pub side: Side,
    pub rect: Rect,
    pub depth: f64,
}

/// What a route runs between, as `RouteEnds`.
#[derive(Debug, Clone, Copy)]
pub struct RouteEnds {
    pub start: Point,
    pub end: Point,
    pub from: RouteEnd,
    pub to: RouteEnd,
}

fn stub_from(point: Point, side: Side, depth: f64) -> Point {
    let normal = outward_normal(side);
    Point { x: point.x + normal.x * depth, y: point.y + normal.y * depth }
}

fn route_straight_with_approach(
    ends: &RouteEnds,
    obstacles: &RouteObstacles,
    around: bool,
) -> Vec<Point> {
    let own = [ends.from.rect, ends.to.rect];
    let exit = stub_from(ends.start, ends.from.side, ends.from.depth);
    let entry = stub_from(ends.end, ends.to.side, ends.to.depth);
    if around && blocking_region(ends.start, ends.end, &obstacles.inflated).is_some() {
        let mut path = vec![ends.start];
        path.extend(route_straight(exit, entry, obstacles, &own, true));
        path.push(ends.end);
        return without_repeats(&path);
    }
    let clear = |a: Point, b: Point| {
        blocking_region(a, b, &obstacles.inflated).is_none()
            && !own.iter().any(|&r| segment_crosses_rect(a, b, strict_interior(r)))
    };
    let squaring =
        SquareEnds { exit, entry, from_side: ends.from.side, to_side: ends.to.side, clear: &clear };
    square_ends(approached_path(ends, obstacles, around), &squaring)
}

fn approached_path(ends: &RouteEnds, obstacles: &RouteObstacles, around: bool) -> Vec<Point> {
    let RouteEnds { start, end, from, to } = *ends;
    let own = [from.rect, to.rect];
    let from_sideways = approaches_sideways(start, end, from.side);
    let to_sideways = approaches_sideways(end, start, to.side);
    if !from_sideways && !to_sideways {
        return route_straight(start, end, obstacles, &own, around);
    }
    let clear_run = |a: Option<Point>, b: Option<Point>| {
        let run = route_straight(a?, b?, obstacles, &own, around);
        (run.len() == 2).then_some(run)
    };
    if to_sideways && !from_sideways {
        let entry = stub_from(end, to.side, to.depth);
        if let Some(mut run) =
            clear_run(slide_along_side(start, from.rect, from.side, entry), Some(entry))
        {
            run.push(end);
            return without_repeats(&run);
        }
    }
    if from_sideways && !to_sideways {
        let exit = stub_from(start, from.side, from.depth);
        if let Some(run) = clear_run(Some(exit), slide_along_side(end, to.rect, to.side, exit)) {
            let mut path = vec![start];
            path.extend(run);
            return without_repeats(&path);
        }
    }
    let exit = if from_sideways { stub_from(start, from.side, from.depth) } else { start };
    let entry = if to_sideways { stub_from(end, to.side, to.depth) } else { end };
    let mut path = vec![start];
    path.extend(route_straight(exit, entry, obstacles, &own, around));
    path.push(end);
    without_repeats(&path)
}

/// The obstacles whose inflated box touches `bounds`, inflated and raw kept index for index.
fn window_obstacles(obstacles: &RouteObstacles, bounds: Rect) -> RouteObstacles {
    let touches = |r: &Rect| {
        r.x <= bounds.x + bounds.w
            && r.x + r.w >= bounds.x
            && r.y <= bounds.y + bounds.h
            && r.y + r.h >= bounds.y
    };
    let (inflated, raw) = obstacles
        .inflated
        .iter()
        .zip(&obstacles.raw)
        .filter(|(i, _)| touches(i))
        .map(|(&i, &r)| (i, r))
        .unzip();
    RouteObstacles { inflated, raw }
}

/// An orthogonal route's frame: the anchors after sliding, and the stubs.
struct Corridor {
    start: Point,
    end: Point,
    exit: Point,
    entry: Point,
    to_normal: Point,
}

impl Corridor {
    /// `between(middles)`: the stubs around `middles`, the entry stub left
    /// out when the last middle already arrives square from outside.
    fn between(&self, middles: &[Point]) -> Vec<Point> {
        let n = self.to_normal;
        let arrives_from_outside = |p: Point| {
            n.x * (p.x - self.end.x) + n.y * (p.y - self.end.y) > 0.0
                && if n.x == 0.0 { p.x == self.end.x } else { p.y == self.end.y }
        };
        let mut path = vec![self.start, self.exit];
        path.extend_from_slice(middles);
        if !middles.last().is_some_and(|&last| arrives_from_outside(last)) {
            path.push(self.entry);
        }
        path.push(self.end);
        without_repeats(&path)
    }
}

fn route_orthogonal(
    ends: &RouteEnds,
    obstacles: &RouteObstacles,
    budget: Option<&mut RoutingBudget>,
) -> Vec<Point> {
    let RouteEnds { start, end, from, to } = *ends;
    if start.x == end.x && start.y == end.y {
        return vec![start, end];
    }
    let facing = FacingEnds {
        start,
        end,
        from_side: from.side,
        to_side: to.side,
        from_rect: from.rect,
        to_rect: to.rect,
    };
    if let Some(zero_bend) = try_zero_bend_slide(&facing, &obstacles.inflated) {
        return zero_bend;
    }
    let to_normal = outward_normal(to.side);
    let start = slid_for_approach(&facing, to_normal);
    let from_depth = deepened_corridor(start, end, (from.side, to.side), from.depth, to_normal);
    let corridor = Corridor {
        start,
        end,
        exit: stub_from(start, from.side, from_depth),
        entry: stub_from(end, to.side, to.depth),
        to_normal,
    };
    let endpoint_rects = [from.rect, to.rect];
    let (exit, entry) = (corridor.exit, corridor.entry);
    let elbows = vec![
        corridor.between(&[Point { x: entry.x, y: exit.y }]),
        corridor.between(&[Point { x: exit.x, y: entry.y }]),
    ];
    let elbow_box = bounding_box_of(&elbows.concat());
    let near = window_obstacles(obstacles, elbow_box);
    if elbows.iter().any(|p| {
        path_is_clear(p, &near.inflated) && interior_ink_through(p, &endpoint_rects) == 0.0
    }) {
        return best_candidate(elbows, &near.inflated, &near.raw, &endpoint_rects);
    }
    detoured_or_searched(&corridor, elbows, elbow_box, &near, obstacles, &endpoint_rects, budget)
}

fn detoured_or_searched(
    corridor: &Corridor,
    elbows: Vec<Vec<Point>>,
    elbow_box: Rect,
    near: &RouteObstacles,
    obstacles: &RouteObstacles,
    endpoint_rects: &[Rect; 2],
    budget: Option<&mut RoutingBudget>,
) -> Vec<Point> {
    let region = detour_region(&elbows, near, endpoint_rects);
    let mut candidates = elbows;
    if let Some(region) = region {
        for path in detour_candidates(corridor.exit, corridor.entry, region) {
            candidates
                .push(corridor.between(path.get(1..path.len().saturating_sub(1)).unwrap_or(&[])));
        }
    }
    let work_box = match region.and_then(|r| union_rect(&[elbow_box, r])) {
        None => elbow_box,
        Some(reach) => Rect {
            x: reach.x - DETOUR_REACH_PX,
            y: reach.y - DETOUR_REACH_PX,
            w: reach.w + 2.0 * DETOUR_REACH_PX,
            h: reach.h + 2.0 * DETOUR_REACH_PX,
        },
    };
    let work = window_obstacles(obstacles, work_box);
    let enumerated = best_candidate(candidates, &work.inflated, &work.raw, endpoint_rects);
    if interior_ink_through(&enumerated, endpoint_rects) == 0.0
        && path_is_clear(&enumerated, &work.raw)
    {
        return enumerated;
    }
    match grid_searched(corridor, obstacles, endpoint_rects, budget) {
        None => enumerated,
        Some(middle) => {
            best_candidate(vec![enumerated, middle], &work.inflated, &work.raw, endpoint_rects)
        }
    }
}

/// What the elbows cut through: the foreign obstacles they cross and the
/// endpoint bodies they put ink in, as one box to detour around.
fn detour_region(
    elbows: &[Vec<Point>],
    near: &RouteObstacles,
    endpoint_rects: &[Rect; 2],
) -> Option<Rect> {
    let crossed_by = |r: &Rect| {
        elbows.iter().any(|path| {
            path.windows(2).any(|w| matches!(w, [a, b] if segment_crosses_rect(*a, *b, *r)))
        })
    };
    let crossing: Vec<Rect> = near
        .inflated
        .iter()
        .copied()
        .filter(crossed_by)
        .chain(
            endpoint_rects
                .iter()
                .copied()
                .filter(|&r| elbows.iter().any(|p| interior_ink_through(p, &[r]) > 0.0)),
        )
        .collect();
    union_rect(&crossing)
}

/// The grid search between the stubs, charged to the budget's grid account;
/// `None` when it finds nothing within what the account allows.
fn grid_searched(
    corridor: &Corridor,
    obstacles: &RouteObstacles,
    endpoint_rects: &[Rect; 2],
    budget: Option<&mut RoutingBudget>,
) -> Option<Vec<Point>> {
    let mut around = obstacles.raw.clone();
    around.extend_from_slice(endpoint_rects);
    let allowance = budget.as_ref().map_or(f64::INFINITY, |b| b.grid);
    let searched =
        route_on_grid(corridor.exit, corridor.entry, &around, OBSTACLE_CLEARANCE_PX, allowance);
    if let Some(b) = budget {
        b.grid -= searched.spent;
    }
    let path = searched.path?;
    Some(corridor.between(path.get(1..path.len().saturating_sub(1)).unwrap_or(&[])))
}

/// Every node's box but the edge's own ends' and anything holding an
/// anchor, plus the label boxes, as `routeObstacles`.
fn route_obstacles(
    nodes: &[RoutingNode],
    edge: &RoutableEdge,
    anchors: (Point, Point),
    others: Option<&[Rect]>,
    labels: &[Rect],
    touched_blocks: bool,
) -> RouteObstacles {
    let (start, end) = anchors;
    let (from_id, to_id) = (edge.from.node(), edge.to.node());
    let boxes: Vec<Rect> = others.map_or_else(
        || {
            nodes
                .iter()
                .filter(|n| Some(n.id) != from_id && Some(n.id) != to_id)
                .map(|n| n.rect)
                .collect()
        },
        <[Rect]>::to_vec,
    );
    let holds = |r: Rect, p: Point| {
        if touched_blocks {
            p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h
        } else {
            contains_point(r, p)
        }
    };
    let clear = |r: &Rect| !holds(*r, start) && !holds(*r, end);
    let grown = |margin: f64| {
        move |r: &Rect| Rect {
            x: r.x - margin,
            y: r.y - margin,
            w: r.w + 2.0 * margin,
            h: r.h + 2.0 * margin,
        }
    };
    let raw_boxes: Vec<Rect> = boxes.into_iter().filter(clear).collect();
    let mut inflated: Vec<Rect> = raw_boxes.iter().map(grown(ROUTE_MARGIN_PX)).collect();
    let mut raw = raw_boxes;
    let raw_labels: Vec<Rect> = labels.iter().copied().filter(clear).collect();
    inflated.extend(raw_labels.iter().map(grown(LABEL_MARGIN_PX)));
    raw.extend(raw_labels);
    RouteObstacles { inflated, raw }
}

/// What `routeEdge` is asked beyond the edge itself.
#[derive(Default)]
pub struct RouteRequest<'a> {
    pub anchors: Option<&'a EdgeAnchorPair>,
    pub others: Option<&'a [Rect]>,
    pub budget: Option<&'a mut RoutingBudget>,
    pub labels: &'a [Rect],
}

/// A path, whether it is rounded, and the two sides.
type Unrouted = (Vec<Point>, bool, Side, Side);

/// The paths `routeEdge` draws before routing anything: through the stored
/// bends, a self-edge's loop, and the mark between touching boxes.
fn unrouted(
    edge: &RoutableEdge,
    (from_rect, to_rect): (Rect, Rect),
    anchors: &EdgeAnchorPair,
    (named_from, named_to): (Option<Side>, Option<Side>),
    style: RoutingStyle,
) -> Option<Unrouted> {
    let bend_ends = BendRouteEnds {
        from: anchors.from,
        to: anchors.to,
        from_side: named_from,
        to_side: named_to,
    };
    if let Some(bent) = bend_route(edge, from_rect, to_rect, &bend_ends) {
        let (fs, ts) = (named_from.unwrap_or(Side::Right), named_to.unwrap_or(Side::Left));
        return Some((bent, style == RoutingStyle::Curved, fs, ts));
    }
    if edge.is_self_loop() {
        let (fs, ts) =
            (edge.from.side().unwrap_or(Side::Right), edge.to.side().unwrap_or(Side::Right));
        let start = anchors.from.unwrap_or_else(|| side_point(from_rect, fs));
        let [out, back] = self_edge_loop_control_points(start, fs);
        let end = anchors.to.unwrap_or_else(|| side_point(to_rect, ts));
        return Some((vec![start, out, back, end], false, fs, ts));
    }
    contact_for(edge, from_rect, to_rect)
        .map(|contact| (contact.path.to_vec(), false, contact.from_side, contact.to_side))
}

/// The path between two placed ends, once no stored route answers.
fn routed_between(
    nodes: &[RoutingNode],
    edge: &RoutableEdge,
    from: RouteEnd,
    to: RouteEnd,
    anchors: &EdgeAnchorPair,
    style: RoutingStyle,
    request: RouteRequest<'_>,
) -> Vec<Point> {
    let start = anchors.from.unwrap_or_else(|| side_point(from.rect, from.side));
    let end = anchors.to.unwrap_or_else(|| side_point(to.rect, to.side));
    let obstacles = route_obstacles(
        nodes,
        edge,
        (start, end),
        request.others,
        request.labels,
        style == RoutingStyle::Straight,
    );
    let ends = RouteEnds { start, end, from, to };
    if style == RoutingStyle::Straight {
        route_straight_with_approach(&ends, &obstacles, anchors.around)
    } else {
        route_orthogonal(&ends, &obstacles, request.budget)
    }
}

/// The edge's path and sides, as `routeEdge`.
#[must_use]
pub fn route_edge(
    nodes: &[RoutingNode],
    edge: &RoutableEdge,
    style: RoutingStyle,
    request: RouteRequest<'_>,
) -> RoutedEdge {
    let from_end = edge.from.arrowhead().unwrap_or(Arrowhead::None);
    let to_end = edge.to.arrowhead().unwrap_or(Arrowhead::Arrow);
    let routed = |path, rounded, from_side, to_side| RoutedEdge {
        path,
        rounded,
        from_side,
        to_side,
        from_end,
        to_end,
    };
    let (Some(from_rect), Some(to_rect)) =
        (rect_at_end(nodes, &edge.from), rect_at_end(nodes, &edge.to))
    else {
        let origin = Point { x: 0.0, y: 0.0 };
        let (fs, ts) =
            (edge.from.side().unwrap_or(Side::Right), edge.to.side().unwrap_or(Side::Left));
        return routed(vec![origin, origin], false, fs, ts);
    };
    let anchors = request.anchors.copied().unwrap_or_default();
    let named_from = anchors.from_side.or(edge.from.side());
    let named_to = anchors.to_side.or(edge.to.side());
    if let Some((path, rounded, fs, ts)) =
        unrouted(edge, (from_rect, to_rect), &anchors, (named_from, named_to), style)
    {
        return routed(path, rounded, fs, ts);
    }
    let unnamed = || derive_default_sides(nodes, edge, from_rect, to_rect, &|_, _| 0.0);
    let from = RouteEnd {
        side: named_from.unwrap_or_else(|| unnamed().from_side),
        rect: from_rect,
        depth: anchors.from_lane_depth.unwrap_or(ORTHOGONAL_STUB_PX),
    };
    let to = RouteEnd {
        side: named_to.unwrap_or_else(|| unnamed().to_side),
        rect: to_rect,
        depth: anchors.to_lane_depth.unwrap_or(ORTHOGONAL_STUB_PX),
    };
    let (from_side, to_side) = (from.side, to.side);
    let path = routed_between(nodes, edge, from, to, &anchors, style, request);
    routed(path, style == RoutingStyle::Curved, from_side, to_side)
}

#[cfg(test)]
mod tests {
    use super::best_candidate;
    use crate::geometry::Point;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn path(points: &[(f64, f64)]) -> Vec<Point> {
        points.iter().map(|&(x, y)| Point { x, y }).collect()
    }

    /// Lengths further apart than 1e-6 rank by length before bends: the
    /// straight run is 5e-4 longer, so the bent one wins. The generated
    /// differential almost never draws two candidates that close, so the
    /// tolerance is pinned here.
    #[test]
    fn a_length_gap_past_the_tolerance_outranks_fewer_bends() {
        let straight = path(&[(0.0, 0.0), (10.0005, 0.0)]);
        let bent = path(&[(0.0, 0.0), (5.0, 0.0), (5.0, 5.0)]);
        assert_eq!(best_candidate(vec![straight, bent.clone()], &[], &[], &[]), bent);
    }

    /// Within 1e-6 the lengths tie and the fewer bends win.
    #[test]
    fn lengths_within_the_tolerance_tie_and_fewer_bends_win() {
        let straight = path(&[(0.0, 0.0), (10.000_000_5, 0.0)]);
        let bent = path(&[(0.0, 0.0), (5.0, 0.0), (5.0, 5.0)]);
        assert_eq!(best_candidate(vec![bent, straight.clone()], &[], &[], &[]), straight);
    }

    /// Three lengths each within 1e-6 of the next but not of the one after:
    /// the comparator is intransitive, so the answer is whatever V8's sort
    /// makes of it. Node sorts `[a, b, c]` here to `[c, b, a]`; a plain
    /// stable sort gives `[b, a, c]`, which would pick the bent path.
    #[test]
    fn an_intransitive_near_tie_ranks_as_v8_sorts_it() {
        let a = path(&[(0.0, 0.0), (3.0, 0.0), (3.0, 4.0), (6.0, 4.0)]);
        let b = path(&[(0.0, 0.0), (5.0, 0.0), (5.0, 5.000_000_8)]);
        let c = path(&[(0.0, 0.0), (10.000_001_6, 0.0)]);
        assert_eq!(best_candidate(vec![a, b, c.clone()], &[], &[], &[]), c);
    }

    /// A box whose inflated edge lies exactly on the window's far border is
    /// in the window: `touches` is inclusive on every side, as the
    /// TypeScript's `windowObstacles` is.
    #[test]
    fn a_box_touching_the_window_border_exactly_is_kept() {
        use super::{RouteObstacles, window_obstacles};
        use crate::geometry::Rect;
        let window = Rect { x: 0.0, y: 0.0, w: 10.0, h: 10.0 };
        let touching = [
            Rect { x: 10.0, y: 0.0, w: 4.0, h: 4.0 },
            Rect { x: -4.0, y: 0.0, w: 4.0, h: 4.0 },
            Rect { x: 0.0, y: 10.0, w: 4.0, h: 4.0 },
            Rect { x: 0.0, y: -4.0, w: 4.0, h: 4.0 },
        ];
        for r in touching {
            let set = RouteObstacles { inflated: vec![r], raw: vec![r] };
            assert_eq!(window_obstacles(&set, window).raw.len(), 1, "{r:?}");
        }
        let apart = Rect { x: 10.5, y: 0.0, w: 4.0, h: 4.0 };
        let set = RouteObstacles { inflated: vec![apart], raw: vec![apart] };
        assert!(window_obstacles(&set, window).raw.is_empty());
    }
}
