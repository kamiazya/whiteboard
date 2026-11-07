//! The side-choice search's incremental configuration score, ported from
//! `createConfigScore` in canvas-render's `spatial-edges.ts`: per-edge routed
//! paths, the pairwise score matrix and the aggregate cost, kept patchable
//! because a trial re-sides ONE edge, so only the edges whose anchors moved
//! re-route and re-score their pairs.
#![expect(clippy::float_cmp, reason = "the TypeScript compares with ===")]

use crate::edge_anchors::{
    AnchorContext, AnchorGroups, anchor_context, build_anchor_groups, compute_anchors_for,
    patch_anchor_groups, patch_work,
};
use crate::edge_crossing_sweep::{
    build_pairwise_scores, score_quantized_segment_pair, shared_corners,
};
use crate::edge_geometry::bounding_box_of;
use crate::edge_ink::diagonal_ink_through;
use crate::edge_router::{RouteRequest, RoutingStyle, route_edge};
use crate::edge_rules::{
    Cost, SidePair, ZERO_COST, accumulate_cost, add_cost, fully_contains, interior_ink_through,
    pair_penalty, self_penalty,
};
use crate::edge_sides::{EdgeAnchorOverride, EdgeAnchorPair};
use crate::geometry::{Point, Rect};
use crate::js_map::JsMap;
use crate::routing_budget::{PAIR_LOOKUP_VISITS, RoutingBudget, SearchShare};
use crate::routing_input::{EdgeId, RoutableEdge, RoutingNode, node_at_end};
use std::collections::BTreeMap;
use whiteboard_det::math::{js_max, js_min, js_round};

/// A count as the JavaScript number it is there.
#[expect(clippy::cast_precision_loss, reason = "counts are far below 2^53")]
const fn count(n: usize) -> f64 {
    n as f64
}

/// `COST_QUANTUM`, which `boundsOverlap` also reads as pixels.
const COST_QUANTUM: f64 = 4.0;

/// JavaScript's `ToInt32`, as an `Int32Array` store applies it: NaN and the
/// infinities are 0, anything else truncates and wraps modulo 2^32.
#[must_use]
pub fn to_int32(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    let wrapped = v.trunc().rem_euclid(4_294_967_296.0);
    let signed = if wrapped >= 2_147_483_648.0 { wrapped - 4_294_967_296.0 } else { wrapped };
    // `-0` stored in an Int32Array reads back as 0.
    signed + 0.0
}

/// A path's segments on the cost quantum, as `quantizedSegments`: x1 y1 x2
/// y2 then the bbox inflated by one quantum, every value stored as Int32.
fn quantized_segments(path: &[Point]) -> Vec<[f64; 8]> {
    path.windows(2)
        .filter_map(|w| match *w {
            [a, b] => {
                let (x1, y1) = (js_round(a.x * COST_QUANTUM), js_round(a.y * COST_QUANTUM));
                let (x2, y2) = (js_round(b.x * COST_QUANTUM), js_round(b.y * COST_QUANTUM));
                Some([
                    to_int32(x1),
                    to_int32(y1),
                    to_int32(x2),
                    to_int32(y2),
                    to_int32(js_min(x1, x2) - 1.0),
                    to_int32(js_min(y1, y2) - 1.0),
                    to_int32(js_max(x1, x2) + 1.0),
                    to_int32(js_max(y1, y2) + 1.0),
                ])
            }
            _ => None,
        })
        .collect()
}

/// One pair of paths' cost, as `pairScore`; `None`, spending nothing, when
/// `budget.pairs` cannot cover every segment pair of the two.
fn pair_score(a: &[Point], b: &[Point], budget: &mut RoutingBudget) -> Option<Cost> {
    let (qa, qb) = (quantized_segments(a), quantized_segments(b));
    #[expect(clippy::cast_precision_loss, reason = "segment counts are far below 2^53")]
    let examined = qa.len() as f64 * qb.len() as f64;
    if examined > budget.pairs {
        return None;
    }
    budget.pairs -= examined;
    let mut sum = [0.0; 3];
    for sa in &qa {
        for sb in &qb {
            if sa[4] > sb[6] || sb[4] > sa[6] || sa[5] > sb[7] || sb[5] > sa[7] {
                continue;
            }
            let [o, il, c] = score_quantized_segment_pair(
                [sa[0], sa[1], sa[2], sa[3]],
                [sb[0], sb[1], sb[2], sb[3]],
            );
            sum[0] += o;
            sum[1] += il;
            sum[2] += c;
        }
    }
    Some(pair_penalty([sum[0], sum[1], sum[2] + shared_corners(a, b)]))
}

