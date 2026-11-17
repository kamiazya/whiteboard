//! The short plain-text excerpt around a match that a search result and a
//! backlink context show.

use crate::cluster::{cluster_end_at_or_before, cluster_start_at_or_after};
use crate::markup::{LinkLabel, leaf_of_path, link_at, plain, render_links, strip_markup};
use crate::units::{decode, encode, slice};
use std::collections::BTreeMap;

/// How much text either side of the match an excerpt carries, in UTF-16 code
/// units.
pub const CONTEXT_RADIUS: usize = 60;

/// How far either side of an edge it looks for a link it might sit inside.
const LINK_REACH_UNITS: usize = 512;

/// Stands in for the match while its surroundings are stripped.
const MATCH_SLOT: u16 = 0xe000;

/// A document a link can name, by path or by id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkEntry {
    pub document_id: String,
    pub path: String,
    pub name: Option<String>,
}

/// A `LinkLabel` over a listing: a link names its target by path or by
/// document id, and reads as that document's display name when it has one,
/// else as its path's last segment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinkLabels {
    names: BTreeMap<String, String>,
}

impl LinkLabels {
    #[must_use]
    pub fn from_entries<'a>(entries: impl IntoIterator<Item = &'a LinkEntry>) -> Self {
        let mut names = BTreeMap::new();
        for entry in entries {
            // By id, even unnamed: the id is no word anybody reads, the path's
            // leaf is.
            let shown = entry.name.clone().unwrap_or_else(|| leaf_of_path(&entry.path).to_owned());
            names.insert(entry.document_id.clone(), shown);
            if let Some(name) = &entry.name {
                names.insert(entry.path.clone(), name.clone());
            }
        }
        Self { names }
    }

    #[must_use]
    pub fn label(&self, target: &str) -> Option<String> {
        self.names.get(target).cloned()
    }
}

/// The link `at` falls strictly inside, if any: where an excerpt may not be
/// cut. It looks only within `LINK_REACH_UNITS` either side.
fn link_around(value: &[u16], at: usize) -> Option<(usize, usize)> {
    if at == 0 || at >= value.len() {
        return None;
    }
    let from = at.saturating_sub(LINK_REACH_UNITS);
    let near = slice(value, from, at.saturating_add(LINK_REACH_UNITS));
    let local = at.saturating_sub(from);
    let before = local.saturating_sub(1);
    // A cut between `!` and `[[` is inside the embed too.
    let embed_at = near.get(before..).is_some_and(|rest| rest.starts_with(&[0x21, 0x5b, 0x5b]));
    let open = if embed_at { before } else { last_open_at_or_before(near, before)? };
    let start = if near.get(open) == Some(&0x5b)
        && open.checked_sub(1).and_then(|i| near.get(i)) == Some(&0x21)
    {
        open.saturating_sub(1)
    } else {
        open
    };
    let end = link_at(near, start)?.end;
    (start < local && local < end).then_some((from.saturating_add(start), from.saturating_add(end)))
}

/// `lastIndexOf('[[', at)`.
fn last_open_at_or_before(units: &[u16], at: usize) -> Option<usize> {
    (0..=at)
        .rev()
        .find(|i| units.get(*i) == Some(&0x5b) && units.get(i.saturating_add(1)) == Some(&0x5b))
}

/// The match, widened to whole links where it starts or ends inside one.
fn match_span(value: &[u16], index: usize, length: usize) -> (usize, usize) {
    let end = index.saturating_add(length);
    (
        link_around(value, index).map_or(index, |(start, _)| start),
        link_around(value, end).map_or(end, |(_, link_end)| link_end),
    )
}

/// A window edge moved off any link it fell inside: outward over a link the
/// match is part of, inward past one it is not.
fn snap_start(value: &[u16], at: usize, matched: (usize, usize)) -> usize {
    match link_around(value, at) {
        None => at,
        Some((start, end)) => {
            if end > matched.0 {
                start.min(matched.0)
            } else {
                end
            }
        }
    }
}

