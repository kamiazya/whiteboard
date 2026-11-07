//! A rectilinear shortest path around rectangles: canvas-render's
//! `layout/edges/grid-route.ts`, ported structure for structure (ADR-0054
//! step 5, the routing spike).
//!
//! The reasoning behind each constant and each pass is written once, in the
//! TypeScript; this file says only where Rust has to work to give the same
//! answer. Three places do:
//!
//! - `Math.min`/`Math.max` propagate NaN and order the zeros, `f64::min` does
//!   neither, so the port calls [`js_min`]/[`js_max`].
//! - A `Set` of numbers dedups by `SameValueZero` and keeps the FIRST value
//!   inserted (so `-0` survives a later `0`), and the sort is
//!   `compareNumbers`; [`distinct`] and [`compare_numbers`] are that.
//! - The heap's tie order decides which of several optimal routes wins, so it
//!   is the TypeScript heap's own sift ([`MinHeap`]).

// Exact comparison is the oracle's semantics, not an accident: every `==` and
// `!=` on a coordinate here is JavaScript's `===` in grid-route.ts.
#![expect(clippy::float_cmp, reason = "the TypeScript compares coordinates with ===")]

use std::cmp::Ordering;

use whiteboard_det::math::{js_max, js_min};

use crate::geometry::{Point, Rect};
use crate::min_heap::MinHeap;

const BEND_COST_PX: f64 = 80.0;
const MAX_GRID_CELLS: usize = 4096;
const GRID_WINDOW_PX: f64 = 160.0;

/// A grid move's axis: 0 travels a row (x changes), 1 a column (y changes).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Axis {
    Row = 0,
    Column = 1,
}

struct GridStep {
    di: isize,
    dj: isize,
    axis: Axis,
}

const GRID_STEPS: [GridStep; 4] = [
    GridStep { di: 1, dj: 0, axis: Axis::Row },
    GridStep { di: -1, dj: 0, axis: Axis::Row },
    GridStep { di: 0, dj: 1, axis: Axis::Column },
    GridStep { di: 0, dj: -1, axis: Axis::Column },
];

impl Axis {
    /// A rect's near coordinate along this axis.
    fn near(self, r: &Rect) -> f64 {
        match self {
            Axis::Row => r.x,
            Axis::Column => r.y,
        }
    }

    /// A rect's extent along this axis.
    fn size(self, r: &Rect) -> f64 {
        match self {
            Axis::Row => r.w,
            Axis::Column => r.h,
        }
    }

    /// The cell index along the axis (`i` on a row, `j` on a column).
    fn along(self, i: usize, j: usize) -> usize {
        match self {
            Axis::Row => i,
            Axis::Column => j,
        }
    }

    /// The cell index across it, naming the line the step travels on.
    fn across(self, i: usize, j: usize) -> usize {
        match self {
            Axis::Row => j,
            Axis::Column => i,
        }
    }
}

/// JavaScript's `compareNumbers` from `det-math.ts`: NaN last, `-0 == 0`.
fn compare_numbers(a: f64, b: f64) -> Ordering {
    if a < b {
        Ordering::Less
    } else if a > b {
        Ordering::Greater
    } else {
        a.is_nan().cmp(&b.is_nan())
    }
}

/// A `Set<number>`'s contents in insertion order: `SameValueZero`, first kept.
fn distinct(values: impl IntoIterator<Item = f64>) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for v in values {
        if !out.iter().any(|&seen| seen == v || (seen.is_nan() && v.is_nan())) {
            out.push(v);
        }
    }
    out
}

/// `Array.prototype.indexOf` over numbers: strict equality, so NaN is never found.
fn index_of(values: &[f64], target: f64) -> Option<usize> {
    values.iter().position(|&v| v == target)
}

fn span_blocked(blockers: &[Rect], axis: Axis, lo: f64, hi: f64) -> bool {
    blockers.iter().any(|r| lo < axis.near(r) + axis.size(r) && hi > axis.near(r))
}

fn traced_along(borders: &[Rect], axis: Axis, lo: f64, hi: f64) -> f64 {
    let mut traced = 0.0;
    for r in borders {
        let overlap_lo = js_max(lo, axis.near(r));
        let overlap_hi = js_min(hi, axis.near(r) + axis.size(r));
        if overlap_hi > overlap_lo {
            traced += overlap_hi - overlap_lo;
        }
    }
    traced
}

