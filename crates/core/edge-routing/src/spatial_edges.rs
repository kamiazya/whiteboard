//! The side-choice search, ported from canvas-render's `spatial-edges.ts`:
//! which sides every edge leaves from and arrives at, chosen together so the
//! routes cross, overlap and retrace as little as the cost model prices. It
//! runs twice per region (unaligned, then a repair over the drawn geometry)
//! and over Morton-ordered regions past the edge gate. `assign_edge_anchors`
//! is the entry point.

use crate::coincident_ends::{CoincidentRequest, anchors_without_coincident_ends};
use crate::config_score::{ConfigScore, RouteCache, ScoreInputs};
use crate::edge_contact::marks_contact;
use crate::edge_geometry::{center_of, midpoint_extent};
use crate::edge_router::RoutingStyle;
use crate::edge_rules::{
    PreferenceContext, SidePair, compose_side_pairs, has_repairable_problem, less_cost,
};
use crate::edge_sides::{EdgeAnchorOverride, EdgeAnchorPair, initial_side_choices};
use crate::geometry::{Point, Rect};
use crate::js_map::JsMap;
use crate::routing_budget::RoutingBudget;
use crate::routing_input::{EdgeId, RoutableEdge, RoutingNode, node_at_end};
use std::collections::{BTreeMap, BTreeSet};
use whiteboard_det::math::{compare_numbers, js_max, js_min};

/// The search's edge gate, and the size of a region past it.
const CROSSING_OPT_MAX_EDGES: usize = 200;
const CROSSING_OPT_MAX_PASSES: usize = 2;
/// At or under this many edges every edge tries candidates.
const FULL_OPT_MAX_EDGES: usize = 40;
/// How many worst-offender edges try candidates per pass above it.
const TRIAL_BUDGET_EDGES: usize = 16;

/// A set of edges by id, as the TypeScript's `Set<string>`.
pub type EdgeSet = BTreeSet<EdgeId>;

/// What one search reads beside the side map: the edges with one style
/// each, by position.
#[derive(Clone, Copy)]
pub struct SearchInputs<'a> {
    pub nodes: &'a [RoutingNode],
    pub labels: &'a [Rect],
    pub edges: &'a [RoutableEdge],
    pub styles: &'a [RoutingStyle],
}

impl SearchInputs<'_> {
    fn style(&self, i: usize) -> RoutingStyle {
        self.styles.get(i).copied().unwrap_or(RoutingStyle::Straight)
    }
}

/// The ranked alternative pairs a trial may re-side `edge` onto, as
/// `sideCandidatesFor`; empty for a self-loop, an authored pair it does not
/// overrule, or a dangling end.
fn side_candidates_for(
    edge: &RoutableEdge,
    nodes: &[RoutingNode],
    overrule: bool,
) -> Vec<SidePair> {
    if edge.is_self_loop() {
        return Vec::new();
    }
    let (named_from, named_to) = (edge.from.side(), edge.to.side());
    if named_from.is_some() && named_to.is_some() && !overrule {
        return Vec::new();
    }
    let (Some(from), Some(to)) = (node_at_end(nodes, &edge.from), node_at_end(nodes, &edge.to))
    else {
        return Vec::new();
    };
    let (fc, tc) = (center_of(from.rect), center_of(to.rect));
    let crowd = |_: crate::edge_rules::End, _: crate::edge_geometry::Side| 0.0;
    let ctx = PreferenceContext {
        dx: tc.x - fc.x,
        dy: tc.y - fc.y,
        from_rect: from.rect,
        to_rect: to.rect,
        crowd: &crowd,
    };
    let keep = !overrule;
    let mut seen = BTreeSet::new();
    compose_side_pairs(&ctx)
        .into_iter()
        .map(|p| SidePair {
            from_side: named_from.filter(|_| keep).unwrap_or(p.from_side),
            to_side: named_to.filter(|_| keep).unwrap_or(p.to_side),
            around: false,
        })
        .filter(|p| seen.insert((p.from_side as u8, p.to_side as u8)))
        .collect()
}

/// A straight edge's candidates, then each once more stepping round, as
/// `andSteppingRound`.
fn and_stepping_round(pairs: Vec<SidePair>, chosen: SidePair) -> Vec<SidePair> {
    let sided = if pairs.is_empty() { vec![chosen] } else { pairs.clone() };
    let around = sided.into_iter().map(|p| SidePair { around: true, ..p });
    pairs.into_iter().chain(around).collect()
}

