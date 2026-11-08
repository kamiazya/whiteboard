//! The coincident-ends repair, ported from canvas-render's
//! `coincident-ends.ts` and the `anchorsWithoutCoincidentEnds` pass in
//! `spatial-edges.ts` that drives it: an edge whose two anchors land on one
//! point (a member flush with the border of the box holding it) is re-sided
//! onto the side pair that routes best, so no connection is drawn as a dot.
#![expect(clippy::float_cmp, reason = "the TypeScript compares with ===")]

use crate::edge_anchors::{
    AnchorContext, AnchorGroups, anchor_context, build_anchor_groups, compute_anchors_for,
    patch_anchor_groups, patch_work,
};
use crate::edge_geometry::{center_of, path_length};
use crate::edge_router::{RouteRequest, RoutingStyle, route_edge};
use crate::edge_rules::{
    PreferenceContext, SidePair, bend_count, compose_side_pairs, interior_ink_through,
};
use crate::edge_sides::{EdgeAnchorOverride, EdgeAnchorPair};
use crate::geometry::{Point, Rect};
use crate::js_map::JsMap;
use crate::routing_budget::{Account, RoutingBudget, spend};
use crate::routing_input::{EdgeId, RoutableEdge, RoutingNode, node_at_end};
use whiteboard_det::math::hypot;

/// An arrowhead's own length: a final segment shorter than this paints an
/// arrow with no line under it.
const ARROW_RUNWAY_PX: f64 = 10.0;

/// One candidate's tier, bends and length, as `RepairScore`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct RepairScore {
    pair: SidePair,
    tier: u8,
    bends: f64,
    length: f64,
}

/// What a repair search found, as `bestRepairedPair`'s three answers.
enum Repair {
    /// The `repairs` account ran out.
    Exhausted,
    /// No candidate leaves the ends apart.
    Unreached,
    Found(RepairScore, AnchorGroups),
}

/// Whether an edge's two anchors are one point, as `coincides`.
fn coincides(anchors: &JsMap<EdgeId, EdgeAnchorPair>, id: EdgeId) -> bool {
    anchors
        .get(&id)
        .and_then(|a| Some((a.from?, a.to?)))
        .is_some_and(|(from, to)| from.x == to.x && from.y == to.y)
}

/// One candidate route's tier, bends and length, as `scoreRepairedRoute`.
fn score_repaired_route(
    pair: SidePair,
    path: &[Point],
    from_rect: Rect,
    to_rect: Rect,
) -> RepairScore {
    let runway = match path {
        [.., before, tail] => hypot(tail.x - before.x, tail.y - before.y),
        _ => 0.0,
    };
    let clean = interior_ink_through(path, &[from_rect, to_rect]) == 0.0;
    let tier = match (clean, runway >= ARROW_RUNWAY_PX) {
        (true, true) => 0,
        (true, false) => 1,
        (false, _) => 2,
    };
    RepairScore { pair, tier, bends: bend_count(path), length: path_length(path) }
}

/// Tier first, then fewer bends, then shorter, as `betterRepair`.
fn better_repair(a: &RepairScore, b: &RepairScore) -> bool {
    if a.tier != b.tier {
        return a.tier < b.tier;
    }
    if a.bends != b.bends {
        return a.bends < b.bends;
    }
    a.length < b.length
}

/// What every candidate of one repair is scored against.
struct RepairContext<'a> {
    nodes: &'a [RoutingNode],
    labels: &'a [Rect],
    anchors: &'a AnchorContext<'a>,
    edge_count: usize,
    align: bool,
    pins: Option<&'a JsMap<EdgeId, EdgeAnchorOverride>>,
    style_of: &'a dyn Fn(&RoutableEdge) -> RoutingStyle,
}