struct Grid {
    xs: Vec<f64>,
    ys: Vec<f64>,
    near: Vec<Rect>,
}

fn build_grid(start: Point, end: Point, obstacles: &[Rect], clearance: f64) -> Option<Grid> {
    let min_x = js_min(start.x, end.x) - GRID_WINDOW_PX;
    let max_x = js_max(start.x, end.x) + GRID_WINDOW_PX;
    let min_y = js_min(start.y, end.y) - GRID_WINDOW_PX;
    let max_y = js_max(start.y, end.y) + GRID_WINDOW_PX;
    let near: Vec<Rect> = obstacles
        .iter()
        .filter(|r| {
            r.x - clearance <= max_x
                && r.x + r.w + clearance >= min_x
                && r.y - clearance <= max_y
                && r.y + r.h + clearance >= min_y
        })
        .copied()
        .collect();
    let in_x = |x: f64| x >= min_x && x <= max_x;
    let in_y = |y: f64| y >= min_y && y <= max_y;
    let mut x_candidates = vec![start.x, end.x];
    let mut y_candidates = vec![start.y, end.y];
    for r in &near {
        x_candidates
            .extend([r.x - clearance, r.x + r.w + clearance].into_iter().filter(|&x| in_x(x)));
        y_candidates
            .extend([r.y - clearance, r.y + r.h + clearance].into_iter().filter(|&y| in_y(y)));
    }
    let mut xs = distinct(x_candidates);
    let mut ys = distinct(y_candidates);
    if xs.len().saturating_mul(ys.len()) > MAX_GRID_CELLS {
        return None;
    }
    xs.sort_by(|a, b| compare_numbers(*a, *b));
    ys.sort_by(|a, b| compare_numbers(*a, *b));
    Some(Grid { xs, ys, near })
}

struct LineBuckets {
    blockers: Vec<Vec<Rect>>,
    borders: Vec<Vec<Rect>>,
}

fn bucket_by_line(values: &[f64], near: &[Rect], axis: Axis) -> LineBuckets {
    let blockers = values
        .iter()
        .map(|&v| {
            near.iter()
                .filter(|r| v > axis.near(r) && v < axis.near(r) + axis.size(r))
                .copied()
                .collect()
        })
        .collect();
    let borders = values
        .iter()
        .map(|&v| {
            near.iter()
                .filter(|r| v == axis.near(r) || v == axis.near(r) + axis.size(r))
                .copied()
                .collect()
        })
        .collect();
    LineBuckets { blockers, borders }
}

struct GridSearch {
    xs: Vec<f64>,
    ys: Vec<f64>,
    width: usize,
    goal_x: f64,
    goal_y: f64,
    /// Indexed by a step's own axis: `[rows, cols]`, as in the TypeScript.
    lines: [LineBuckets; 2],
    best: Vec<f64>,
    came_from: Vec<Option<usize>>,
    allowance: f64,
    spent: f64,
}

impl GridSearch {
    fn coords(&self, axis: Axis) -> &[f64] {
        match axis {
            Axis::Row => &self.xs,
            Axis::Column => &self.ys,
        }
    }

    fn heuristic(&self, i: usize, j: usize) -> f64 {
        let x = self.xs.get(i).copied().unwrap_or(f64::NAN);
        let y = self.ys.get(j).copied().unwrap_or(f64::NAN);
        (x - self.goal_x).abs() + (y - self.goal_y).abs()
    }

    #[expect(
        clippy::arithmetic_side_effects,
        reason = "a state index is below 2 * MAX_GRID_CELLS, which build_grid enforces"
    )]
    fn state_of(&self, i: usize, j: usize, axis: Axis) -> usize {
        (j * self.width + i) * 2 + axis as usize
    }

    /// The cell (i, j) a state lies in; each cell holds two states.
    #[expect(
        clippy::arithmetic_side_effects,
        reason = "width is at least 1: the grid always holds both endpoints' coordinates"
    )]
    fn cell_of(&self, state: usize) -> (usize, usize) {
        let cell = state / 2;
        (cell % self.width, cell / self.width)
    }

    fn line(&self, axis: Axis) -> &LineBuckets {
        let [rows, cols] = &self.lines;
        match axis {
            Axis::Row => rows,
            Axis::Column => cols,
        }
    }

    fn best(&self, state: usize) -> f64 {
        self.best.get(state).copied().unwrap_or(f64::INFINITY)
    }
}

