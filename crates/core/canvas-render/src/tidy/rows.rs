//! Row order by edges.
//!
//! A box whose connections along its own row all lie to one side of it, two or
//! more of them, is a hub drawn at the end of its row: the edge to the farther
//! box has to pass the nearer one, and the router pays with a crossing or a
//! loop. So the hub swaps places with the nearest of them. After the swap one
//! connection lies on each side, so the condition no longer holds and a second
//! tidy moves nothing. Frames are left alone (a frame's order is its members'
//! business), and so is a hub or partner that cannot move.

use super::axis::Axis;
use super::units::{Ctx, Node, TIDY_BAND_PX, Unit, js_ge};

/// The units this pass can reason about, by root key: a lone box, never a
/// frame. A repeated id takes the last.
fn sole_box_units(units: &[Unit], nodes: &[Node], keys: usize) -> Vec<Option<usize>> {
    let mut by_key = vec![None; keys];
    for (at, unit) in units.iter().enumerate() {
        let lone_box = unit.members.len() == 1
            && unit.members.first().and_then(|&m| nodes.get(m)).is_some_and(|n| !n.frame);
        if lone_box
            && let Some(key) = nodes.get(unit.root).map(|n| n.key)
            && let Some(slot) = by_key.get_mut(key)
        {
            *slot = Some(at);
        }
    }
    by_key
}

/// The id at `edge`'s other end, or `None` when it names neither.
fn other_end(edge: (Option<usize>, Option<usize>), key: usize) -> Option<usize> {
    if edge.0 == Some(key) {
        edge.1
    } else if edge.1 == Some(key) {
        edge.0
    } else {
        None
    }
}

/// `hub`'s connections that are lone boxes sitting in its own row, one per edge.
fn partners_along_row(
    units: &[Unit],
    hub: usize,
    hub_key: usize,
    edges: &[(Option<usize>, Option<usize>)],
    by_key: &[Option<usize>],
) -> Vec<usize> {
    let Some(me) = units.get(hub) else { return Vec::new() };
    edges
        .iter()
        .filter_map(|&edge| other_end(edge, hub_key))
        .filter_map(|key| by_key.get(key).copied().flatten())
        .filter(|&other| other != hub)
        // Kept unless the rows are a band apart, which a NaN gap is not.
        .filter(|&other| {
            units.get(other).is_some_and(|o| !js_ge((me.bbox.y - o.bbox.y).abs(), TIDY_BAND_PX))
        })
        .collect()
}

/// The partner `hub` should trade places with: the nearest of them, when they
/// ALL lie to one side, which is the condition that makes `hub` a hub drawn at
/// the end of its row. `None` when they straddle it (it is already between them)
/// or the nearest cannot move.
fn partner_to_swap_with(units: &[Unit], hub: usize, along: &[usize]) -> Option<usize> {
    if along.len() < 2 {
        return None;
    }
    let me = units.get(hub)?;
    let rects: Vec<_> = along.iter().filter_map(|&i| units.get(i).map(|u| u.bbox)).collect();
    let right = rects.iter().all(|u| u.x >= me.bbox.x + me.bbox.w);
    let left = rects.iter().all(|u| u.x + u.w <= me.bbox.x);
    if !right && !left {
        return None;
    }
    let mut nearest = *along.first()?;
    for &candidate in along {
        let gap = |i: usize| units.get(i).map_or(f64::NAN, |u| (u.bbox.x - me.bbox.x).abs());
        if gap(candidate) < gap(nearest) {
            nearest = candidate;
        }
    }
    units.get(nearest).is_some_and(|u| u.movable).then_some(nearest)
}

pub(super) fn order_rows_by_edges(units: &mut [Unit], nodes: &[Node], ctx: &Ctx) {
    let Some(edges) = ctx.edges.as_deref() else { return };
    let by_key = sole_box_units(units, nodes, ctx.in_scope.len());
    for hub in 0..units.len() {
        let Some(key) =
            units.get(hub).filter(|u| u.movable).and_then(|u| nodes.get(u.root)).map(|n| n.key)
        else {
            continue;
        };
        if by_key.get(key).copied().flatten().is_none() {
            continue;
        }
        let along = partners_along_row(units, hub, key, edges, &by_key);
        let Some(partner) = partner_to_swap_with(units, hub, &along) else { continue };
        let hub_x = units.get(hub).map_or(0.0, |u| u.bbox.x);
        let partner_x = units.get(partner).map_or(0.0, |u| u.bbox.x);
        if let Some(unit) = units.get_mut(hub) {
            Axis::X.shift(unit, partner_x - hub_x);
        }
        if let Some(unit) = units.get_mut(partner) {
            Axis::X.shift(unit, hub_x - partner_x);
        }
    }
}
