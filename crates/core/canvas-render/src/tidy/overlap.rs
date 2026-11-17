//! Separation, and the two passes that keep alignment honest around it: the
//! overlap hop, the repair of an off-grid alignment whose anchor moved away,
//! and the margin a frame's members start at.

use whiteboard_det::math::{compare_numbers, js_max, js_min};
use whiteboard_edge_routing::geometry::Rect;

use super::axis::{AXES, Axis, on_some_anchor, round_to_grid};
use super::units::{
    Point, TIDY_BAND_PX, TIDY_GRID_PX, TIDY_MARGIN_PX, Unit, js_eq, overlaps_with_margin,
};
use crate::order::sorted_by;

/// How deep `unit` and `hit` overlap along `ax`: 0 or less when they miss.
fn penetration(ax: Axis, unit: &Rect, hit: &Rect) -> f64 {
    js_min(ax.at(unit, 1.0), ax.at(hit, 1.0)) - js_max(ax.near(unit), ax.near(hit))
}

/// Hops `unit` clear of everything in `occupied`, one obstacle at a time, in
/// the direction `forward` (right/down) or back along `ax`, landing on the first
/// clear grid spot past where it starts.
///
/// One pass over the obstacles in the order the hop meets them (nearest leading
/// edge first) is enough, and is what keeps a stack of identical boxes quadratic
/// rather than cubic. The hop is monotone and never changes the cross axis, so
/// an obstacle hopped past, or already behind, stays clear; and the first one
/// still AHEAD, out of reach, puts every later one out of reach too. Re-scanning
/// the whole set after every hop finds the same spot.
fn hop_clear(unit: &mut Unit, ax: Axis, forward: bool, occupied: &[Rect], from: f64) {
    // Hops land ON the grid, rounding AWAY from the collider so the clearance
    // never shrinks: off-grid spots would feed the next pass's banding and
    // unsettle the fixpoint.
    let snap_away = |v: f64| {
        let steps = (v - from) / TIDY_GRID_PX;
        from + if forward { steps.ceil() } else { steps.floor() } * TIDY_GRID_PX
    };
    let in_hop_order = sorted_by(occupied.to_vec(), |a, b| {
        if forward {
            compare_numbers(ax.near(a), ax.near(b))
        } else {
            compare_numbers(ax.at(b, 1.0), ax.at(a, 1.0))
        }
    });
    for hit in &in_hop_order {
        if !overlaps_with_margin(unit.bbox, *hit) {
            continue;
        }
        let next = snap_away(if forward {
            ax.at(hit, 1.0) + TIDY_MARGIN_PX
        } else {
            ax.near(hit) - TIDY_MARGIN_PX - ax.size(&unit.bbox)
        });
        let by = next - ax.near(&unit.bbox);
        ax.shift(unit, by);
    }
}

/// Deterministic sequential placement: immobile units occupy first; each movable
/// unit then hops along ONE axis (chosen from its first collision: smaller
/// penetration wins, ties go horizontal; direction away from the collider's
/// centre, ties right/down) until clear of everything placed so far.
pub(super) fn resolve_overlaps(units: &mut [Unit], origin: Point, floor: Option<Point>) {
    let mut occupied: Vec<Rect> = units.iter().filter(|u| !u.movable).map(|u| u.bbox).collect();
    for unit in units.iter_mut() {
        if !unit.movable {
            continue;
        }
        if let Some(hit) = occupied.iter().find(|r| overlaps_with_margin(unit.bbox, **r)).copied() {
            hop_away(unit, &hit, &occupied, origin, floor);
        }
        occupied.push(unit.bbox);
    }
}

