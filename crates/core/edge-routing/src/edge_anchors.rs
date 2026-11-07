//! The anchor pass, ported from canvas-render's `edge-anchors.ts`: WHERE on
//! its chosen side an edge attaches, given every other edge sharing that
//! (node, side). Ends sharing a side are spread along it in a stable order
//! and leave through distinct stub lanes (`build_anchor_groups`); a trial
//! that re-sides one edge patches the incumbent partition instead of
//! rebuilding it (`patch_anchor_groups`).
//!
//! The partition and the placed entries are [`JsMap`]s because the
//! TypeScript's are `Map`s, and their order is observable: the output's
//! entry order is the order edges were first placed, and a group emptied by
//! a patch and joined again moves to the end.

use crate::edge_geometry::{Side, center_of, side_point_at, tangent_coordinate};
use crate::edge_rules::{LaneAxis, SidePair, facing_lane_window, opposite_side};
use crate::edge_sides::{
    EdgeAnchorOverride, EdgeAnchorPair, ORTHOGONAL_STUB_PX, STUB_LANE_STEP_PX,
};
use crate::geometry::{Point, Rect};
use crate::js_map::JsMap;
use crate::routing_input::{EdgeId, NodeId, RoutableEdge, RoutingNode, node_at_end};
use whiteboard_det::math::{compare_numbers, js_max, js_min, js_sign};

/// One edge's two boxes and their centres, as `AnchorEnds`.
#[derive(Debug, Clone, Copy)]
struct AnchorEnds {
    from_rect: Rect,
    to_rect: Rect,
    from_center: Point,
    to_center: Point,
}

/// The layout-invariant half of the anchor pass's input, as `AnchorContext`:
/// built once per search, `ends` indexed by edge position.
pub struct AnchorContext<'a> {
    edges: &'a [RoutableEdge],
    ends: Vec<Option<AnchorEnds>>,
}

/// `anchorContext`: each edge's boxes, `None` when either end names no node.
#[must_use]
pub fn anchor_context<'a>(nodes: &[RoutingNode], edges: &'a [RoutableEdge]) -> AnchorContext<'a> {
    let ends = edges
        .iter()
        .map(|edge| {
            let from_rect = node_at_end(nodes, &edge.from)?.rect;
            let to_rect = node_at_end(nodes, &edge.to)?.rect;
            Some(AnchorEnds {
                from_rect,
                to_rect,
                from_center: center_of(from_rect),
                to_center: center_of(to_rect),
            })
        })
        .collect();
    AnchorContext { edges, ends }
}

/// Which end of its edge an [`AnchorEnd`] is; `From` sorts first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Role {
    From,
    To,
}

/// One end of one edge, as the fan-out sees it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnchorEnd {
    edge_id: EdgeId,
    edge_index: usize,
    role: Role,
    rect: Rect,
    side: Side,
    far_center: Point,
}

/// A group's key, as `` `${endNode} ${side}` ``.
type GroupKey = (Option<NodeId>, Side);

/// The partition plus the entries placed from it, as `AnchorGroups`.
#[derive(Debug, Clone, PartialEq)]
pub struct AnchorGroups {
    pub groups: JsMap<GroupKey, Vec<AnchorEnd>>,
    pub entries: JsMap<EdgeId, EdgeAnchorPair>,
}

fn group_key(edge: &RoutableEdge, role: Role, side: Side) -> GroupKey {
    let end = if role == Role::From { &edge.from } else { &edge.to };
    (end.node(), side)
}

fn ends_of_edge(
    ctx: &AnchorContext<'_>,
    edge_index: usize,
    sides: &JsMap<EdgeId, SidePair>,
) -> Option<[AnchorEnd; 2]> {
    let edge = ctx.edges.get(edge_index)?;
    let geom = (*ctx.ends.get(edge_index)?)?;
    let chosen = sides.get(&edge.id)?;
    let end = |role, rect, side, far_center| AnchorEnd {
        edge_id: edge.id,
        edge_index,
        role,
        rect,
        side,
        far_center,
    };
    Some([
        end(Role::From, geom.from_rect, chosen.from_side, geom.to_center),
        end(Role::To, geom.to_rect, chosen.to_side, geom.from_center),
    ])
}