/// A number as the TypeScript's template string prints it: `-0` as `0`,
/// every NaN alike, `undefined` apart from any number.
fn printed(v: Option<f64>) -> Option<u64> {
    v.map(|v| {
        if v.is_nan() {
            f64::NAN.to_bits()
        } else if v == 0.0 {
            0.0_f64.to_bits()
        } else {
            v.to_bits()
        }
    })
}

/// `routeCacheKey`: the edge plus every anchor field `routeEdge` reads, as
/// the printed string compares them.
type RouteKey = (EdgeId, [Option<u64>; 6], bool, [Option<u8>; 2]);

fn route_key(edge: &RoutableEdge, a: Option<&EdgeAnchorPair>) -> RouteKey {
    let a = a.copied().unwrap_or_default();
    let side = |s: Option<crate::edge_geometry::Side>| s.map(|s| s as u8);
    (
        edge.id,
        [
            printed(a.from.map(|p| p.x)),
            printed(a.from.map(|p| p.y)),
            printed(a.to.map(|p| p.x)),
            printed(a.to.map(|p| p.y)),
            printed(a.from_lane_depth),
            printed(a.to_lane_depth),
        ],
        a.around,
        [side(a.from_side), side(a.to_side)],
    )
}

/// Routed paths shared across the searches of one region.
pub type RouteCache = BTreeMap<RouteKey, Vec<Point>>;

/// Whether two anchor entries agree field by field with `===`, as `sameAnchor`.
fn same_anchor(a: Option<&EdgeAnchorPair>, b: Option<&EdgeAnchorPair>) -> bool {
    let numbers = |e: Option<&EdgeAnchorPair>| {
        let e = e.copied().unwrap_or_default();
        [
            e.from.map(|p| p.x),
            e.from.map(|p| p.y),
            e.to.map(|p| p.x),
            e.to.map(|p| p.y),
            e.from_lane_depth,
            e.to_lane_depth,
        ]
    };
    // `undefined === undefined`, and a number against `===`: NaN never equal.
    let equal = numbers(a).into_iter().zip(numbers(b)).all(|pair| match pair {
        (None, None) => true,
        (Some(x), Some(y)) => x == y,
        _ => false,
    });
    let (sa, sb) = (a.copied().unwrap_or_default(), b.copied().unwrap_or_default());
    equal && sa.from_side == sb.from_side && sa.to_side == sb.to_side && sa.around == sb.around
}

/// Two bounds that meet once each is inflated by a quantum, as `boundsOverlap`.
fn bounds_overlap(a: Rect, b: Rect) -> bool {
    a.x - COST_QUANTUM <= b.x + b.w
        && b.x - COST_QUANTUM <= a.x + a.w
        && a.y - COST_QUANTUM <= b.y + b.h
        && b.y - COST_QUANTUM <= a.y + a.h
}

/// One evaluated trial: its cost and everything adopting it carries over.
pub struct Trial {
    pub cost: Cost,
    anchors: JsMap<EdgeId, EdgeAnchorPair>,
    placement: AnchorGroups,
    paths: Vec<Vec<Point>>,
    bounds: Vec<Rect>,
    updates: JsMap<usize, Cost>,
    self_updates: Vec<(usize, Cost)>,
}

/// What a configuration is scored against, fixed for one search.
pub struct ScoreInputs<'a> {
    pub nodes: &'a [RoutingNode],
    pub labels: &'a [Rect],
    pub edges: &'a [RoutableEdge],
    /// One style per edge, by position.
    pub styles: &'a [RoutingStyle],
    pub align: bool,
    pub pins: Option<&'a JsMap<EdgeId, EdgeAnchorOverride>>,
}

/// The incremental score, as the object `createConfigScore` returns.
pub struct ConfigScore<'a> {
    inputs: ScoreInputs<'a>,
    ctx: AnchorContext<'a>,
    others_for: Vec<Vec<Rect>>,
    foreign_bodies_for: Vec<Vec<Rect>>,
    node_borders: Vec<Rect>,
    endpoint_rects_for: Vec<Vec<Rect>>,
    current: JsMap<EdgeId, SidePair>,
    placement: AnchorGroups,
    anchors: JsMap<EdgeId, EdgeAnchorPair>,
    paths: Vec<Vec<Point>>,
    bounds: Vec<Rect>,
    matrix: JsMap<usize, Cost>,
    self_costs: Vec<Cost>,
    current_cost: Cost,
    share: SearchShare,
    unpriced: bool,
}