/// One unit's hop from its first collision.
fn hop_away(unit: &mut Unit, hit: &Rect, occupied: &[Rect], origin: Point, floor: Option<Point>) {
    let ax = if penetration(Axis::X, &unit.bbox, hit) <= penetration(Axis::Y, &unit.bbox, hit) {
        Axis::X
    } else {
        Axis::Y
    };
    // Away from the collider's centre; a tie, or a NaN, goes forward.
    let backward = ax.at(&unit.bbox, 0.5) < ax.at(hit, 0.5);
    let forward = !backward;
    let start = ax.near(&unit.bbox);
    let from = ax.pick(origin.x, origin.y);
    hop_clear(unit, ax, forward, occupied, from);
    // Inside a frame a hop up or left stops at the margin: past it the frame
    // would grow up or left to follow, and its top-left is the one thing it
    // keeps. Hopping the other way finds room the frame can grow into.
    if !forward
        && let Some(floor) = floor
        && ax.near(&unit.bbox) < ax.pick(floor.x, floor.y)
    {
        let back = start - ax.near(&unit.bbox);
        ax.shift(unit, back);
        hop_clear(unit, ax, true, occupied, from);
    }
}

/// Whether `unit` is lined up on `ax` with any neighbour: the same anchors
/// `align_bands` aligns TO, read off where the units actually ended up rather
/// than from a second notion of "lined up". The NEAR edge counts as lined up
/// against any of a neighbour's three; a centre or far edge only against the
/// same anchor of one.
fn anchored(units: &[Unit], at: usize, ax: Axis) -> bool {
    let Some(unit) = units.get(at) else { return false };
    units.iter().enumerate().filter(|(i, _)| *i != at).any(|(_, o)| {
        ax.band_fractions().iter().any(|&fraction| {
            let anchors = if js_eq(fraction, 0.0) {
                vec![ax.at(&o.bbox, 0.0), ax.at(&o.bbox, 0.5), ax.at(&o.bbox, 1.0)]
            } else {
                vec![ax.at(&o.bbox, fraction)]
            };
            on_some_anchor(ax.at(&unit.bbox, fraction), &anchors)
        })
    })
}

/// An off-grid position is only earned while the neighbour it lines up with is
/// still there. This puts back the ones that are not.
///
/// `align_bands` may leave a unit off the grid deliberately, lined up on a
/// neighbour's centre or far edge, which is what a reader calls aligned and the
/// grid cannot express. The overlap pass then runs, which can move THAT
/// NEIGHBOUR, and the unit is left off-grid lined up with nothing. The
/// neighbour guard in `align_bands` cannot see this family: it asks whether the
/// SNAPPED unit would overlap, and here it is the ANCHOR that moves.
pub(super) fn snap_stale_anchors(units: &mut [Unit], origin: Point) {
    for at in 0..units.len() {
        if !units.get(at).is_some_and(|u| u.movable) {
            continue;
        }
        for ax in AXES {
            let Some(unit) = units.get(at) else { continue };
            let here = ax.near(&unit.bbox);
            let snapped = round_to_grid(here, ax.pick(origin.x, origin.y));
            if js_eq(snapped, here) || anchored(units, at, ax) {
                continue;
            }
            if let Some(unit) = units.get_mut(at) {
                ax.shift(unit, snapped - here);
            }
        }
    }
}

/// The anchors a frame's level holds that the margin rule cannot move.
#[derive(Debug, Default)]
pub(super) struct Outside {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
}

/// Inside a frame: pulls every movable unit onto the margin it starts at.
///
/// An ANCHOR rather than only a floor: a member hugging the frame's top or left
/// edge is moved IN to it rather than the frame grown around it, and one already
/// clear of it but within `TIDY_BAND_PX` is pulled ONTO it. That is what makes
/// frames that line up hold members that line up.
pub(super) fn apply_floor(units: &mut [Unit], floor: Point, outside: &Outside) {
    for unit in units.iter_mut().filter(|u| u.movable) {
        for ax in AXES {
            let target = ax.pick(floor.x, floor.y);
            let at = ax.near(&unit.bbox);
            if at - target >= TIDY_BAND_PX {
                continue;
            }
            // Already lined up with something the frame does not hold: a
            // neighbour the margin rule cannot move IS the row, wherever it
            // sits. Only the ANCHOR yields; a member outside the margin is
            // still moved in, which is the floor's own job.
            if at >= target && on_some_anchor(at, ax.pick(&outside.x, &outside.y)) {
                continue;
            }
            ax.shift(unit, target - at);
        }
    }
}
