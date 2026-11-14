//! Where a quote occurs in a text when every run of whitespace on either side
//! compares equal to any other (`layout/loose-occurrences.ts`): what a
//! `word\s+word` regex finds, without the regex's cost. Both sides' whitespace
//! runs are squashed to one space, which turns the loose comparison into an
//! exact one, and an index map carries each squashed position back.
//!
//! Offsets count UTF-16 code units, as the TypeScript's do.

use whiteboard_det::utf16::is_js_whitespace;
use whiteboard_model::text_anchor::text_occurrences;

/// A match as offsets into the searched text: from its first non-blank
/// character to just past its last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LooseSpan {
    pub start: usize,
    pub end: usize,
}

const SPACE: u16 = 0x20;

/// A text with each whitespace run read as one space (`squash`).
#[must_use]
pub fn squash(text: &[u16]) -> Vec<u16> {
    squash_with_offsets(text).squashed
}

/// The squashed text, and for each of its units the offset in the text it
/// came from — a whitespace run's first unit.
struct Squashed {
    squashed: Vec<u16>,
    offsets: Vec<usize>,
}

fn squash_with_offsets(text: &[u16]) -> Squashed {
    let mut out = Squashed { squashed: Vec::new(), offsets: Vec::new() };
    let mut after_space = false;
    for (at, &unit) in text.iter().enumerate() {
        let space = is_js_whitespace(unit);
        if !(space && after_space) {
            out.squashed.push(if space { SPACE } else { unit });
            out.offsets.push(at);
        }
        after_space = space;
    }
    out
}

/// Every non-overlapping occurrence of `quote`, leftmost first, as offsets
/// into `text` (`looseOccurrences`). Leading and trailing whitespace in the
/// quote ask nothing of the text; a blank quote occurs nowhere.
#[must_use]
pub fn loose_occurrences(text: &[u16], quote: &[u16]) -> Vec<LooseSpan> {
    let needle = squash(quote);
    let needle = needle.strip_prefix(&[SPACE]).unwrap_or(&needle);
    let needle = needle.strip_suffix(&[SPACE]).unwrap_or(needle);
    let Squashed { squashed, offsets } = squash_with_offsets(text);
    let mut spans = Vec::new();
    let mut free = 0;
    for at in text_occurrences(&squashed, needle) {
        // The regex resumed after each match, so an overlapping one never counts.
        if at < free {
            continue;
        }
        free = at.saturating_add(needle.len());
        let start = offsets.get(at).copied().unwrap_or_default();
        let last = offsets.get(free.saturating_sub(1)).copied().unwrap_or_default();
        spans.push(LooseSpan { start, end: last.saturating_add(1) });
    }
    spans
}