/// One rect list per edge, by position.
type PerEdge = Vec<Vec<Rect>>;

/// The per-edge obstacle lists `createConfigScore` derives once.
fn obstacle_lists(inputs: &ScoreInputs<'_>) -> (PerEdge, PerEdge, PerEdge) {
    let ScoreInputs { nodes, labels, edges, .. } = *inputs;
    let others_for: Vec<Vec<Rect>> = edges
        .iter()
        .map(|e| {
            let (from, to) = (e.from.node(), e.to.node());
            nodes
                .iter()
                .filter(|n| Some(n.id) != from && Some(n.id) != to)
                .map(|n| n.rect)
                .collect()
        })
        .collect();
    let endpoint_rects_for: Vec<Vec<Rect>> = edges
        .iter()
        .map(|e| {
            [node_at_end(nodes, &e.from), node_at_end(nodes, &e.to)]
                .into_iter()
                .flatten()
                .map(|n| n.rect)
                .collect()
        })
        .collect();
    let foreign_bodies_for = others_for
        .iter()
        .zip(&endpoint_rects_for)
        .map(|(others, endpoints)| {
            others
                .iter()
                .copied()
                .filter(|&r| !endpoints.iter().any(|&end| fully_contains(r, end)))
                .chain(labels.iter().copied())
                .collect()
        })
        .collect();
    (others_for, foreign_bodies_for, endpoint_rects_for)
}

impl<'a> ConfigScore<'a> {
    /// `createConfigScore`: the incumbent's anchors, routes, self costs and
    /// pair matrix, priced at zero when the budget cannot build the matrix.
    pub fn new(
        inputs: ScoreInputs<'a>,
        initial: &JsMap<EdgeId, SidePair>,
        cache: &mut RouteCache,
        budget: &mut RoutingBudget,
    ) -> Self {
        let ctx = anchor_context(inputs.nodes, inputs.edges);
        let (others_for, foreign_bodies_for, endpoint_rects_for) = obstacle_lists(&inputs);
        let node_borders: Vec<Rect> = inputs.nodes.iter().map(|n| n.rect).collect();
        let placement = build_anchor_groups(&ctx, initial);
        let anchors =
            compute_anchors_for(&ctx, initial, inputs.align, inputs.pins, Some(placement.clone()));
        let mut score = Self {
            inputs,
            ctx,
            others_for,
            foreign_bodies_for,
            node_borders,
            endpoint_rects_for,
            current: initial.clone(),
            placement,
            anchors,
            paths: Vec::new(),
            bounds: Vec::new(),
            matrix: JsMap::default(),
            self_costs: Vec::new(),
            current_cost: ZERO_COST,
            share: SearchShare::default(),
            unpriced: false,
        };
        score.paths = (0..score.inputs.edges.len())
            .map(|i| {
                score.route_cached(i, score.anchors.get(&score.edge_id(i)).copied(), cache, budget)
            })
            .collect();
        score.bounds = score.paths.iter().map(|p| bounding_box_of(p)).collect();
        score.self_costs =
            score.paths.iter().enumerate().map(|(i, p)| score.self_cost(i, p)).collect();
        for c in &score.self_costs {
            score.current_cost = add_cost(&score.current_cost, c, 1.0);
        }
        match build_pairwise_scores(&score.paths, Some(budget)) {
            None => score.current_cost = ZERO_COST,
            Some(built) => {
                for (key, triple) in built.iter() {
                    let pair = pair_penalty(*triple);
                    score.matrix.set(*key, pair);
                    score.current_cost = add_cost(&score.current_cost, &pair, 1.0);
                }
            }
        }
        score
    }

    fn edge_id(&self, i: usize) -> EdgeId {
        self.inputs.edges.get(i).map_or(0, |e| e.id)
    }

    fn self_cost(&self, i: usize, path: &[Point]) -> Cost {
        let empty: &[Rect] = &[];
        self_penalty(
            path,
            self.foreign_bodies_for.get(i).map_or(empty, Vec::as_slice),
            &self.node_borders,
            self.endpoint_rects_for.get(i).map_or(empty, Vec::as_slice),
        )
    }

