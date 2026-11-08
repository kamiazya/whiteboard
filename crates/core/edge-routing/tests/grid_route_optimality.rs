//! `route_on_grid` is optimal, not merely good: a returned path costs exactly
//! what an independent Dijkstra over the same grid says it should.
//!
//! The search is A*, and an inadmissible heuristic does not fail loudly: it
//! returns a path that is merely good, and every routing scoreboard stays put
//! because a slightly long detour still avoids every body. The reference here
//! is written from the definition ("the cheapest rectilinear path whose
//! interior avoids every rect"), with a linear scan for the minimum instead of
//! a heap, so it shares no machinery with what it checks. Cost is compared,
//! never the path: equal-cost routes are the norm on a lattice, and which one
//! a search finds is an artifact of its exploration order.
//!
//! The TypeScript twin is `grid-route.optimality.properties.test.ts`.

// Grid coordinates and border lines are compared exactly, as the router does.
#![expect(clippy::float_cmp, reason = "the router compares coordinates with ===")]

use std::collections::{BTreeMap, BTreeSet};

use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::grid_route::route_on_grid;
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const BEND_COST_PX: f64 = 80.0;
const CLEARANCE: f64 = 16.0;
/// The implementation's own window; a reference searching a wider one could
/// find routes it is not asking for.
const WINDOW_PX: f64 = 160.0;

struct Layout {
    obstacles: Vec<Rect>,
    start: Point,
    end: Point,
}

impl std::fmt::Debug for Layout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "start {:?} end {:?} obstacles {:?}", self.start, self.end, self.obstacles)
    }
}

/// Whether the open segment `lo..hi` on `line` crosses `r`'s interior, or
/// how much of it runs along `r`'s border, for a move along one axis.
struct Along {
    horizontal: bool,
}

impl Along {
    fn low(&self, r: &Rect) -> f64 {
        if self.horizontal { r.y } else { r.x }
    }
    fn size(&self, r: &Rect) -> f64 {
        if self.horizontal { r.h } else { r.w }
    }
    fn across_low(&self, r: &Rect) -> f64 {
        if self.horizontal { r.x } else { r.y }
    }
    fn across_size(&self, r: &Rect) -> f64 {
        if self.horizontal { r.w } else { r.h }
    }
    fn blocked(&self, r: &Rect, line: f64, lo: f64, hi: f64) -> bool {
        line > self.low(r)
            && line < self.low(r) + self.size(r)
            && lo < self.across_low(r) + self.across_size(r)
            && hi > self.across_low(r)
    }
    fn traced(&self, r: &Rect, line: f64, lo: f64, hi: f64) -> f64 {
        if line != self.low(r) && line != self.low(r) + self.size(r) {
            return 0.0;
        }
        let overlap_lo = lo.max(self.across_low(r));
        let overlap_hi = hi.min(self.across_low(r) + self.across_size(r));
        if overlap_hi > overlap_lo { overlap_hi - overlap_lo } else { 0.0 }
    }
}

fn sorted(set: &BTreeSet<u64>) -> Vec<f64> {
    let mut v: Vec<f64> = set.iter().map(|b| f64::from_bits(*b)).collect();
    v.sort_by(f64::total_cmp);
    v
}

/// The Hanan grid the router searches: the obstacles near the two ends, and
/// the lines through the ends and each near obstacle's clearance offset.
/// Clearance shapes the grid's coordinates and nothing else.
fn hanan_grid(start: Point, end: Point, obstacles: &[Rect]) -> (Vec<Rect>, Vec<f64>, Vec<f64>) {
    let (min_x, max_x) = (start.x.min(end.x) - WINDOW_PX, start.x.max(end.x) + WINDOW_PX);
    let (min_y, max_y) = (start.y.min(end.y) - WINDOW_PX, start.y.max(end.y) + WINDOW_PX);
    let near: Vec<Rect> = obstacles
        .iter()
        .copied()
        .filter(|r| {
            r.x - CLEARANCE <= max_x
                && r.x + r.w + CLEARANCE >= min_x
                && r.y - CLEARANCE <= max_y
                && r.y + r.h + CLEARANCE >= min_y
        })
        .collect();
    let mut x_set: BTreeSet<u64> = [start.x, end.x].iter().map(|v| v.to_bits()).collect();
    let mut y_set: BTreeSet<u64> = [start.y, end.y].iter().map(|v| v.to_bits()).collect();
    for r in &near {
        for x in [r.x - CLEARANCE, r.x + r.w + CLEARANCE] {
            if x >= min_x && x <= max_x {
                x_set.insert(x.to_bits());
            }
        }
        for y in [r.y - CLEARANCE, r.y + r.h + CLEARANCE] {
            if y >= min_y && y <= max_y {
                y_set.insert(y.to_bits());
            }
        }
    }
    (near, sorted(&x_set), sorted(&y_set))
}