/// The best side pair among `candidates` for a collided edge, as
/// `bestRepairedPair`: every candidate is scored, and the best kept.
fn best_repaired_pair(
    candidates: &[SidePair],
    (edge, edge_index): (&RoutableEdge, usize),
    rc: &RepairContext<'_>,
    (repaired, placement): (&JsMap<EdgeId, SidePair>, &AnchorGroups),
    (from_rect, to_rect): (Rect, Rect),
    budget: &mut RoutingBudget,
) -> Repair {
    let mut best: Option<(RepairScore, AnchorGroups)> = None;
    for pair in candidates {
        let sided = SidePair {
            from_side: edge.from.side().unwrap_or(pair.from_side),
            to_side: edge.to.side().unwrap_or(pair.to_side),
            around: false,
        };
        let mut trial = repaired.clone();
        trial.set(edge.id, sided);
        let work =
            patch_work(rc.anchors, placement, &trial, edge_index).saturating_add(rc.edge_count);
        #[expect(clippy::cast_precision_loss, reason = "a work count is far below 2^53")]
        let charge = work.saturating_add(rc.nodes.len()) as f64;
        if !spend(budget, Account::Repairs, charge) {
            return Repair::Exhausted;
        }
        let trial_placement = patch_anchor_groups(rc.anchors, placement, &trial, edge_index);
        let trial_anchors = compute_anchors_for(
            rc.anchors,
            &trial,
            rc.align,
            rc.pins,
            Some(trial_placement.clone()),
        );
        if coincides(&trial_anchors, edge.id) {
            continue;
        }
        let request = RouteRequest {
            anchors: trial_anchors.get(&edge.id),
            others: None,
            budget: Some(&mut *budget),
            labels: rc.labels,
        };
        let routed = route_edge(rc.nodes, edge, (rc.style_of)(edge), request);
        let scored = score_repaired_route(sided, &routed.path, from_rect, to_rect);
        if best.as_ref().is_none_or(|(b, _)| better_repair(&scored, b)) {
            best = Some((scored, trial_placement));
        }
    }
    best.map_or(Repair::Unreached, |(score, placement)| Repair::Found(score, placement))
}

/// Re-sides each collided edge in turn onto its best pair, as the loop in
/// `anchorsWithoutCoincidentEnds`, and answers the side map it leaves.
fn repair_collided(
    collided: &[&RoutableEdge],
    edges: &[RoutableEdge],
    rc: &RepairContext<'_>,
    (mut repaired, mut placement): (JsMap<EdgeId, SidePair>, AnchorGroups),
    budget: &mut RoutingBudget,
) -> JsMap<EdgeId, SidePair> {
    for &edge in collided {
        let (Some(from), Some(to)) =
            (node_at_end(rc.nodes, &edge.from), node_at_end(rc.nodes, &edge.to))
        else {
            continue;
        };
        let (from_rect, to_rect) = (from.rect, to.rect);
        let (fc, tc) = (center_of(from_rect), center_of(to_rect));
        let candidates = compose_side_pairs(&PreferenceContext {
            dx: tc.x - fc.x,
            dy: tc.y - fc.y,
            from_rect,
            to_rect,
            crowd: &|_, _| 0.0,
        });
        // `new Map(edges.map((e, i) => [e.id, i]))`: a repeated id answers its last index.
        let edge_index = edges.iter().rposition(|e| e.id == edge.id).unwrap_or(0);
        match best_repaired_pair(
            &candidates,
            (edge, edge_index),
            rc,
            (&repaired, &placement),
            (from_rect, to_rect),
            budget,
        ) {
            // The account is spent, and the rest keep their collided pairs,
            // as the TypeScript's. A `continue` would answer the same: an
            // exhausted edge loses even its best, so a later edge would need
            // EVERY one of its candidates to fit in less than one of this
            // edge's charges, which differ by a few re-placed ends.
            Repair::Exhausted => break,
            Repair::Unreached => {}
            Repair::Found(score, best) => {
                repaired.set(edge.id, score.pair);
                placement = best;
            }
        }
    }
    repaired
}

/// The routing pass's inputs beyond the nodes and edges.
pub struct CoincidentRequest<'a> {
    pub labels: &'a [Rect],
    pub style_of: &'a dyn Fn(&RoutableEdge) -> RoutingStyle,
    pub align: bool,
    pub pins: Option<&'a JsMap<EdgeId, EdgeAnchorOverride>>,
}

