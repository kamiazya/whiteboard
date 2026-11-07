//! The straight style's way around boxes, and the stub squaring both styles
//! share: canvas-render's `layout/edges/straight-detour.ts`, ported function
//! for function.
//!
//! The reasoning is written once, in the TypeScript. Rust works for the same
//! answer in three places:
//!
//! - `Math.min`/`Math.max` are [`js_min`]/[`js_max`].
//! - The visibility test in the corner search records each blocker it meets.
//!   It runs only after the cheaper distance test passes (the TypeScript's
//!   `||`), so that order is kept.
//! - The legs already tested are a map keyed as the TypeScript keys them.
//!   It is a `BTreeMap`, so nothing about it depends on hashing.

use crate::edge_geometry::{Side, contains_point, outward_normal, segment_crosses_rect};
use crate::geometry::{Point, Rect};
use std::collections::{BTreeMap, BTreeSet};
use whiteboard_det::math::{hypot, js_max, js_min};

/// One box a straight route must go around, as `DetourObstacle`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DetourObstacle {
    pub block: Rect,
    pub body: Rect,
    pub escapable: bool,
}

const MAX_BLOCKERS: usize = 24;
const MAX_ROUNDS: usize = 6;
const CORNER_COST_PX: f64 = 4.0;

/// The shortest route from `start` to `end` through the clearance corners
/// of the boxes actually in the way, or `None` when none is found.
#[must_use]
pub fn corner_detour(
    start: Point,
    end: Point,
    obstacles: &[DetourObstacle],
    clearance: f64,
) -> Option<Vec<Point>> {
    let Some(first) = first_blocker(obstacles, start, end) else { return Some(vec![start, end]) };
    let mut vertices: Vec<Point> = vec![start, end];
    let mut added: BTreeSet<usize> = BTreeSet::new();
    let add = |i: usize, vertices: &mut Vec<Point>, added: &mut BTreeSet<usize>| {
        added.insert(i);
        if let Some(o) = obstacles.get(i) {
            vertices.extend(corners_of(*o, obstacles, clearance));
        }
    };
    add(first, &mut vertices, &mut added);
    let mut legs: BTreeMap<(usize, usize), Option<usize>> = BTreeMap::new();
    let mut best = None;
    for _ in 0..MAX_ROUNDS {
        let mut met: BTreeSet<usize> = BTreeSet::new();
        best = shortest_through(&vertices, |u, v| {
            let key = if u < v { (u, v) } else { (v, u) };
            let hit =
                *legs.entry(key).or_insert_with(|| match (vertices.get(u), vertices.get(v)) {
                    (Some(&a), Some(&b)) => first_blocker(obstacles, a, b),
                    _ => None,
                });
            if let Some(h) = hit
                && !added.contains(&h)
            {
                met.insert(h);
            }
            hit.is_none()
        });
        if met.is_empty() || added.len().saturating_add(met.len()) > MAX_BLOCKERS {
            return best;
        }
        // `[...met].sort(compareNumbers)`: a BTreeSet already iterates in order.
        for i in met {
            add(i, &mut vertices, &mut added);
        }
    }
    best
}

/// The index of the first obstacle the leg `a`-`b` is blocked by.
fn first_blocker(obstacles: &[DetourObstacle], a: Point, b: Point) -> Option<usize> {
    let (min_x, max_x) = (js_min(a.x, b.x), js_max(a.x, b.x));
    let (min_y, max_y) = (js_min(a.y, b.y), js_max(a.y, b.y));
    obstacles.iter().position(|o| {
        let block = o.block;
        if max_x < block.x
            || min_x > block.x + block.w
            || max_y < block.y
            || min_y > block.y + block.h
        {
            return false;
        }
        let escaping = o.escapable && (contains_point(o.block, a) || contains_point(o.block, b));
        if escaping { enters_interior(a, b, o.body) } else { segment_crosses_rect(a, b, o.block) }
    })
}

/// Whether `a`-`b` enters `r`'s open interior, by Liang-Barsky clipping.
fn enters_interior(a: Point, b: Point, r: Rect) -> bool {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mut enter = 0.0;
    let mut leave = 1.0;
    for (p, q) in [(-dx, a.x - r.x), (dx, r.x + r.w - a.x), (-dy, a.y - r.y), (dy, r.y + r.h - a.y)]
    {
        if p == 0.0 {
            if q <= 0.0 {
                return false;
            }
            continue;
        }
        let t = q / p;
        if p < 0.0 {
            enter = js_max(enter, t);
        } else {
            leave = js_min(leave, t);
        }
        if enter >= leave {
            return false;
        }
    }
    true
}

/// `body`'s corners pushed out by `clearance`, less any inside a block.
fn corners_of(o: DetourObstacle, obstacles: &[DetourObstacle], clearance: f64) -> Vec<Point> {
    let body = o.body;
    let left = body.x - clearance;
    let right = body.x + body.w + clearance;
    let top = body.y - clearance;
    let bottom = body.y + body.h + clearance;
    [
        Point { x: left, y: top },
        Point { x: right, y: top },
        Point { x: right, y: bottom },
        Point { x: left, y: bottom },
    ]
    .into_iter()
    .filter(|&corner| !obstacles.iter().any(|other| contains_point(other.block, corner)))
    .collect()
}