/// Fan-out and lane depth for ONE group, as `placeAnchorGroup`: each end
/// writes only its own half of its edge's entry.
fn place_anchor_group(group: &[AnchorEnd], entries: &mut JsMap<EdgeId, EdgeAnchorPair>) {
    let mut ordered = group.to_vec();
    // A consistent comparator, so any stable sort answers as V8's does.
    ordered.sort_by(|a, b| {
        compare_numbers(
            tangent_coordinate(a.side, a.far_center),
            tangent_coordinate(b.side, b.far_center),
        )
        .then(a.edge_index.cmp(&b.edge_index))
        .then(a.role.cmp(&b.role))
    });
    #[expect(clippy::cast_precision_loss, reason = "a group's size is far below 2^53")]
    let slots = ordered.len() as f64 + 1.0;
    let placed: Vec<(AnchorEnd, Point, f64)> = ordered
        .iter()
        .enumerate()
        .map(|(i, end)| {
            #[expect(clippy::cast_precision_loss, reason = "an index is far below 2^53")]
            let point = side_point_at(end.rect, end.side, (i as f64 + 1.0) / slots);
            (*end, point, tangent_coordinate(end.side, point))
        })
        .collect();
    let mut sorted_t: Vec<f64> = placed.iter().map(|p| p.2).collect();
    sorted_t.sort_by(|a, b| compare_numbers(*a, *b));
    for (end, point, t) in placed {
        let dir = js_sign(tangent_coordinate(end.side, end.far_center) - t);
        #[expect(clippy::cast_precision_loss, reason = "a rank is far below 2^53")]
        let depth = ORTHOGONAL_STUB_PX + sweep_rank(&sorted_t, t, dir) as f64 * STUB_LANE_STEP_PX;
        let mut entry = entries.get(&end.edge_id).copied().unwrap_or_default();
        if end.role == Role::From {
            entry.from = Some(point);
            entry.from_lane_depth = Some(depth);
            entry.from_side = Some(end.side);
        } else {
            entry.to = Some(point);
            entry.to_lane_depth = Some(depth);
            entry.to_side = Some(end.side);
        }
        entries.set(end.edge_id, entry);
    }
}

/// How many of the side's ends an end sweeping in `dir` from `t` passes, as
/// `sweepRank`.
fn sweep_rank(sorted_t: &[f64], t: f64, dir: f64) -> usize {
    if dir == 0.0 {
        return 0;
    }
    if dir > 0.0 {
        return sorted_t.len().saturating_sub(first_index_where(sorted_t, |other| other > t));
    }
    if t.is_nan() {
        return 0;
    }
    first_index_where(sorted_t, |other| other >= t)
}

/// The first index whose value satisfies a monotone `holds`, by the
/// TypeScript's own bisection (NaN sorts last and satisfies nothing).
fn first_index_where(sorted: &[f64], holds: impl Fn(f64) -> bool) -> usize {
    let (mut lo, mut hi) = (0, sorted.len());
    while lo < hi {
        let mid = lo.midpoint(hi);
        if sorted.get(mid).is_some_and(|&v| holds(v)) {
            hi = mid;
        } else {
            lo = mid.saturating_add(1);
        }
    }
    lo
}

/// The whole partition, placed, as `buildAnchorGroups`.
#[must_use]
pub fn build_anchor_groups(
    ctx: &AnchorContext<'_>,
    sides: &JsMap<EdgeId, SidePair>,
) -> AnchorGroups {
    let mut groups: JsMap<GroupKey, Vec<AnchorEnd>> = JsMap::default();
    for (edge_index, edge) in ctx.edges.iter().enumerate() {
        let Some(ends) = ends_of_edge(ctx, edge_index, sides) else { continue };
        for end in ends {
            let key = group_key(edge, end.role, end.side);
            if let Some(group) = groups.get_mut(&key) {
                group.push(end);
            } else {
                groups.set(key, vec![end]);
            }
        }
    }
    let mut entries = JsMap::default();
    for group in groups.values() {
        place_anchor_group(group, &mut entries);
    }
    AnchorGroups { groups, entries }
}