/// The anchors for `sides`, with every edge whose two ends coincide
/// re-sided onto the pair that routes best, as `anchorsWithoutCoincidentEnds`.
/// An edge naming both of its sides is left exactly as authored.
#[must_use]
pub fn anchors_without_coincident_ends(
    nodes: &[RoutingNode],
    edges: &[RoutableEdge],
    sides: &JsMap<EdgeId, SidePair>,
    request: &CoincidentRequest<'_>,
    budget: &mut RoutingBudget,
) -> JsMap<EdgeId, EdgeAnchorPair> {
    let ctx = anchor_context(nodes, edges);
    let placement = build_anchor_groups(&ctx, sides);
    let anchors =
        compute_anchors_for(&ctx, sides, request.align, request.pins, Some(placement.clone()));
    let collided: Vec<&RoutableEdge> = edges
        .iter()
        .filter(|edge| {
            !edge.is_self_loop()
                && (edge.from.side().is_none() || edge.to.side().is_none())
                && coincides(&anchors, edge.id)
        })
        .collect();
    if collided.is_empty() {
        return anchors;
    }
    let rc = RepairContext {
        nodes,
        labels: request.labels,
        anchors: &ctx,
        edge_count: edges.len(),
        align: request.align,
        pins: request.pins,
        style_of: request.style_of,
    };
    let repaired = repair_collided(&collided, edges, &rc, (sides.clone(), placement), budget);
    compute_anchors_for(&ctx, &repaired, request.align, request.pins, None)
}

#[cfg(test)]
mod tests {
    use super::{CoincidentRequest, anchors_without_coincident_ends, score_repaired_route};
    use crate::edge_geometry::Side;
    use crate::edge_router::RoutingStyle;
    use crate::edge_rules::SidePair;
    use crate::geometry::{Point, Rect};
    use crate::js_map::JsMap;
    use crate::routing_budget::RoutingBudget;
    use crate::routing_input::{RoutableEdge, RoutingEnd, RoutingNode};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    /// Two boxes sharing a border, an edge sided across it: both anchors land
    /// on the one point, and the repair re-sides the edge so they part. The
    /// native tests reach the repair here rather than only when a generated
    /// board happens to, so the crate's coverage does not move with the draw.
    #[test]
    fn an_edge_whose_ends_coincide_is_re_sided_until_they_part() {
        let nodes = [
            RoutingNode { id: 0, rect: Rect { x: 0.0, y: 0.0, w: 100.0, h: 50.0 } },
            RoutingNode { id: 1, rect: Rect { x: 100.0, y: 0.0, w: 100.0, h: 50.0 } },
        ];
        let end = |node| RoutingEnd::Node { node, side: None, arrowhead: None };
        let edges = [RoutableEdge { id: 7, from: end(0), to: end(1), bends: None }];
        let across = SidePair { from_side: Side::Right, to_side: Side::Left, around: false };
        let sides: JsMap<_, _> = [(7, across)].into_iter().collect();
        let style_of = |_: &RoutableEdge| RoutingStyle::Orthogonal;
        let request =
            CoincidentRequest { labels: &[], style_of: &style_of, align: false, pins: None };
        let mut budget = RoutingBudget::for_layout();
        let anchors =
            anchors_without_coincident_ends(&nodes, &edges, &sides, &request, &mut budget);
        let pair = anchors.get(&7).copied().unwrap_or_default();
        assert!(pair.from.is_some() && pair.to.is_some());
        assert_ne!(pair.from, pair.to);
        assert_ne!((pair.from_side, pair.to_side), (Some(Side::Right), Some(Side::Left)));
    }

    /// A clean route keeps tier 0 with a final segment exactly the
    /// arrowhead's length and drops to tier 1 just short of it: no
    /// generated draw lands a final segment between 10 and 11 pixels.
    #[test]
    fn the_arrow_runway_is_inclusive_at_its_length() {
        let pair = SidePair { from_side: Side::Right, to_side: Side::Left, around: false };
        let far = Rect { x: 1000.0, y: 1000.0, w: 1.0, h: 1.0 };
        let route = |tail: f64| {
            let path =
                [Point { x: 0.0, y: 0.0 }, Point { x: 50.0, y: 0.0 }, Point { x: 50.0, y: tail }];
            score_repaired_route(pair, &path, far, far).tier
        };
        // The TypeScript's ARROW_RUNWAY_PX, as a literal so the constant is pinned too.
        assert_eq!(route(10.0), 0);
        assert_eq!(route(9.5), 1);
    }
}