/// A* from vertex 0 to vertex 1 over the visible legs.
fn shortest_through(
    vertices: &[Point],
    mut visible: impl FnMut(usize, usize) -> bool,
) -> Option<Vec<Point>> {
    let goal = *vertices.get(1)?;
    let to_goal: Vec<f64> = vertices.iter().map(|p| hypot(goal.x - p.x, goal.y - p.y)).collect();
    let mut dist: Vec<f64> =
        (0..vertices.len()).map(|i| if i == 0 { 0.0 } else { f64::INFINITY }).collect();
    let mut prev: Vec<Option<usize>> = vec![None; vertices.len()];
    let mut done: Vec<bool> = vec![false; vertices.len()];
    while let Some(u) = nearest_open(&to_goal, &dist, &done) {
        if u == 1 {
            return Some(path_to(1, &prev, vertices));
        }
        if let Some(d) = done.get_mut(u) {
            *d = true;
        }
        let (Some(&from), Some(&dist_u)) = (vertices.get(u), dist.get(u)) else { break };
        for (v, &to) in vertices.iter().enumerate().skip(1) {
            if done.get(v).copied().unwrap_or(true) {
                continue;
            }
            let step =
                hypot(to.x - from.x, to.y - from.y) + if v == 1 { 0.0 } else { CORNER_COST_PX };
            let through = dist_u + step;
            if through >= dist.get(v).copied().unwrap_or(f64::NAN) || !visible(u, v) {
                continue;
            }
            if let (Some(d), Some(p)) = (dist.get_mut(v), prev.get_mut(v)) {
                *d = through;
                *p = Some(u);
            }
        }
    }
    None
}

/// The open vertex with the least `dist + toGoal`, the first on a tie; a
/// NaN never wins, as `<` never holds for it.
fn nearest_open(to_goal: &[f64], dist: &[f64], done: &[bool]) -> Option<usize> {
    let mut best = None;
    let mut best_f = f64::INFINITY;
    for (i, ((&g, &d), &finished)) in to_goal.iter().zip(dist).zip(done).enumerate() {
        let f = d + g;
        if !finished && f < best_f {
            best = Some(i);
            best_f = f;
        }
    }
    best
}

fn path_to(at: usize, prev: &[Option<usize>], vertices: &[Point]) -> Vec<Point> {
    let mut path = Vec::new();
    let mut v = Some(at);
    while let Some(i) = v {
        if let Some(&p) = vertices.get(i) {
            path.push(p);
        }
        v = prev.get(i).copied().flatten();
    }
    path.reverse();
    path
}

/// `rect` inset by half a pixel, or less for a rect too thin to take it.
#[must_use]
pub fn strict_interior(rect: Rect) -> Rect {
    let inset = js_min(js_min(0.5, rect.w / 2.0), rect.h / 2.0);
    Rect { x: rect.x + inset, y: rect.y + inset, w: rect.w - 2.0 * inset, h: rect.h - 2.0 * inset }
}

const SIDEWAYS_RATIO: f64 = 0.25;

/// Whether the segment from `anchor` toward `other` grazes along `side`
/// rather than leaving it.
#[must_use]
pub fn approaches_sideways(anchor: Point, other: Point, side: Side) -> bool {
    let vx = other.x - anchor.x;
    let vy = other.y - anchor.y;
    if vx == 0.0 && vy == 0.0 {
        return false;
    }
    let normal = outward_normal(side);
    let outward = normal.x * vx + normal.y * vy;
    let tangential = (normal.x * vy - normal.y * vx).abs();
    outward <= tangential * SIDEWAYS_RATIO
}

/// What [`square_ends`] squares a path against.
pub struct SquareEnds<'a> {
    pub exit: Point,
    pub entry: Point,
    pub from_side: Side,
    pub to_side: Side,
    pub clear: &'a dyn Fn(Point, Point) -> bool,
}

/// The path with its exit and entry stubs inserted where an end would
/// otherwise graze its own side, and the stub's run is clear.
#[must_use]
pub fn square_ends(path: Vec<Point>, ends: &SquareEnds<'_>) -> Vec<Point> {
    if path.len() == 2 {
        return path;
    }
    let mut squared = path;
    if let (Some(&start), Some(&next)) = (squared.first(), squared.get(1))
        && approaches_sideways(start, next, ends.from_side)
        && (ends.clear)(ends.exit, next)
    {
        squared.insert(1, ends.exit);
    }
    let n = squared.len();
    if let (Some(&end), Some(&before)) =
        (squared.last(), n.checked_sub(2).and_then(|i| squared.get(i)))
        && approaches_sideways(end, before, ends.to_side)
        && (ends.clear)(before, ends.entry)
    {
        squared.insert(n.saturating_sub(1), ends.entry);
    }
    squared
}

#[cfg(test)]
mod tests {
    use super::{DetourObstacle, approaches_sideways, corner_detour, strict_interior};
    use crate::edge_geometry::Side;
    use crate::geometry::{Point, Rect};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn a_clear_leg_goes_straight_and_a_box_in_the_way_is_gone_around() {
        let body = Rect { x: 40.0, y: -20.0, w: 20.0, h: 40.0 };
        let wall = DetourObstacle { block: body, body, escapable: false };
        assert_eq!(
            corner_detour(p(0.0, 0.0), p(100.0, 0.0), &[], 8.0),
            Some(vec![p(0.0, 0.0), p(100.0, 0.0)])
        );
        let around = corner_detour(p(0.0, 0.0), p(100.0, 0.0), &[wall], 8.0).unwrap_or_default();
        assert_eq!(around.len(), 4);
        assert_eq!(around.get(1), Some(&p(32.0, -28.0)));
    }

    #[test]
    fn a_thin_rect_insets_by_half_its_thickness_and_a_graze_is_sideways() {
        assert_eq!(
            strict_interior(Rect { x: 0.0, y: 0.0, w: 10.0, h: 0.4 }).h.to_bits(),
            0.0_f64.to_bits()
        );
        assert!(approaches_sideways(p(0.0, 0.0), p(10.0, -1.0), Side::Top));
        assert!(!approaches_sideways(p(0.0, 0.0), p(1.0, -10.0), Side::Top));
    }
}