/// The ends' previous sides, read off the base entry, as the patch reads them.
fn previous_sides(base: &AnchorGroups, edge: &RoutableEdge) -> [(Role, Option<Side>); 2] {
    let previous = base.entries.get(&edge.id);
    [(Role::From, previous.and_then(|p| p.from_side)), (Role::To, previous.and_then(|p| p.to_side))]
}

/// The same partition with ONE edge re-sided, as `patchAnchorGroups`: only
/// the groups the edge leaves and joins are re-placed, and `base` is left
/// untouched.
#[must_use]
pub fn patch_anchor_groups(
    ctx: &AnchorContext<'_>,
    base: &AnchorGroups,
    sides: &JsMap<EdgeId, SidePair>,
    edge_index: usize,
) -> AnchorGroups {
    let (Some(edge), Some(next)) =
        (ctx.edges.get(edge_index), ends_of_edge(ctx, edge_index, sides))
    else {
        return base.clone();
    };
    let mut groups = base.groups.clone();
    let mut touched: Vec<GroupKey> = Vec::new();
    let mut replace = |key: GroupKey, mutate: &dyn Fn(Vec<AnchorEnd>) -> Vec<AnchorEnd>| {
        let members = mutate(groups.get(&key).cloned().unwrap_or_default());
        if members.is_empty() {
            groups.delete(&key);
        } else {
            groups.set(key, members);
        }
        if !touched.contains(&key) {
            touched.push(key);
        }
    };
    for (role, side) in previous_sides(base, edge) {
        let Some(side) = side else { continue };
        replace(group_key(edge, role, side), &|members| {
            members.into_iter().filter(|m| !(m.edge_id == edge.id && m.role == role)).collect()
        });
    }
    for end in next {
        replace(group_key(edge, end.role, end.side), &|mut members| {
            members.push(end);
            members
        });
    }
    let mut entries = base.entries.clone();
    for key in &touched {
        if let Some(group) = groups.get(key) {
            place_anchor_group(group, &mut entries);
        }
    }
    AnchorGroups { groups, entries }
}

/// How many members the patch would re-place, as `patchWork`.
#[must_use]
pub fn patch_work(
    ctx: &AnchorContext<'_>,
    base: &AnchorGroups,
    sides: &JsMap<EdgeId, SidePair>,
    edge_index: usize,
) -> usize {
    let (Some(edge), Some(next)) =
        (ctx.edges.get(edge_index), ends_of_edge(ctx, edge_index, sides))
    else {
        return 0;
    };
    // At most four keys (two groups left, two joined), so a list does.
    let mut counts: Vec<(GroupKey, usize)> = Vec::new();
    let mut adjust = |key: GroupKey, by: fn(usize) -> usize| {
        if let Some(slot) = counts.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = by(slot.1);
        } else {
            counts.push((key, by(base.groups.get(&key).map_or(0, Vec::len))));
        }
    };
    for (role, side) in previous_sides(base, edge) {
        let Some(side) = side else { continue };
        adjust(group_key(edge, role, side), |n| n.saturating_sub(1));
    }
    for end in next {
        adjust(group_key(edge, end.role, end.side), |n| n.saturating_add(1));
    }
    counts.iter().map(|(_, n)| n).sum()
}

/// Whether the two boxes are clear of each other in the chosen direction, as
/// `facesForward`.
fn faces_forward(from_side: Side, axis: LaneAxis, from: Rect, to: Rect) -> bool {
    match (axis, from_side) {
        (LaneAxis::H, Side::Right) => from.x + from.w <= to.x,
        (LaneAxis::H, _) => to.x + to.w <= from.x,
        (LaneAxis::V, Side::Bottom) => from.y + from.h <= to.y,
        (LaneAxis::V, _) => to.y + to.h <= from.y,
    }
}