/// Which `around`s the search confirmed, as `aroundLedger`.
struct AroundLedger<'a> {
    seeded: &'a EdgeSet,
    confirmed: EdgeSet,
}

impl AroundLedger<'_> {
    fn adopted(&mut self, id: EdgeId, pair: SidePair) {
        if pair.around {
            self.confirmed.insert(id);
        }
    }

    /// `sides` with every seeded, unconfirmed `around` cleared.
    fn unconfirmed_dropped(&self, sides: &JsMap<EdgeId, SidePair>) -> JsMap<EdgeId, SidePair> {
        let mut dropped = sides.clone();
        for (id, pair) in sides.iter() {
            if !pair.around || !self.seeded.contains(id) || self.confirmed.contains(id) {
                continue;
            }
            dropped.set(*id, SidePair { around: false, ..*pair });
        }
        dropped
    }
}

/// The positions one pass tries candidates for, as `trialEdgesFor`.
fn trial_edges_for(score: &ConfigScore<'_>, edges: usize, align: bool) -> Vec<usize> {
    if !align && edges <= FULL_OPT_MAX_EDGES {
        return (0..edges).collect();
    }
    let mut ranked: Vec<_> = (0..edges)
        .map(|i| (i, score.contribution(i)))
        .filter(|(_, cost)| has_repairable_problem(cost))
        .collect();
    ranked.sort_by(|(ai, a), (bi, b)| {
        if less_cost(a, b) {
            std::cmp::Ordering::Greater
        } else if less_cost(b, a) {
            std::cmp::Ordering::Less
        } else {
            ai.cmp(bi)
        }
    });
    // Document order within the budget keeps adoption sequencing stable.
    let picked: BTreeSet<usize> =
        ranked.into_iter().take(TRIAL_BUDGET_EDGES).map(|r| r.0).collect();
    picked.into_iter().collect()
}

/// Each edge still stepping round tries its corner route on the same sides
/// and takes it unless that costs something, as `shortened`.
fn shortened(
    score: &mut ConfigScore<'_>,
    run: &mut Run<'_, '_>,
    ledger: &mut AroundLedger<'_>,
) -> JsMap<EdgeId, SidePair> {
    let edges = run.inputs.edges;
    for (index, edge) in edges.iter().enumerate() {
        let Some(chosen) = score.sides().get(&edge.id).copied() else { continue };
        if !chosen.around || run.locked.is_some_and(|l| l.contains(&edge.id)) {
            continue;
        }
        let mut trial = score.sides().clone();
        trial.set(edge.id, SidePair { around: false, ..chosen });
        let Some(evaluated) = score.evaluate_trial(&trial, index, run.cache, run.budget) else {
            return ledger.unconfirmed_dropped(score.sides());
        };
        if less_cost(score.cost(), &evaluated.cost) {
            ledger.confirmed.insert(edge.id);
        } else {
            score.adopt(trial, evaluated);
        }
    }
    score.sides().clone()
}

/// One search's fixed arguments beside the side map, as
/// `optimizeSideChoices` takes them.
struct Run<'a, 'b> {
    inputs: SearchInputs<'a>,
    locked: Option<&'a EdgeSet>,
    align: bool,
    pins: Option<&'a JsMap<EdgeId, EdgeAnchorOverride>>,
    cache: &'b mut RouteCache,
    budget: &'b mut RoutingBudget,
}

enum Outcome {
    Adopted,
    Kept,
    Exhausted,
}

