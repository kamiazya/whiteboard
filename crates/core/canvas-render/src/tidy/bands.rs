//! Banded alignment: the pass that puts what a drawer nearly lined up onto one
//! line.
//!
//! Per axis and per anchor a drawer sets (the near edge, then the centre, then
//! on x the far edge) units whose anchors sit within `TIDY_BAND_PX` of the
//! band's FIRST member snap to one target. Banding by that fixed first anchor,
//! never a running mean, is what stops transitive chaining (A near B, C near
//! B's new spot) from dragging a whole diagonal into one line.

use whiteboard_det::math::{compare_numbers, js_round};

use super::axis::{Axis, round_to_grid};
use super::units::{TIDY_BAND_PX, Unit, overlaps_with_margin};

/// Separation. A centre or far-edge snap is cosmetic and separation is not, so
/// one that would put a unit inside a neighbour's margin yields. Without this
/// the fixpoint loop drifts: the snap jams the unit, the overlap pass hops it
/// away, and the next iteration snaps it back.
fn clear_after(units: &[Unit], ax: Axis, unit: usize, delta: f64) -> bool {
    let Some(me) = units.get(unit) else { return true };
    let moved = ax.moved(&me.bbox, delta);
    units.iter().enumerate().all(|(i, other)| i == unit || !overlaps_with_margin(moved, other.bbox))
}

/// The frame's margin. Inside a frame, a band may not push a unit back OUT past
/// it. The floor runs once, before these passes, so without this a band undoes
/// it, which made a frame grow for ever: a far-edge band snapped one member's
/// left edge to the grid, dragged its row-mate 3px left of the margin, the frame
/// grew to hold the escapee, and the level's own snap carried the whole unit
/// back, 3px wider on every tidy with no member moving.
fn inside_margin(units: &[Unit], ax: Axis, floor: Option<f64>, unit: usize, delta: f64) -> bool {
    let Some(me) = units.get(unit) else { return true };
    floor.is_none_or(|floor| ax.near(&me.bbox) + delta >= floor - 0.5)
}

/// The settings of one axis's pass.
#[derive(Clone, Copy)]
struct Pass {
    ax: Axis,
    origin: f64,
    floor: Option<f64>,
}

/// Puts a unit's near edge on the grid, if both guards allow it.
fn ground_on_grid(units: &mut [Unit], pass: Pass, unit: usize, guarded: bool) {
    let Some(me) = units.get(unit) else { return };
    let at = pass.ax.near(&me.bbox);
    let to_grid = round_to_grid(at, pass.origin) - at;
    if guarded && !clear_after(units, pass.ax, unit, to_grid) {
        return;
    }
    if !inside_margin(units, pass.ax, pass.floor, unit, to_grid) {
        return;
    }
    if let Some(me) = units.get_mut(unit) {
        pass.ax.shift(me, to_grid);
    }
}

/// Records who ended up sharing `target`: sharing the anchor with SOMETHING, to
/// the half pixel parity allows. A band whose every other snap yielded leaves
/// its first member alone, and alone it takes the grid like any other.
fn record_lined_up(
    units: &[Unit],
    band: &[usize],
    anchor: &dyn Fn(&Unit) -> f64,
    target: f64,
    lined: &mut [bool],
) {
    let at_target: Vec<usize> = band
        .iter()
        .copied()
        .filter(|&i| units.get(i).is_some_and(|u| (anchor(u) - target).abs() <= 0.5))
        .collect();
    if at_target.len() >= 2 {
        for i in at_target {
            if let Some(flag) = lined.get_mut(i) {
                *flag = true;
            }
        }
    }
}

fn is_lined(lined: &[bool], unit: usize) -> bool {
    lined.get(unit).copied().unwrap_or(false)
}