    /// `routeCached`: one edge routed through the region's shared cache.
    fn route_cached(
        &self,
        i: usize,
        anchors: Option<EdgeAnchorPair>,
        cache: &mut RouteCache,
        budget: &mut RoutingBudget,
    ) -> Vec<Point> {
        let Some(edge) = self.inputs.edges.get(i) else { return Vec::new() };
        let key = route_key(edge, anchors.as_ref());
        if let Some(hit) = cache.get(&key) {
            return hit.clone();
        }
        let style = self.inputs.styles.get(i).copied().unwrap_or(RoutingStyle::Straight);
        let request = RouteRequest {
            anchors: anchors.as_ref(),
            others: self.others_for.get(i).map(Vec::as_slice),
            budget: Some(budget),
            labels: self.inputs.labels,
        };
        let path = route_edge(self.inputs.nodes, edge, style, request).path;
        cache.insert(key, path.clone());
        path
    }

    /// The incumbent's sides, as `score.sides()`.
    #[must_use]
    pub const fn sides(&self) -> &JsMap<EdgeId, SidePair> {
        &self.current
    }

    /// The incumbent's cost, as `score.cost()`.
    #[must_use]
    pub const fn cost(&self) -> &Cost {
        &self.current_cost
    }

    /// Edge `i`'s own cost plus every pair it belongs to, as `contribution`.
    #[must_use]
    pub fn contribution(&self, i: usize) -> Cost {
        let n = self.inputs.edges.len();
        let mut cost = self.self_costs.get(i).copied().unwrap_or(ZERO_COST);
        for j in (0..n).filter(|&j| j != i) {
            let (lo, hi) = if i < j { (i, j) } else { (j, i) };
            if let Some(pair) = self.matrix.get(&lo.saturating_mul(n).saturating_add(hi)) {
                cost = add_cost(&cost, pair, 1.0);
            }
        }
        cost
    }

    /// Whether edge `i`'s current route runs through one of its own boxes.
    #[must_use]
    pub fn self_through(&self, i: usize) -> bool {
        let empty = Vec::new();
        let path = self.paths.get(i).unwrap_or(&empty);
        let ends = self.endpoint_rects_for.get(i).map_or(&[][..], Vec::as_slice);
        interior_ink_through(path, ends) + diagonal_ink_through(path, ends) > 0.0
    }

    /// Swaps every touched edge's self term for the new one, as `applySelfCosts`.
    fn apply_self_costs(
        &self,
        cost: &mut Cost,
        touched: &[usize],
        paths: &[Vec<Point>],
    ) -> Vec<(usize, Cost)> {
        touched
            .iter()
            .map(|&i| {
                let next = self.self_cost(i, paths.get(i).map_or(&[][..], Vec::as_slice));
                accumulate_cost(cost, self.self_costs.get(i).unwrap_or(&ZERO_COST), -1.0);
                accumulate_cost(cost, &next, 1.0);
                (i, next)
            })
            .collect()
    }

    /// One pair's term swapped for its new one, as `rescorePairInto`.
    fn rescore_pair_into(
        &mut self,
        cost: &mut Cost,
        (key, lo, hi): (usize, usize, usize),
        (paths, bounds): (&[Vec<Point>], &[Rect]),
        updates: &mut JsMap<usize, Cost>,
        budget: &mut RoutingBudget,
    ) {
        if self.unpriced {
            return;
        }
        let (Some(&bl), Some(&bh)) = (bounds.get(lo), bounds.get(hi)) else { return };
        if !bounds_overlap(bl, bh) {
            if let Some(prior) = self.matrix.get(&key) {
                accumulate_cost(cost, prior, -1.0);
                updates.set(key, ZERO_COST);
            }
            return;
        }
        let (Some(pl), Some(ph)) = (paths.get(lo), paths.get(hi)) else { return };
        let Some(next) = pair_score(pl, ph, budget) else {
            self.unpriced = true;
            return;
        };
        accumulate_cost(cost, self.matrix.get(&key).unwrap_or(&ZERO_COST), -1.0);
        accumulate_cost(cost, &next, 1.0);
        updates.set(key, next);
    }

    /// Every pair a touched edge belongs to, each visited once, as `applyPairCosts`.
    fn apply_pair_costs(
        &mut self,
        cost: &mut Cost,
        touched: &[usize],
        trial: (&[Vec<Point>], &[Rect]),
        budget: &mut RoutingBudget,
    ) -> JsMap<usize, Cost> {
        let n = self.inputs.edges.len();
        let mut updates = JsMap::default();
        self.unpriced = false;
        for &i in touched {
            for j in (0..n).filter(|&j| j != i) {
                let (lo, hi) = if i < j { (i, j) } else { (j, i) };
                let key = lo.saturating_mul(n).saturating_add(hi);
                // The second test only saves work: a touched pair's first visit
                // either records an update or proves the pair scores nothing.
                if updates.has(&key) || (touched.contains(&j) && j < i) {
                    continue;
                }
                self.rescore_pair_into(cost, (key, lo, hi), trial, &mut updates, budget);
            }
        }
        updates
    }