fn prepare_search(grid: Grid, ei: usize, ej: usize, allowance: f64, bucketing: f64) -> GridSearch {
    let Grid { xs, ys, near } = grid;
    let width = xs.len();
    let goal_x = xs.get(ei).copied().unwrap_or(f64::NAN);
    let goal_y = ys.get(ej).copied().unwrap_or(f64::NAN);
    let state_count = width.saturating_mul(ys.len()).saturating_mul(2);
    let rows = bucket_by_line(&ys, &near, Axis::Column);
    let cols = bucket_by_line(&xs, &near, Axis::Row);
    GridSearch {
        xs,
        ys,
        width,
        goal_x,
        goal_y,
        lines: [rows, cols],
        best: vec![f64::INFINITY; state_count],
        came_from: vec![None; state_count],
        allowance,
        spent: bucketing,
    }
}

/// Relax every move out of `state` at cell (i, j), arrived on `axis`.
fn expand(g: &mut GridSearch, heap: &mut MinHeap, state: usize, axis: Axis, i: usize, j: usize) {
    for step in &GRID_STEPS {
        let (Some(ni), Some(nj)) = (i.checked_add_signed(step.di), j.checked_add_signed(step.dj))
        else {
            continue;
        };
        if ni >= g.xs.len() || nj >= g.ys.len() {
            continue;
        }
        let index = step.axis.across(i, j);
        let along = g.coords(step.axis);
        let from = along.get(step.axis.along(i, j)).copied().unwrap_or(f64::NAN);
        let to = along.get(step.axis.along(ni, nj)).copied().unwrap_or(f64::NAN);
        let lo = js_min(from, to);
        let hi = js_max(from, to);
        let line = g.line(step.axis);
        let blockers = line.blockers.get(index).map_or(&[][..], Vec::as_slice);
        let borders = line.borders.get(index).map_or(&[][..], Vec::as_slice);
        #[expect(
            clippy::cast_precision_loss,
            reason = "bucket sizes are bounded by the obstacle count, far below 2^53"
        )]
        let charged = blockers.len().saturating_add(borders.len()) as f64;
        // Charged whether or not the step is open, as in the TypeScript;
        // `traced` is only used when it is.
        let blocked = span_blocked(blockers, step.axis, lo, hi);
        let traced = if blocked { 0.0 } else { traced_along(borders, step.axis, lo, hi) };
        g.spent += charged;
        if blocked {
            continue;
        }
        let turn = if axis == step.axis { 0.0 } else { BEND_COST_PX };
        let next = g.best(state) + (hi - lo) + turn + traced;
        let next_state = g.state_of(ni, nj, step.axis);
        if next >= g.best(next_state) {
            continue;
        }
        if let Some(slot) = g.best.get_mut(next_state) {
            *slot = next;
        }
        if let Some(slot) = g.came_from.get_mut(next_state) {
            *slot = Some(state);
        }
        heap.push(next + g.heuristic(ni, nj), next_state);
    }
}

/// The goal state the search settles on, or `None` when it is unreachable.
fn search_grid(g: &mut GridSearch, si: usize, sj: usize, ei: usize, ej: usize) -> Option<usize> {
    let mut heap = MinHeap::default();
    for axis in [Axis::Row, Axis::Column] {
        let start = g.state_of(si, sj, axis);
        if let Some(slot) = g.best.get_mut(start) {
            *slot = 0.0;
        }
        heap.push(g.heuristic(si, sj), start);
    }
    while heap.len() > 0 {
        let (cost, state) = heap.pop()?;
        let axis = if state % 2 == 0 { Axis::Row } else { Axis::Column };
        let (i, j) = g.cell_of(state);
        if g.best(state) + g.heuristic(i, j) < cost {
            continue;
        }
        if i == ei && j == ej {
            return Some(state);
        }
        expand(g, &mut heap, state, axis, i, j);
        if g.spent > g.allowance {
            return None;
        }
    }
    None
}