/// Tries every candidate for one edge, adopting the first strict
/// improvement, as `improveEdge`.
fn improve_edge(
    score: &mut ConfigScore<'_>,
    run: &mut Run<'_, '_>,
    (edge, position, index): (&RoutableEdge, usize, usize),
    ledger: &mut AroundLedger<'_>,
) -> Outcome {
    let Some(chosen) = score.sides().get(&edge.id).copied() else { return Outcome::Kept };
    let named = edge.from.side().is_some() && edge.to.side().is_some();
    let pairs = side_candidates_for(edge, run.inputs.nodes, named && score.self_through(index));
    // `styleOf(edge)`: the edge's own style, where a repeated id's index is its last.
    let straight = run.inputs.style(position) == RoutingStyle::Straight;
    let candidates =
        if straight && !edge.is_self_loop() { and_stepping_round(pairs, chosen) } else { pairs };
    for candidate in candidates {
        if candidate == chosen {
            continue;
        }
        let mut trial = score.sides().clone();
        trial.set(edge.id, candidate);
        let Some(evaluated) = score.evaluate_trial(&trial, index, run.cache, run.budget) else {
            return Outcome::Exhausted;
        };
        if less_cost(&evaluated.cost, score.cost()) {
            score.adopt(trial, evaluated);
            ledger.adopted(edge.id, candidate);
            return Outcome::Adopted;
        }
    }
    Outcome::Kept
}

/// Bounded global improvement over per-edge side choices, as
/// `optimizeSideChoices`: an alternative is adopted only when the whole
/// configuration's cost strictly decreases.
fn optimize_side_choices(
    run: &mut Run<'_, '_>,
    initial: &JsMap<EdgeId, SidePair>,
    seeded: &EdgeSet,
) -> JsMap<EdgeId, SidePair> {
    let inputs = run.inputs;
    let score_inputs = ScoreInputs {
        nodes: inputs.nodes,
        labels: inputs.labels,
        edges: inputs.edges,
        styles: inputs.styles,
        align: run.align,
        pins: run.pins,
    };
    let mut score = ConfigScore::new(score_inputs, initial, run.cache, run.budget);
    // `new Map(edges.map((e, i) => [e.id, i]))`: a repeated id keeps its last index.
    let index_by_id: BTreeMap<EdgeId, usize> =
        inputs.edges.iter().enumerate().map(|(i, e)| (e.id, i)).collect();
    let mut ledger = AroundLedger { seeded, confirmed: EdgeSet::new() };
    if !has_repairable_problem(score.cost()) {
        return shortened(&mut score, run, &mut ledger);
    }
    for _ in 0..CROSSING_OPT_MAX_PASSES {
        let mut improved = false;
        for position in trial_edges_for(&score, inputs.edges.len(), run.align) {
            let Some(edge) = inputs.edges.get(position) else { continue };
            let outcome = if run.locked.is_some_and(|l| l.contains(&edge.id)) {
                Outcome::Kept
            } else {
                let index = index_by_id.get(&edge.id).copied().unwrap_or(position);
                improve_edge(&mut score, run, (edge, position, index), &mut ledger)
            };
            match outcome {
                Outcome::Exhausted => return ledger.unconfirmed_dropped(score.sides()),
                Outcome::Adopted => improved = true,
                Outcome::Kept => {}
            }
            if !has_repairable_problem(score.cost()) {
                return shortened(&mut score, run, &mut ledger);
            }
        }
        if !improved {
            break;
        }
    }
    shortened(&mut score, run, &mut ledger)
}

/// `seed` with every free straight edge stepping round, and the edges that
/// were, as `steppingRound`.
fn stepping_round(
    seed: &JsMap<EdgeId, SidePair>,
    inputs: SearchInputs<'_>,
    locked: Option<&EdgeSet>,
) -> (JsMap<EdgeId, SidePair>, EdgeSet) {
    let mut around = seed.clone();
    let mut seeded = EdgeSet::new();
    for (i, edge) in inputs.edges.iter().enumerate() {
        let Some(pair) = seed.get(&edge.id).copied() else { continue };
        if locked.is_some_and(|l| l.contains(&edge.id)) || inputs.style(i) != RoutingStyle::Straight
        {
            continue;
        }
        around.set(edge.id, SidePair { around: true, ..pair });
        seeded.insert(edge.id);
    }
    (around, seeded)
}

/// What every region's two runs share.
struct RegionArgs<'a> {
    nodes: &'a [RoutingNode],
    labels: &'a [Rect],
    locked: Option<&'a EdgeSet>,
    pins: Option<&'a JsMap<EdgeId, EdgeAnchorOverride>>,
}

