//! The levels of a board: a frame's members tidied as a canvas of their own,
//! recursively, and the frame grown to hold them.
//!
//! The nesting is walked with an explicit stack rather than by recursion,
//! because a canvas chooses how deep its frames go (up to one level per node)
//! and that depth is not something a call stack should be asked to hold. The
//! visiting order is the recursion's: a frame's members are tidied, depth first,
//! before the next unit at its level.

use std::collections::BTreeSet;

use whiteboard_det::math::{js_max, js_min, js_round};
use whiteboard_edge_routing::geometry::Rect;

use super::axis::{Axis, ceil_to_grid};
use super::bands::align_bands;
use super::overlap::{Outside, apply_floor, resolve_overlaps, snap_stale_anchors};
use super::rows::order_rows_by_edges;
use super::units::{
    Account, Budget, Ctx, Node, Point, TIDY_MARGIN_PX, Unit, build_units, frame_nesting, js_eq,
};

/// What a level is tidied FROM: its nodes (board indices), and the three facts
/// its frame hands it (none at the top level, which has no frame around it).
struct LevelInput {
    nodes: Vec<usize>,
    /// The anchors of what this level's frame does not hold and the margin rule
    /// cannot move, for the margin snap to yield to.
    outside: Outside,
    /// Where this level's grid is laid FROM: the board's zero at the top level,
    /// a frame's own corner inside one.
    origin: Point,
    /// Inside a frame: the margin its members start at, an ANCHOR rather than
    /// only a floor.
    floor: Option<Point>,
}

/// A level part-way through tidying its frames' members.
struct LevelWalk {
    input: LevelInput,
    units: Vec<Unit>,
    /// Which keys the margin rule can reach: a frame's members, in scope and
    /// unlocked, and nobody else.
    framed: Vec<bool>,
    /// The next unit whose members have not been tidied yet.
    next: usize,
    /// The unit whose members are the level above this one on the stack.
    descended: Option<usize>,
}

/// Every node's rect so far, by key, ONE table for the whole walk: a level's
/// nodes are its frame's members and no other unit's, so a level only ever
/// writes rects nothing else at its depth reads.
type Settled = Vec<Rect>;

/// What a pass reads and spends.
pub(super) struct Pass<'a> {
    pub nodes: &'a [Node],
    pub ctx: &'a Ctx,
    pub budget: &'a mut Budget,
}

fn open_level(input: LevelInput, p: &Pass<'_>, enclosers: &[Vec<usize>]) -> LevelWalk {
    let units = build_units(&input.nodes, p.nodes, p.ctx, enclosers);
    let mut framed = vec![false; p.ctx.in_scope.len()];
    for unit in units.iter().filter(|u| u.members.len() > 1) {
        for &m in &unit.members {
            if let Some(slot) = p.nodes.get(m).and_then(|n| framed.get_mut(n.key)) {
                *slot = true;
            }
        }
    }
    LevelWalk { input, units, framed, next: 0, descended: None }
}

/// The smallest box holding `frame` and every rect with the margin around it:
/// growth only, so a frame drawn roomier than it needs stays as drawn.
fn enclosing(frame: Rect, rects: &[Rect]) -> Rect {
    let (mut x, mut y) = (frame.x, frame.y);
    let (mut right, mut bottom) = (frame.x + frame.w, frame.y + frame.h);
    for r in rects {
        x = js_min(x, r.x - TIDY_MARGIN_PX);
        y = js_min(y, r.y - TIDY_MARGIN_PX);
        right = js_max(right, r.x + r.w + TIDY_MARGIN_PX);
        bottom = js_max(bottom, r.y + r.h + TIDY_MARGIN_PX);
    }
    Rect { x, y, w: right - x, h: bottom - y }
}

/// Where a frame's members lay their grid FROM. A frame that can MOVE lays it
/// from its own corner, because the members it carries have to stay where they
/// are relative to it. One that cannot move never carries anything, so it keeps
/// the grid its level already has.
fn inner_origin(unit: &Unit, frame: &Rect, level_origin: Point) -> Point {
    if unit.movable { Point { x: frame.x, y: frame.y } } else { level_origin }
}

/// The margin a frame's members start at: on the frame's own grid a whole number
/// of steps, so this is `frame.{x,y} + TIDY_MARGIN_PX` exactly, written through
/// the same helper because that is what makes it true rather than a coincidence
/// of today's two constants.
fn inner_floor(frame: &Rect) -> Point {
    Point {
        x: ceil_to_grid(frame.x + TIDY_MARGIN_PX, frame.x),
        y: ceil_to_grid(frame.y + TIDY_MARGIN_PX, frame.y),
    }
}

