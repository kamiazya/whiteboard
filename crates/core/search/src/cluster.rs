//! Where an excerpt may be cut: on a grapheme boundary, found cheaply.
//!
//! Asking the segmenter is the cost, so nothing below U+0300 is asked about
//! (it cannot join the character before it, bar LF after CR and anything after
//! a Prepend character), and a cut that must ask asks over a window around it
//! rather than the whole text. UAX #29's rules are local except regional
//! indicators, grouped two by two counting from the start of the run, so a window
//! starts `LOCAL_UNITS` back or at the nearest boundary unit, and only a run
//! of flags pushes it further, to `LOOKBACK_UNITS`.
//!
//! ponytail: 64 units is the longest cluster a window is sure to hold whole;
//! a cluster longer than that (sixty-odd combining marks on one base) can
//! still be cut inside. 1024 units is 256 consecutive flags; past it the edge
//! falls back to code-point snapping, exact for everything but a flag
//! straddling the cut inside such a run.

use crate::units::{decode, slice};
use unicode_segmentation::UnicodeSegmentation;

const LOOKBACK_UNITS: usize = 1024;
const LOCAL_UNITS: usize = 64;

/// Code points that glue themselves to the character AFTER them (rule `GB9b`,
/// `Grapheme_Cluster_Break=Prepend`).
const PREPEND: [u32; 27] = [
    0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x0d4e,
    0x110bd, 0x110cd, 0x111c2, 0x111c3, 0x113d1, 0x1193f, 0x11941, 0x11a84, 0x11a85, 0x11a86,
    0x11a87, 0x11a88, 0x11a89, 0x11d46, 0x11f02,
];

fn unit_at(value: &[u16], at: usize) -> Option<u16> {
    value.get(at).copied()
}

/// Whether the code point ending at `at - 1` is a Prepend.
fn preceded_by_prepend(value: &[u16], at: usize) -> bool {
    let Some(unit) = at.checked_sub(1).and_then(|i| unit_at(value, i)) else { return false };
    if unit < 0x0600 {
        return false;
    }
    if !(0xdc00..=0xdfff).contains(&unit) {
        return PREPEND.contains(&u32::from(unit));
    }
    let Some(high) = at.checked_sub(2).and_then(|i| unit_at(value, i)) else { return false };
    char::decode_utf16([high, unit])
        .next()
        .and_then(Result::ok)
        .is_some_and(|c| PREPEND.contains(&u32::from(c)))
}

/// A cut no cluster can straddle, decided from two units: the cheap test.
fn is_boundary_unit(value: &[u16], at: usize) -> bool {
    if at == 0 || at == value.len() {
        return true;
    }
    unit_at(value, at).is_some_and(|unit| unit < 0x0300 && unit != 0x0a)
        && !preceded_by_prepend(value, at)
}

/// Whether the unit at `at` is the low half of a regional indicator.
fn ends_regional_indicator(value: &[u16], at: usize) -> bool {
    let low = unit_at(value, at);
    low.is_some_and(|u| (0xdde6..=0xddff).contains(&u))
        && at.checked_sub(1).and_then(|i| unit_at(value, i)) == Some(0xd83c)
}

/// Where a window around `at` can start and still segment as the document
/// does, or none when a run of flags outlasts the lookback.
fn window_start(value: &[u16], at: usize) -> Option<usize> {
    let floor = at.saturating_sub(LOOKBACK_UNITS);
    let mut saw_regional_indicator = false;
    let mut p = at;
    loop {
        if is_boundary_unit(value, p) {
            return Some(p);
        }
        if ends_regional_indicator(value, p) {
            saw_regional_indicator = true;
        } else if !saw_regional_indicator && at.saturating_sub(p) >= LOCAL_UNITS {
            return Some(p);
        }
        if p == floor {
            return None;
        }
        p = p.saturating_sub(1);
    }
}

/// The cluster the window around `at` puts `at` inside, in document offsets
/// (empty at the window's start when the window holds no cluster there).
fn cluster_around(value: &[u16], at: usize, from: usize) -> (usize, usize) {
    let span = decode(slice(value, from, at.saturating_add(LOCAL_UNITS)));
    let inside = at.saturating_sub(from);
    let mut offset = 0_usize;
    for grapheme in span.graphemes(true) {
        let end = offset.saturating_add(grapheme.encode_utf16().count());
        if inside < end {
            return (from.saturating_add(offset), from.saturating_add(end));
        }
        offset = end;
    }
    (from, from)
}

/// Past the low half of a pair, when the cut landed between the two.
fn snap_forward(value: &[u16], at: usize) -> usize {
    if unit_at(value, at).is_some_and(|u| (0xdc00..=0xdfff).contains(&u)) {
        at.saturating_add(1)
    } else {
        at
    }
}

/// Before the high half of a pair, when the cut landed between the two.
fn snap_back(value: &[u16], at: usize) -> usize {
    if at
        .checked_sub(1)
        .and_then(|i| unit_at(value, i))
        .is_some_and(|u| (0xd800..=0xdbff).contains(&u))
    {
        at.saturating_sub(1)
    } else {
        at
    }
}

/// The first grapheme boundary at or after `from`, inward.
#[must_use]
pub(crate) fn cluster_start_at_or_after(value: &[u16], from: usize) -> usize {
    if is_boundary_unit(value, from) {
        return from;
    }
    let Some(anchor) = window_start(value, from) else { return snap_forward(value, from) };
    let (start, end) = cluster_around(value, from, anchor);
    if start == from { from } else { end }
}

/// The last grapheme boundary at or before `to`, inward.
#[must_use]
pub(crate) fn cluster_end_at_or_before(value: &[u16], to: usize) -> usize {
    if is_boundary_unit(value, to) {
        return to;
    }
    let Some(anchor) = window_start(value, to) else { return snap_back(value, to) };
    cluster_around(value, to, anchor).0
}

/// Every grapheme boundary of `text` as a UTF-16 offset, for comparing this
/// segmenter with `Intl.Segmenter`'s.
#[must_use]
pub fn grapheme_cuts(text: &str) -> Vec<usize> {
    let mut offset = 0_usize;
    text.graphemes(true)
        .map(|grapheme| {
            let at = offset;
            offset = offset.saturating_add(grapheme.encode_utf16().count());
            at
        })
        .collect()
}

#[cfg(test)]
mod tests;