/// One region's unaligned run from its stepping-round seed, then the aligned
/// repair, over one route cache, as `bothRuns`.
fn both_runs(
    args: &RegionArgs<'_>,
    (edges, styles): (&[RoutableEdge], &[RoutingStyle]),
    seed: &JsMap<EdgeId, SidePair>,
    budget: &mut RoutingBudget,
) -> JsMap<EdgeId, SidePair> {
    let inputs = SearchInputs { nodes: args.nodes, labels: args.labels, edges, styles };
    let mut cache = RouteCache::new();
    let (stepping, seeded) = stepping_round(seed, inputs, args.locked);
    let mut run =
        Run { inputs, locked: args.locked, align: false, pins: None, cache: &mut cache, budget };
    let unaligned = optimize_side_choices(&mut run, &stepping, &seeded);
    run.align = true;
    run.pins = args.pins;
    optimize_side_choices(&mut run, &unaligned, &EdgeSet::new())
}

/// Spreads ten bits so x and y weave into one 20-bit Morton key.
const fn interleave(v: u32) -> u32 {
    let mut x = v & 0x3ff;
    x = (x | (x << 16)) & 0x0300_00ff;
    x = (x | (x << 8)) & 0x0300_f00f;
    x = (x | (x << 4)) & 0x030c_30c3;
    (x | (x << 2)) & 0x0924_9249
}

#[expect(clippy::manual_midpoint, reason = "the TypeScript's (a + b) / 2, overflow and all")]
/// Each edge's Morton key over its endpoints' centres' midpoint.
fn morton_keys(nodes: &[RoutingNode], edges: &[RoutableEdge]) -> Vec<u32> {
    const GRID: f64 = 1024.0;
    let midpoints: Vec<Point> = edges
        .iter()
        .map(|edge| match (node_at_end(nodes, &edge.from), node_at_end(nodes, &edge.to)) {
            (Some(from), Some(to)) => {
                let (a, b) = (center_of(from.rect), center_of(to.rect));
                Point { x: (a.x + b.x) / 2.0, y: (a.y + b.y) / 2.0 }
            }
            _ => Point { x: 0.0, y: 0.0 },
        })
        .collect();
    let extent = midpoint_extent(&midpoints);
    let cell = |v: f64, origin: f64, span: f64| {
        let g = js_min(GRID - 1.0, js_max(0.0, (((v - origin) / span) * (GRID - 1.0)).floor()));
        #[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "0..=1023")]
        let g = g as u32;
        interleave(g)
    };
    midpoints
        .iter()
        .map(|m| {
            if !m.x.is_finite() || !m.y.is_finite() {
                return 0;
            }
            let gx = cell(m.x, extent.origin_x, extent.span_x);
            gx | (cell(m.y, extent.origin_y, extent.span_y) << 1)
        })
        .collect()
}

/// Side choices for a canvas of any size, as `optimizeAcrossRegions`: the
/// two runs directly within the gate, else over even Morton-ordered regions.
fn optimize_across_regions(
    args: &RegionArgs<'_>,
    (edges, styles): (&[RoutableEdge], &[RoutingStyle]),
    initial: &JsMap<EdgeId, SidePair>,
    budget: &mut RoutingBudget,
) -> JsMap<EdgeId, SidePair> {
    if edges.len() <= CROSSING_OPT_MAX_EDGES {
        return both_runs(args, (edges, styles), initial, budget);
    }
    let keys = morton_keys(args.nodes, edges);
    let mut ordered: Vec<usize> = (0..edges.len()).collect();
    ordered.sort_by(|&a, &b| {
        let key = |i: usize| f64::from(keys.get(i).copied().unwrap_or(0));
        #[expect(clippy::cast_precision_loss, reason = "edge positions are far below 2^53")]
        let pos = |i: usize| i as f64;
        compare_numbers(key(a), key(b)).then(compare_numbers(pos(a), pos(b)))
    });
    let region_size = edges.len().div_ceil(edges.len().div_ceil(CROSSING_OPT_MAX_EDGES));
    let mut settled = initial.clone();
    for chunk in ordered.chunks(region_size) {
        // Unreachable past the gate, where the last region holds at least a
        // hundred edges; kept because the TypeScript has it.
        if chunk.len() < 2 {
            continue;
        }
        let region: Vec<RoutableEdge> =
            chunk.iter().filter_map(|&i| edges.get(i).cloned()).collect();
        let region_styles: Vec<RoutingStyle> = chunk
            .iter()
            .map(|&i| styles.get(i).copied().unwrap_or(RoutingStyle::Straight))
            .collect();
        let mut seed = JsMap::default();
        for edge in &region {
            if let Some(pair) = settled.get(&edge.id).copied() {
                seed.set(edge.id, pair);
            }
        }
        for (id, pair) in both_runs(args, (&region, &region_styles), &seed, budget).iter() {
            settled.set(*id, *pair);
        }
    }
    settled
}