/// Snaps one band onto one target and records who ended up sharing it.
///
/// `fraction` is both which anchor this is and whether the snap is GUARDED: the
/// near edge is the row itself and takes its snap, a centre or far edge is
/// cosmetic and yields to the guard.
fn snap_band(units: &mut [Unit], band: &[usize], fraction: f64, pass: Pass, lined: &mut [bool]) {
    let ax = pass.ax;
    let anchor = |u: &Unit| ax.at(&u.bbox, fraction);
    let guarded = fraction > 0.0;
    // An immobile member is the band's truth, and so is one an earlier anchor
    // lined up: a movable one snaps onto it exactly, grid or no grid, since the
    // grid cannot move that neighbour and a 4px miss reads as a row drawn
    // carelessly. A band free to move as a whole puts its first member's edge on
    // the grid and follows it.
    let fixed = band
        .iter()
        .copied()
        .find(|&i| units.get(i).is_some_and(|u| !u.movable) || is_lined(lined, i));
    let Some(&first) = band.first() else { return };
    // A partner inside a neighbour's margin is about to be hopped away by the
    // overlap pass, so a centre or far-edge band follows only a partner that is
    // standing still.
    let partner = fixed.unwrap_or(first);
    if guarded && !clear_after(units, ax, partner, 0.0) {
        return;
    }
    if fixed.is_none() {
        ground_on_grid(units, pass, first, guarded);
    }
    let Some(target) = units.get(partner).map(anchor) else { return };
    for &i in band {
        let Some(unit) = units.get(i) else { continue };
        if !unit.movable || is_lined(lined, i) {
            continue;
        }
        // A centre between a box of each parity is a half pixel; the edge takes
        // the whole pixel nearest, since the output is rounded and a snap the
        // rounding undoes is not a snap.
        let edge = ax.near(&unit.bbox);
        let delta = js_round(edge + target - anchor(unit)) - edge;
        if guarded && delta != 0.0 && !clear_after(units, ax, i, delta) {
            continue;
        }
        if !inside_margin(units, ax, pass.floor, i, delta) {
            continue;
        }
        if let Some(unit) = units.get_mut(i) {
            ax.shift(unit, delta);
        }
    }
    record_lined_up(units, band, &anchor, target, lined);
}

/// Banded alignment along one axis. A unit lined up by an earlier anchor is that
/// band's truth for the later ones and does not move again; a unit alone at its
/// edge may still be centred under a wider neighbour, which a reader calls lined
/// up and an edge band could never see.
pub(super) fn align_bands(units: &mut [Unit], ax: Axis, origin: f64, floor: Option<f64>) {
    let pass = Pass { ax, origin, floor };
    let mut lined = vec![false; units.len()];
    for &fraction in ax.band_fractions() {
        for band in bands_by(units, &|u: &Unit| ax.at(&u.bbox, fraction)) {
            if band.len() >= 2 {
                snap_band(units, &band, fraction, pass, &mut lined);
            }
        }
    }
    // A unit in no band at all takes the grid at its edge. Unguarded: an edge
    // snap is the row itself, not a cosmetic one, so only the margin refuses.
    for i in 0..units.len() {
        if units.get(i).is_some_and(|u| u.movable) && !is_lined(&lined, i) {
            ground_on_grid(units, pass, i, false);
        }
    }
}

/// Bands by the fixed first anchor, never a running mean. STRICT inequality:
/// consecutive band targets are at least one band apart (multiples of the
/// grid), so a snapped unit sitting exactly one band from a neighbour must not
/// re-join it on a later pass.
fn bands_by(units: &[Unit], anchor: &dyn Fn(&Unit) -> f64) -> Vec<Vec<usize>> {
    let mut order: Vec<usize> = (0..units.len()).collect();
    let at = |i: usize| units.get(i).map_or(f64::NAN, anchor);
    order.sort_by(|&a, &b| compare_numbers(at(a), at(b)));
    let mut bands: Vec<Vec<usize>> = Vec::new();
    let mut band: Vec<usize> = Vec::new();
    let mut band_first = 0.0;
    for i in order {
        if band.is_empty() || at(i) - band_first >= TIDY_BAND_PX {
            if !band.is_empty() {
                bands.push(core::mem::take(&mut band));
            }
            band_first = at(i);
        }
        band.push(i);
    }
    if !band.is_empty() {
        bands.push(band);
    }
    bands
}