/// Both anchors of a facing opposing pair, each alone on its side, slid to
/// one tangent coordinate inside the shared lane, as `slidFacingPair`.
fn slid_facing_pair(
    entry: &EdgeAnchorPair,
    chosen: Option<&SidePair>,
    geom: Option<AnchorEnds>,
    edge: &RoutableEdge,
    groups: &JsMap<GroupKey, Vec<AnchorEnd>>,
) -> Option<(Point, Point)> {
    let (chosen, from, to) = (chosen?, entry.from?, entry.to?);
    if chosen.to_side != opposite_side(chosen.from_side) {
        return None;
    }
    let geom = geom?;
    let crowded = |key: GroupKey| groups.get(&key).map_or(0, Vec::len) > 1;
    if crowded((edge.from.node(), chosen.from_side)) || crowded((edge.to.node(), chosen.to_side)) {
        return None;
    }
    let axis = if matches!(chosen.from_side, Side::Left | Side::Right) {
        LaneAxis::H
    } else {
        LaneAxis::V
    };
    if !faces_forward(chosen.from_side, axis, geom.from_rect, geom.to_rect) {
        return None;
    }
    let (low, high) = facing_lane_window(geom.from_rect, geom.to_rect, axis)?;
    #[expect(
        clippy::manual_midpoint,
        reason = "the TypeScript's (a + b) / 2, which f64::midpoint answers differently past overflow"
    )]
    let natural = if axis == LaneAxis::H { (from.y + to.y) / 2.0 } else { (from.x + to.x) / 2.0 };
    let t = js_min(high, js_max(low, natural));
    Some(if axis == LaneAxis::H {
        (Point { x: from.x, y: t }, Point { x: to.x, y: t })
    } else {
        (Point { x: t, y: from.y }, Point { x: t, y: to.y })
    })
}

/// One entry with what a pin committed written over it, field by field, as
/// `pinnedEntry`.
fn pinned_entry(entry: EdgeAnchorPair, pin: &EdgeAnchorOverride) -> EdgeAnchorPair {
    EdgeAnchorPair {
        from: pin.from.or(entry.from),
        from_lane_depth: pin.from_lane_depth.or(entry.from_lane_depth),
        to: pin.to.or(entry.to),
        to_lane_depth: pin.to_lane_depth.or(entry.to_lane_depth),
        ..entry
    }
}

/// `copyAround`, then the pins, as `computeAnchorsFor`'s `applyPins`.
fn apply_pins(
    anchors: &mut JsMap<EdgeId, EdgeAnchorPair>,
    sides: &JsMap<EdgeId, SidePair>,
    pins: Option<&JsMap<EdgeId, EdgeAnchorOverride>>,
) {
    for (id, pair) in sides.iter() {
        if let Some(entry) = anchors.get_mut(id).filter(|_| pair.around) {
            entry.around = true;
        }
    }
    for (id, pin) in pins.into_iter().flat_map(JsMap::iter) {
        if let Some(entry) = anchors.get_mut(id) {
            *entry = pinned_entry(*entry, pin);
        }
    }
}