fn snap_end(value: &[u16], at: usize, matched: (usize, usize)) -> usize {
    match link_around(value, at) {
        None => at,
        Some((start, end)) => {
            if start < matched.1 {
                end.max(matched.1)
            } else {
                start
            }
        }
    }
}

/// The excerpt with its markup stripped everywhere but the match itself,
/// which stays as written so a caller can still find and highlight it, bar a
/// link, which reads as its label there too.
fn plain_excerpt(
    value: &[u16],
    cut: (usize, usize),
    matched: (usize, usize),
    label_of: Option<LinkLabel<'_>>,
) -> Vec<u16> {
    let (start, end) = cut;
    let match_start = start.max(end.min(matched.0));
    let match_end = match_start.max(end.min(matched.1));
    let mut slotted = slice(value, start, match_start).to_vec();
    slotted.push(MATCH_SLOT);
    slotted.extend_from_slice(slice(value, match_end, end));
    let stripped = strip_markup(&slotted, label_of);
    let mut parts = stripped.split(|unit| *unit == MATCH_SLOT);
    let head = parts.next().unwrap_or_default();
    let tail = parts.next().unwrap_or_default();
    let mut out = head.to_vec();
    out.extend(render_links(slice(value, match_start, match_end), label_of));
    out.extend_from_slice(tail);
    out
}

/// A short plain-text excerpt around `[index, index + length)` (UTF-16 code
/// units), whitespace collapsed, ellipsised at cut edges, a `[[link]]` shown
/// as what it reads as and never cut through. Both edges snap INWARD to a
/// grapheme boundary, so an excerpt can never grow past the radius it was
/// asked for.
#[must_use]
pub fn snippet_around(
    value: &str,
    index: usize,
    length: usize,
    label_of: Option<LinkLabel<'_>>,
) -> String {
    let units = encode(value);
    let matched = match_span(&units, index, length);
    let start = snap_start(
        &units,
        cluster_start_at_or_after(&units, matched.0.saturating_sub(CONTEXT_RADIUS)),
        matched,
    );
    let end = snap_end(
        &units,
        cluster_end_at_or_before(&units, units.len().min(matched.1.saturating_add(CONTEXT_RADIUS))),
        matched,
    );
    let text = if start < end {
        decode(&plain(&plain_excerpt(&units, (start, end), matched, label_of)))
    } else {
        String::new()
    };
    let before = if start > 0 { "…" } else { "" };
    let after = if end < units.len() { "…" } else { "" };
    format!("{before}{text}{after}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const NEEDLE: &str = "needle";

    #[test]
    fn a_window_edge_at_the_start_of_a_link_keeps_the_whole_link() {
        // The left edge, 60 units before the match, is the link's first unit.
        let text =
            format!("{}[[a/b]]{}{NEEDLE}{}", "x".repeat(10), "z".repeat(53), "w".repeat(100));
        let shown = snippet_around(&text, 70, NEEDLE.len(), None);
        assert_eq!(shown, format!("…b{}{NEEDLE}{}…", "z".repeat(53), "w".repeat(60)));
    }

    #[test]
    fn a_link_ending_where_the_match_starts_is_dropped_when_the_edge_falls_inside_it() {
        // The link is 70 units, so the left edge lands 10 units into it.
        let link = format!("[[{}]]", "k".repeat(66));
        let text = format!("ppppp{link}{NEEDLE}{}", "w".repeat(100));
        let shown = snippet_around(&text, 75, NEEDLE.len(), None);
        assert_eq!(shown, format!("…{NEEDLE}{}…", "w".repeat(60)));
    }

    #[test]
    fn a_link_starting_where_the_match_ends_is_dropped_when_the_edge_falls_inside_it() {
        let link = format!("[[{}]]", "k".repeat(66));
        let text = format!("{}{NEEDLE}{link}ppppp", "w".repeat(100));
        let shown = snippet_around(&text, 100, NEEDLE.len(), None);
        assert_eq!(shown, format!("…{}{NEEDLE}…", "w".repeat(60)));
    }
}