/// The anchors of what this level holds that a frame does not, and that the
/// MARGIN RULE CANNOT MOVE: anything locked or out of scope, and anything that
/// is not a frame's member. A member already lined up with one of them is
/// already in a row, and the margin anchor yields to it.
fn anchors_to_yield_to(level: &LevelWalk, inner: &[usize], p: &Pass<'_>) -> Outside {
    let members: BTreeSet<usize> =
        inner.iter().filter_map(|&m| p.nodes.get(m)).map(|n| n.key).collect();
    let mut out = Outside::default();
    for n in level.input.nodes.iter().filter_map(|&i| p.nodes.get(i)) {
        let snappable = p.ctx.is_in_scope(n.key)
            && !p.ctx.is_locked(n.key)
            && level.framed.get(n.key).copied().unwrap_or(false);
        if members.contains(&n.key) || snappable {
            continue;
        }
        let r = n.rect;
        out.x.extend([r.x, r.x + r.w / 2.0, r.x + r.w]);
        out.y.extend([r.y, r.y + r.h / 2.0, r.y + r.h]);
    }
    out
}

/// The level a unit's members form, or `None` for a unit that is no frame.
fn descend_into(
    level: &LevelWalk,
    unit: usize,
    settled: &Settled,
    p: &Pass<'_>,
) -> Option<LevelInput> {
    let unit = level.units.get(unit)?;
    let root_key = p.nodes.get(unit.root)?.key;
    let inner: Vec<usize> = unit
        .members
        .iter()
        .copied()
        .filter(|&m| p.nodes.get(m).is_some_and(|n| n.key != root_key))
        .collect();
    if inner.is_empty() {
        return None;
    }
    let frame = settled.get(root_key)?;
    Some(LevelInput {
        outside: anchors_to_yield_to(level, &inner, p),
        origin: inner_origin(unit, frame, level.input.origin),
        floor: Some(inner_floor(frame)),
        nodes: inner,
    })
}

/// Whether a frame may grow to hold its members: it is unlocked, and it or one
/// of them is in scope.
fn grows(unit_key: usize, inner: &[usize], p: &Pass<'_>) -> bool {
    !p.ctx.is_locked(unit_key)
        && (p.ctx.is_in_scope(unit_key)
            || inner.iter().filter_map(|&m| p.nodes.get(m)).any(|n| p.ctx.is_in_scope(n.key)))
}

/// Grows the frame to hold what its level settled, on its unit too. `None` when
/// there was nothing to grow: the frame may not, or no longer names a box.
fn absorb_inner(
    level: &mut LevelWalk,
    unit: usize,
    inner: &[usize],
    settled: &mut Settled,
    p: &Pass<'_>,
) -> Option<()> {
    let root_key = p.nodes.get(level.units.get(unit)?.root)?.key;
    let frame = *settled.get(root_key)?;
    if !grows(root_key, inner, p) {
        return None;
    }
    let held: Vec<Rect> = inner
        .iter()
        .filter_map(|&m| p.nodes.get(m).and_then(|n| settled.get(n.key)).copied())
        .collect();
    let grown = enclosing(frame, &held);
    *settled.get_mut(root_key)? = grown;
    level.units.get_mut(unit)?.bbox = grown;
    Some(())
}

/// The unit positions of a level as the numbers a pass can compare.
fn signature(units: &[Unit]) -> Vec<u64> {
    units.iter().flat_map(|u| [bits(u.bbox.x), bits(u.bbox.y)]).collect()
}

/// A number's identity as its text: the two zeros are one, every NaN is one.
pub(super) fn bits(v: f64) -> u64 {
    if v.is_nan() {
        f64::NAN.to_bits()
    } else if js_eq(v, 0.0) {
        0.0_f64.to_bits()
    } else {
        v.to_bits()
    }
}

/// Runs the alignment, ordering and separation passes to an internal FIXPOINT
/// (bounded). An overlap hop can land a unit near a band boundary and vice versa,
/// so a single sweep is not always stable.
///
/// Stopping at a state SEEN BEFORE, rather than only at one equal to the
/// previous state, is what makes the result stable when the passes CYCLE instead
/// of settling: a cycle has no fixpoint to reach, and the first REPEATED state
/// lies ON the cycle, so re-entering from it walks the same loop and stops on the
/// same state. A fixpoint is the period-1 case.
fn run_passes_to_fixpoint(level: &mut LevelWalk, p: &Pass<'_>) {
    const TIDY_MAX_ITERATIONS: usize = 8;
    let LevelInput { origin, floor, .. } = &level.input;
    let (origin, floor) = (*origin, *floor);
    let units = &mut level.units;
    let mut seen: BTreeSet<Vec<u64>> = BTreeSet::from([signature(units)]);
    for _ in 0..TIDY_MAX_ITERATIONS {
        align_bands(units, Axis::X, origin.x, floor.map(|f| f.x));
        align_bands(units, Axis::Y, origin.y, floor.map(|f| f.y));
        order_rows_by_edges(units, p.nodes, p.ctx);
        resolve_overlaps(units, origin, floor);
        if !seen.insert(signature(units)) {
            break;
        }
    }
}

