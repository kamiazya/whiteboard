//! The pairwise derivations: overlaps, containment and proximity clusters.

use core::cmp::Ordering;

use whiteboard_det::math::{compare_numbers, hypot, js_max, js_min};
use whiteboard_scene::BoundingBox;

use super::{Entry, PAIRWISE_MAX_ENTRIES};

/// Two bboxes join one cluster when their gap is at most this, in px.
const PROXIMITY_THRESHOLD_PX: f64 = 24.0;
/// Upper bound on the overlap pairs reported; the scan stops at the next one.
const OVERLAP_MAX_PAIRS: usize = 1_000;

/// `compareCodeUnit`: UTF-16 code unit order, which differs from UTF-8 byte
/// order for a supplementary character against U+E000 to U+FFFF.
pub(crate) fn code_unit_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn area(b: &BoundingBox) -> f64 {
    b.w * b.h
}

/// The shared area of two boxes; touching edges share none, and a NaN reads as none.
fn overlap_area(a: &BoundingBox, b: &BoundingBox) -> f64 {
    let w = js_min(a.x + a.w, b.x + b.w) - js_max(a.x, b.x);
    let h = js_min(a.y + a.h, b.y + b.h) - js_max(a.y, b.y);
    if w > 0.0 && h > 0.0 { w * h } else { 0.0 }
}

/// A parent must be strictly larger than its child: two equal boxes are
/// overlap, not containment, so the relation stays antisymmetric.
fn strictly_contains(parent: &BoundingBox, child: &BoundingBox) -> bool {
    child.x >= parent.x
        && child.y >= parent.y
        && child.x + child.w <= parent.x + parent.w
        && child.y + child.h <= parent.y + parent.h
        && area(parent) > area(child)
}

fn gap_between(a: &BoundingBox, b: &BoundingBox) -> f64 {
    let dx = js_max(js_max(a.x - (b.x + b.w), b.x - (a.x + a.w)), 0.0);
    let dy = js_max(js_max(a.y - (b.y + b.h), b.y - (a.y + a.h)), 0.0);
    hypot(dx, dy)
}

fn sort_pairs(pairs: &mut [[String; 2]]) {
    pairs.sort_by(|[a1, b1], [a2, b2]| {
        code_unit_order(a1, a2).then_with(|| code_unit_order(b1, b2))
    });
}

/// The first [`OVERLAP_MAX_PAIRS`] overlapping pairs in entry order, each pair
/// ordered by code unit, and whether the scan stopped short of the rest.
pub(super) fn overlaps(entries: &[Entry]) -> (Vec<[String; 2]>, bool) {
    if entries.len() > PAIRWISE_MAX_ENTRIES {
        return (Vec::new(), false);
    }
    let mut pairs: Vec<[String; 2]> = Vec::new();
    for (i, a) in entries.iter().enumerate() {
        for b in entries.iter().skip(i.saturating_add(1)) {
            if overlap_area(&a.bbox, &b.bbox) <= 0.0 {
                continue;
            }
            if pairs.len() == OVERLAP_MAX_PAIRS {
                sort_pairs(&mut pairs);
                return (pairs, true);
            }
            let ordered = if code_unit_order(&a.id, &b.id) == Ordering::Greater {
                [b.id.clone(), a.id.clone()]
            } else {
                [a.id.clone(), b.id.clone()]
            };
            pairs.push(ordered);
        }
    }
    sort_pairs(&mut pairs);
    (pairs, false)
}

/// Each entry's parent: the smallest box strictly holding it, the smaller id
/// first when two tie on area. A second entry wearing the child's own id is
/// never its parent.
pub(super) fn containment(entries: &[Entry]) -> Vec<super::Containment> {
    if entries.len() > PAIRWISE_MAX_ENTRIES {
        return Vec::new();
    }
    let mut result: Vec<super::Containment> = entries
        .iter()
        .filter_map(|child| {
            entries
                .iter()
                .filter(|parent| {
                    parent.id != child.id && strictly_contains(&parent.bbox, &child.bbox)
                })
                .min_by(|a, b| {
                    compare_numbers(area(&a.bbox), area(&b.bbox))
                        .then_with(|| code_unit_order(&a.id, &b.id))
                })
                .map(|parent| super::Containment {
                    parent: parent.id.clone(),
                    child: child.id.clone(),
                })
        })
        .collect();
    result.sort_by(|a, b| {
        code_unit_order(&a.child, &b.child).then_with(|| code_unit_order(&a.parent, &b.parent))
    });
    result
}

/// Every id reachable from entry `seed` by a gap within the threshold, or by
/// sharing an id (the TypeScript's union-find keys on the id). Marks what it
/// reaches in `visited`.
fn component(entries: &[Entry], visited: &mut [bool], seed: usize) -> Vec<String> {
    let mut ids = Vec::new();
    let mut stack = vec![seed];
    if let Some(flag) = visited.get_mut(seed) {
        *flag = true;
    }
    // Each entry is pushed once, so `entries.len()` pops drain the stack; the
    // bound keeps a defect in the visited test from growing it without end.
    for _ in 0..entries.len() {
        let Some(current) = stack.pop().and_then(|index| entries.get(index)) else { break };
        ids.push(current.id.clone());
        for (index, (flag, other)) in visited.iter_mut().zip(entries).enumerate() {
            let near = gap_between(&current.bbox, &other.bbox) <= PROXIMITY_THRESHOLD_PX;
            if !*flag && (near || current.id == other.id) {
                *flag = true;
                stack.push(index);
            }
        }
    }
    ids
}

/// Single-linkage clusters by proximity gap, ids sorted within a cluster and
/// clusters by their first id.
pub(super) fn clusters(entries: &[Entry]) -> Vec<Vec<String>> {
    if entries.len() > PAIRWISE_MAX_ENTRIES {
        return Vec::new();
    }
    let mut seen = vec![false; entries.len()];
    let mut groups: Vec<Vec<String>> = Vec::new();
    for seed in 0..entries.len() {
        if seen.get(seed).copied().unwrap_or(true) {
            continue;
        }
        let mut ids = component(entries, &mut seen, seed);
        ids.sort_by(|a, b| code_unit_order(a, b));
        groups.push(ids);
    }
    groups.sort_by(|a, b| match (a.first(), b.first()) {
        (Some(x), Some(y)) => code_unit_order(x, y),
        _ => Ordering::Equal,
    });
    groups
}