/// Grouping, fan-out and lane depths for a FIXED side configuration, as
/// `computeAnchorsFor`; `placement` is a partition already placed for
/// exactly these sides, when the caller has one.
#[must_use]
pub fn compute_anchors_for(
    ctx: &AnchorContext<'_>,
    sides: &JsMap<EdgeId, SidePair>,
    align: bool,
    pins: Option<&JsMap<EdgeId, EdgeAnchorOverride>>,
    placement: Option<AnchorGroups>,
) -> JsMap<EdgeId, EdgeAnchorPair> {
    let AnchorGroups { groups, entries } =
        placement.unwrap_or_else(|| build_anchor_groups(ctx, sides));
    let mut anchors = entries;
    if align {
        for (edge_index, edge) in ctx.edges.iter().enumerate() {
            let pin = pins.and_then(|p| p.get(&edge.id));
            if pin.is_some_and(|p| p.from.is_some() || p.to.is_some()) {
                continue;
            }
            let Some(entry) = anchors.get(&edge.id).copied() else { continue };
            let geom = ctx.ends.get(edge_index).copied().flatten();
            if let Some((from, to)) =
                slid_facing_pair(&entry, sides.get(&edge.id), geom, edge, &groups)
            {
                anchors.set(edge.id, EdgeAnchorPair { from: Some(from), to: Some(to), ..entry });
            }
        }
    }
    apply_pins(&mut anchors, sides, pins);
    anchors
}

#[cfg(test)]
mod tests {
    use super::{AnchorGroups, anchor_context, build_anchor_groups, patch_anchor_groups};
    use crate::edge_geometry::Side;
    use crate::edge_rules::SidePair;
    use crate::geometry::Rect;
    use crate::js_map::JsMap;
    use crate::routing_input::{RoutableEdge, RoutingEnd, RoutingNode};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn node(id: u32, x: f64, y: f64) -> RoutingNode {
        RoutingNode { id, rect: Rect { x, y, w: 40.0, h: 30.0 } }
    }

    fn edge(id: u32, from: u32, to: u32) -> RoutableEdge {
        let end = |node| RoutingEnd::Node { node, side: None, arrowhead: None };
        RoutableEdge { id, from: end(from), to: end(to), bends: None }
    }

    fn pair(from_side: Side, to_side: Side) -> SidePair {
        SidePair { from_side, to_side, around: false }
    }

    /// A partition as a set, members included: order is the one thing a
    /// patch may differ in, since a joining end is appended and a group
    /// emptied and joined again moves to the end.
    fn as_set(g: &AnchorGroups) -> (Vec<String>, Vec<String>) {
        let mut groups: Vec<String> = g
            .groups
            .iter()
            .map(|(key, members)| {
                let mut members = members.clone();
                members.sort_by_key(|m| (m.edge_index, m.role));
                format!("{key:?} {members:?}")
            })
            .collect();
        let mut entries: Vec<String> = g.entries.iter().map(|e| format!("{e:?}")).collect();
        groups.sort();
        entries.sort();
        (groups, entries)
    }

    /// `patchAnchorGroups` is a second producer of the partition
    /// `buildAnchorGroups` produces, so the two must agree, as the
    /// TypeScript's `anchor-groups.properties.test.ts` holds them. Each case
    /// re-sides one edge: off a crowded side, onto one, and off a side it
    /// held alone (emptying that group).
    #[test]
    fn a_patched_partition_is_the_rebuilt_one() {
        let nodes = [node(0, 0.0, 0.0), node(1, 200.0, 0.0), node(2, 200.0, 120.0)];
        let edges = [edge(0, 0, 1), edge(1, 0, 2), edge(2, 1, 2)];
        let ctx = anchor_context(&nodes, &edges);
        let base: JsMap<u32, SidePair> = [
            (0, pair(Side::Right, Side::Left)),
            (1, pair(Side::Right, Side::Left)),
            (2, pair(Side::Bottom, Side::Top)),
        ]
        .into_iter()
        .collect();
        let placed = build_anchor_groups(&ctx, &base);
        for (index, re_sided) in [
            (1, pair(Side::Bottom, Side::Top)),
            (2, pair(Side::Left, Side::Right)),
            (0, pair(Side::Top, Side::Top)),
        ] {
            let mut next = base.clone();
            next.set(u32::try_from(index).unwrap_or(0), re_sided);
            let patched = patch_anchor_groups(&ctx, &placed, &next, index);
            assert_eq!(as_set(&patched), as_set(&build_anchor_groups(&ctx, &next)), "{index}");
        }
    }
}