/// Dijkstra over the Hanan grid, no heuristic. Blocking and border-tracing
/// are judged against each rect's raw bounds, as the implementation does.
fn reference_cost(start: Point, end: Point, obstacles: &[Rect]) -> Option<f64> {
    let (near, xs, ys) = hanan_grid(start, end, obstacles);
    let index = |v: &[f64], t: f64| v.iter().position(|c| *c == t);
    let (si, sj, ei, ej) =
        (index(&xs, start.x)?, index(&ys, start.y)?, index(&xs, end.x)?, index(&ys, end.y)?);

    // A state is (i, j, axis of the move that arrived).
    let mut best: BTreeMap<(usize, usize, u8), f64> = BTreeMap::new();
    let mut done: BTreeSet<(usize, usize, u8)> = BTreeSet::new();
    best.insert((si, sj, 0), 0.0);
    best.insert((si, sj, 1), 0.0);
    loop {
        let (state, cost) = best
            .iter()
            .filter(|(s, _)| !done.contains(*s))
            .min_by(|a, b| a.1.total_cmp(b.1))
            .map(|(s, c)| (*s, *c))?;
        done.insert(state);
        let (i, j, axis) = state;
        if i == ei && j == ej {
            return Some(cost);
        }
        for (di, dj, next_axis) in [(1, 0, 0u8), (-1, 0, 0), (0, 1, 1), (0, -1, 1)] {
            let (Some(ni), Some(nj)) = (i.checked_add_signed(di), j.checked_add_signed(dj)) else {
                continue;
            };
            if ni >= xs.len() || nj >= ys.len() {
                continue;
            }
            let along = Along { horizontal: dj == 0 };
            let (from, to, line) =
                if along.horizontal { (xs[i], xs[ni], ys[j]) } else { (ys[j], ys[nj], xs[i]) };
            let (lo, hi) = (from.min(to), from.max(to));
            if near.iter().any(|r| along.blocked(r, line, lo, hi)) {
                continue;
            }
            let traced: f64 = near.iter().map(|r| along.traced(r, line, lo, hi)).sum();
            let turn = if axis == next_axis { 0.0 } else { BEND_COST_PX };
            let next = cost + (hi - lo) + turn + traced;
            let slot = best.entry((ni, nj, next_axis)).or_insert(f64::INFINITY);
            if next < *slot {
                *slot = next;
            }
        }
    }
}

/// What a returned path costs, measured from the path alone.
fn path_cost(path: &[Point], obstacles: &[Rect]) -> f64 {
    let mut cost = 0.0;
    for pair in path.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let along = Along { horizontal: a.y == b.y };
        let (lo, hi, line) = if along.horizontal {
            (a.x.min(b.x), a.x.max(b.x), a.y)
        } else {
            (a.y.min(b.y), a.y.max(b.y), a.x)
        };
        cost += hi - lo;
        cost += obstacles.iter().map(|r| along.traced(r, line, lo, hi)).sum::<f64>();
    }
    for triple in path.windows(3) {
        if (triple[0].y == triple[1].y) != (triple[1].y == triple[2].y) {
            cost += BEND_COST_PX;
        }
    }
    cost
}

/// A LATTICE, not scattered rectangles: identical boxes on a regular pitch is
/// what makes equal-cost alternatives common, the case an inadmissible
/// heuristic gets wrong.
fn lattice() -> impl Strategy<Value = Layout> {
    (
        (180u32..=300, 140u32..=220, 80u32..=160, 60u32..=120, 2usize..=4, 2usize..=4),
        prop::collection::vec(prop::bool::ANY, 16),
        (0usize..16, 0usize..16, 0u8..4, 0u8..4),
    )
        .prop_map(|((px, py, w, h, cols, rows), present, (sc, ec, ss, es))| {
            let (px, py, w, h) = (f64::from(px), f64::from(py), f64::from(w), f64::from(h));
            let mut obstacles = Vec::new();
            let mut by = 0.0;
            for j in 0..rows {
                let mut bx = 0.0;
                for i in 0..cols {
                    if present[j * cols + i] {
                        obstacles.push(Rect { x: bx, y: by, w, h });
                    }
                    bx += px;
                }
                by += py;
            }
            let anchor = |cell: usize, side: u8| {
                let (i, j) = (cell % cols, (cell / cols) % rows);
                let (mut bx, mut by) = (0.0, 0.0);
                for _ in 0..i {
                    bx += px;
                }
                for _ in 0..j {
                    by += py;
                }
                match side {
                    0 => Point { x: bx + w / 2.0, y: by },
                    1 => Point { x: bx + w, y: by + h / 2.0 },
                    2 => Point { x: bx + w / 2.0, y: by + h },
                    _ => Point { x: bx, y: by + h / 2.0 },
                }
            };
            Layout { obstacles, start: anchor(sc, ss), end: anchor(ec, es) }
        })
        .prop_filter("a layout with a box and two distinct ends", |l| {
            !l.obstacles.is_empty() && l.start != l.end
        })
}

#[test]
fn a_returned_path_costs_exactly_what_an_independent_dijkstra_says() {
    let bent = Floor::new("routed with a bend");
    check(lattice(), Some(150), |layout| {
        let route =
            route_on_grid(layout.start, layout.end, &layout.obstacles, CLEARANCE, f64::INFINITY);
        let Some(path) = route.path else {
            bent.draw(false);
            return Ok(());
        };
        bent.draw(path.len() > 2);
        let reference = reference_cost(layout.start, layout.end, &layout.obstacles);
        prop_assert!(reference.is_some(), "the router found a path the reference did not");
        let (got, want) = (path_cost(&path, &layout.obstacles), reference.unwrap_or(f64::NAN));
        prop_assert!((got - want).abs() < 1e-6, "path costs {got}, the optimum is {want}");
        Ok(())
    });
    // Measured 131-133 of 150 draws routed with a bend.
    bent.assert(100);
}