    /// The trial re-siding edge `index`, priced; `None` when the `trials` or
    /// `pairs` account refuses part of it, as `evaluateTrial`.
    pub fn evaluate_trial(
        &mut self,
        trial: &JsMap<EdgeId, SidePair>,
        index: usize,
        cache: &mut RouteCache,
        budget: &mut RoutingBudget,
    ) -> Option<Trial> {
        let (nodes, edges) = (self.inputs.nodes.len(), self.inputs.edges.len());
        let work = count(patch_work(&self.ctx, &self.placement, trial, index)) + count(edges);
        if !self.share.take(budget, work) {
            return None;
        }
        let placement = patch_anchor_groups(&self.ctx, &self.placement, trial, index);
        let anchors = compute_anchors_for(
            &self.ctx,
            trial,
            self.inputs.align,
            self.inputs.pins,
            Some(placement.clone()),
        );
        let touched: Vec<usize> = (0..edges)
            .filter(|&i| {
                !same_anchor(self.anchors.get(&self.edge_id(i)), anchors.get(&self.edge_id(i)))
            })
            .collect();
        let lookups = count(nodes) + PAIR_LOOKUP_VISITS * count(edges);
        if !self.share.take(budget, count(touched.len()) * lookups) {
            return None;
        }
        let (mut paths, mut bounds) = (self.paths.clone(), self.bounds.clone());
        let mut scoring = 0.0;
        for &i in &touched {
            let path = self.route_cached(i, anchors.get(&self.edge_id(i)).copied(), cache, budget);
            scoring += count(path.len().saturating_sub(1)) * count(nodes);
            if let (Some(b), Some(p)) = (bounds.get_mut(i), paths.get_mut(i)) {
                *b = bounding_box_of(&path);
                *p = path;
            }
        }
        if !self.share.take(budget, scoring) {
            return None;
        }
        let mut cost = self.current_cost;
        let self_updates = self.apply_self_costs(&mut cost, &touched, &paths);
        let updates = self.apply_pair_costs(&mut cost, &touched, (&paths, &bounds), budget);
        if self.unpriced {
            return None;
        }
        Some(Trial { cost, anchors, placement, paths, bounds, updates, self_updates })
    }

    /// Makes the trial the incumbent, as `adopt`.
    pub fn adopt(&mut self, sides: JsMap<EdgeId, SidePair>, trial: Trial) {
        self.current = sides;
        self.current_cost = trial.cost;
        self.anchors = trial.anchors;
        self.placement = trial.placement;
        self.paths = trial.paths;
        self.bounds = trial.bounds;
        for (key, score) in trial.updates.iter() {
            self.matrix.set(*key, *score);
        }
        for (i, score) in trial.self_updates {
            if let Some(slot) = self.self_costs.get_mut(i) {
                *slot = score;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{pair_score, to_int32};
    use crate::geometry::Point;
    use crate::routing_budget::RoutingBudget;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn to_int32_wraps_as_an_int32_array_stores() {
        assert_eq!(to_int32(f64::NAN), 0.0);
        assert_eq!(to_int32(f64::INFINITY), 0.0);
        assert_eq!(to_int32(-1.5), -1.0);
        assert_eq!(to_int32(2_147_483_648.0), -2_147_483_648.0);
        assert_eq!(to_int32(4_294_967_297.0), 1.0);
        assert!(to_int32(-0.0).is_sign_positive());
    }

    #[test]
    fn pair_score_takes_an_account_that_exactly_covers_it() {
        let p = |x: f64, y: f64| Point { x, y };
        let a = [p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0)];
        let b = [p(5.0, -5.0), p(5.0, 5.0)];
        let mut budget = RoutingBudget { pairs: 2.0, ..RoutingBudget::for_layout() };
        assert!(pair_score(&a, &b, &mut budget).is_some());
        assert_eq!(budget.pairs, 0.0);
        let mut short = RoutingBudget { pairs: 1.0, ..RoutingBudget::for_layout() };
        assert!(pair_score(&a, &b, &mut short).is_none());
        assert_eq!(short.pairs, 1.0);
    }
}