/// `sides` with each overridden edge's frozen pair (a side the edge names
/// itself still wins), and the edges that froze, as `withOverrides`.
fn with_overrides(
    sides: &JsMap<EdgeId, SidePair>,
    edges: &[RoutableEdge],
    overrides: &JsMap<EdgeId, EdgeAnchorOverride>,
) -> (JsMap<EdgeId, SidePair>, EdgeSet) {
    let mut merged = sides.clone();
    let mut locked = EdgeSet::new();
    for (id, pin) in overrides.iter() {
        let Some(edge) = edges.iter().find(|e| e.id == *id) else { continue };
        if !merged.has(id) {
            continue;
        }
        let pair = SidePair {
            from_side: edge.from.side().unwrap_or(pin.sides.from_side),
            to_side: edge.to.side().unwrap_or(pin.sides.to_side),
            around: pin.sides.around,
        };
        merged.set(*id, pair);
        locked.insert(*id);
    }
    (merged, locked)
}

/// Deterministic anchor positions for every edge end, as
/// `assignEdgeAnchors`: touching pairs leave, the side choice is searched
/// (against frozen `side_overrides` when given), and coincident ends are
/// repaired. `styles` holds one style per edge of `all_edges`, by position.
#[must_use]
pub fn assign_edge_anchors(
    (nodes, labels): (&[RoutingNode], &[Rect]),
    (all_edges, all_styles): (&[RoutableEdge], &[RoutingStyle]),
    side_overrides: Option<&JsMap<EdgeId, EdgeAnchorOverride>>,
    budget: &mut RoutingBudget,
) -> JsMap<EdgeId, EdgeAnchorPair> {
    let (edges, styles): (Vec<RoutableEdge>, Vec<RoutingStyle>) = all_edges
        .iter()
        .enumerate()
        .filter(|(_, edge)| !marks_contact(nodes, edge))
        .map(|(i, edge)| {
            (edge.clone(), all_styles.get(i).copied().unwrap_or(RoutingStyle::Straight))
        })
        .unzip();
    let initial = initial_side_choices(nodes, &edges);
    let frozen = side_overrides.map(|overrides| with_overrides(&initial, &edges, overrides));
    let n = edges.len();
    let sides = match &frozen {
        // The live-drag path keeps the hard gate the committed one does not need.
        Some((merged, locked)) if (1..=CROSSING_OPT_MAX_EDGES).contains(&n) && locked.len() < n => {
            let args = RegionArgs { nodes, labels, locked: Some(locked), pins: side_overrides };
            optimize_across_regions(&args, (&edges, &styles), merged, budget)
        }
        Some((merged, _)) => merged.clone(),
        None if n >= 1 => {
            let args = RegionArgs { nodes, labels, locked: None, pins: None };
            optimize_across_regions(&args, (&edges, &styles), &initial, budget)
        }
        None => initial,
    };
    let style_of = |edge: &RoutableEdge| {
        edges
            .iter()
            .position(|e| std::ptr::eq(e, edge))
            .and_then(|i| styles.get(i).copied())
            .unwrap_or(RoutingStyle::Straight)
    };
    let request =
        CoincidentRequest { labels, style_of: &style_of, align: true, pins: side_overrides };
    anchors_without_coincident_ends(nodes, &edges, &sides, &request, budget)
}

#[cfg(test)]
mod tests {
    use super::interleave;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn interleave_spreads_each_bit_three_apart() {
        // Bit k of the input lands on bit 3k: worked by hand, not by the formula.
        assert_eq!(interleave(1), 1);
        assert_eq!(interleave(2), 8);
        assert_eq!(interleave(3), 9);
        assert_eq!(interleave(0x200), 1 << 27);
        assert_eq!(interleave(0x3ff), 0x0924_9249);
        // Only ten bits are read.
        assert_eq!(interleave(0x400), 0);
    }
}