fn reconstruct_path(goal: usize, g: &GridSearch) -> Option<Vec<Point>> {
    let mut reversed: Vec<Point> = Vec::new();
    let mut cursor = Some(goal);
    while let Some(state) = cursor {
        let (i, j) = g.cell_of(state);
        let point = Point {
            x: g.xs.get(i).copied().unwrap_or(f64::NAN),
            y: g.ys.get(j).copied().unwrap_or(f64::NAN),
        };
        if reversed.last().is_none_or(|last| last.x != point.x || last.y != point.y) {
            reversed.push(point);
        }
        cursor = g.came_from.get(state).copied().flatten();
    }
    reversed.reverse();
    let mut path: Vec<Point> = Vec::new();
    for point in reversed {
        let collinear = match path.as_slice() {
            [.., a, b] => (a.x == b.x && b.x == point.x) || (a.y == b.y && b.y == point.y),
            _ => false,
        };
        if collinear {
            if let Some(last) = path.last_mut() {
                *last = point;
            }
            continue;
        }
        path.push(point);
    }
    (path.len() >= 2).then_some(path)
}

/// What one call answered: the route, and the obstacle tests it spent
/// (which the caller subtracts from its budget, as `routeOnGrid` does).
#[derive(Debug, Clone, PartialEq)]
pub struct GridRoute {
    pub path: Option<Vec<Point>>,
    pub spent: f64,
}

/// `routeOnGrid(start, end, obstacles, clearance, budget)`, with the budget's
/// remaining `grid` allowance passed as `allowance` (`f64::INFINITY` for no
/// budget) and what was spent returned rather than subtracted.
#[must_use]
pub fn route_on_grid(
    start: Point,
    end: Point,
    obstacles: &[Rect],
    clearance: f64,
    allowance: f64,
) -> GridRoute {
    let none = GridRoute { path: None, spent: 0.0 };
    let Some(grid) = build_grid(start, end, obstacles, clearance) else { return none };
    let (Some(si), Some(sj), Some(ei), Some(ej)) = (
        index_of(&grid.xs, start.x),
        index_of(&grid.ys, start.y),
        index_of(&grid.xs, end.x),
        index_of(&grid.ys, end.y),
    ) else {
        return none;
    };
    #[expect(clippy::cast_precision_loss, reason = "obstacle and line counts are far below 2^53")]
    let bucketing =
        2.0 * grid.near.len() as f64 * grid.xs.len().saturating_add(grid.ys.len()) as f64;
    if bucketing > allowance {
        return none;
    }
    let mut search = prepare_search(grid, ei, ej, allowance, bucketing);
    let goal = search_grid(&mut search, si, sj, ei, ej);
    let spent = search.spent;
    GridRoute { path: goal.and_then(|goal| reconstruct_path(goal, &search)), spent }
}

#[cfg(test)]
mod tests {
    use super::{Point, Rect, route_on_grid};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn runs_straight_when_nothing_is_in_the_way() {
        let route = route_on_grid(p(0.0, 0.0), p(100.0, 0.0), &[], 16.0, f64::INFINITY);
        assert_eq!(route.path, Some(vec![p(0.0, 0.0), p(100.0, 0.0)]));
    }

    #[test]
    fn steps_around_a_box_at_the_requested_clearance() {
        let route = route_on_grid(
            p(0.0, 50.0),
            p(200.0, 50.0),
            &[rect(80.0, 0.0, 40.0, 100.0)],
            16.0,
            f64::INFINITY,
        );
        let path = route.path.unwrap();
        assert_eq!(path.first(), Some(&p(0.0, 50.0)));
        assert_eq!(path.last(), Some(&p(200.0, 50.0)));
        assert!(path.iter().any(|q| q.y == -16.0 || q.y == 116.0));
    }

    #[test]
    fn gives_up_on_a_grid_past_its_cell_cap() {
        let many: Vec<Rect> =
            (0..40).map(|i| rect(f64::from(i) * 50.0, f64::from(i) * 30.0, 20.0, 20.0)).collect();
        let route = route_on_grid(p(-100.0, -100.0), p(3000.0, 2000.0), &many, 16.0, f64::INFINITY);
        assert_eq!(route.path, None);
    }

    #[test]
    fn spends_nothing_when_the_budget_cannot_cover_the_bucketing() {
        let route =
            route_on_grid(p(0.0, 50.0), p(200.0, 50.0), &[rect(80.0, 0.0, 40.0, 100.0)], 16.0, 1.0);
        assert_eq!(route, super::GridRoute { path: None, spent: 0.0 });
    }
}