/// Carries each unit's accumulated delta onto all of its members. Only a movable
/// unit is ever shifted, so an immobile one has no delta to carry, and a movable
/// one holds no locked member, so there is no partial move to make.
fn apply_unit_deltas(level: &LevelWalk, settled: &mut Settled, p: &Pass<'_>) {
    for unit in level.units.iter().filter(|u| !(js_eq(u.dx, 0.0) && js_eq(u.dy, 0.0))) {
        for key in unit.members.iter().filter_map(|&m| p.nodes.get(m)).map(|n| n.key) {
            if let Some(rect) = settled.get_mut(key) {
                *rect = Rect { x: rect.x + unit.dx, y: rect.y + unit.dy, ..*rect };
            }
        }
    }
}

/// The level's own passes, once every frame in it holds its tidied members.
fn close_level(level: &mut LevelWalk, settled: &mut Settled, p: &Pass<'_>) {
    if let Some(floor) = level.input.floor {
        apply_floor(&mut level.units, floor, &level.input.outside);
    }
    run_passes_to_fixpoint(level, p);
    snap_stale_anchors(&mut level.units, level.input.origin);
    apply_unit_deltas(level, settled, p);
}

/// Every node's settled rect: frames tidied inside and grown before the level's
/// own units align and separate, all the way down.
fn tidy_level(top: LevelInput, p: &mut Pass<'_>, enclosers: &[Vec<usize>]) -> Settled {
    let mut settled: Settled = vec![Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }; p.ctx.in_scope.len()];
    for &i in &top.nodes {
        if let Some((slot, n)) = p.nodes.get(i).and_then(|n| settled.get_mut(n.key).map(|s| (s, n)))
        {
            *slot = n.rect;
        }
    }
    let mut stack = vec![open_level(top, p, enclosers)];
    loop {
        let Some(level) = stack.last_mut() else { return settled };
        if level.units.get(level.next).is_some() {
            let unit = level.next;
            level.next = level.next.saturating_add(1);
            let inner = descend_into(level, unit, &settled, p);
            // A frame the budget cannot open keeps its members as drawn, and
            // they travel with it as one unit.
            let Some(inner) = inner.filter(|i| p.budget.spend(Account::Levels, i.nodes.len()))
            else {
                continue;
            };
            level.descended = Some(unit);
            let opened = open_level(inner, p, enclosers);
            stack.push(opened);
            continue;
        }
        close_level(level, &mut settled, p);
        let Some(done) = stack.pop() else { return settled };
        if let Some(parent) = stack.last_mut()
            && let Some(unit) = parent.descended.take()
        {
            let _grown = absorb_inner(parent, unit, &done.input.nodes, &mut settled, p);
        }
    }
}

/// One settling pass over the board. Rounded, because that is the state a caller
/// applies and re-enters with.
pub(super) fn settle_once(nodes: &[Node], ctx: &Ctx, budget: &mut Budget) -> Vec<Node> {
    let frames = nodes.iter().filter(|n| n.frame).count();
    if !budget.spend(Account::Nesting, frames.saturating_mul(frames))
        || !budget.spend(Account::Levels, nodes.len())
    {
        return nodes.to_vec();
    }
    let top = LevelInput {
        nodes: (0..nodes.len()).collect(),
        outside: Outside::default(),
        origin: Point { x: 0.0, y: 0.0 },
        floor: None,
    };
    let enclosers = frame_nesting(nodes);
    let settled = tidy_level(top, &mut Pass { nodes, ctx, budget }, &enclosers);
    nodes
        .iter()
        .map(|node| {
            let Some(rect) = settled.get(node.key) else { return *node };
            let next = Rect {
                x: js_round(rect.x),
                y: js_round(rect.y),
                w: js_round(rect.w),
                h: js_round(rect.h),
            };
            if is_finite(&next) { Node { rect: next, ..*node } } else { *node }
        })
        .collect()
}

fn is_finite(r: &Rect) -> bool {
    [r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite())
}
