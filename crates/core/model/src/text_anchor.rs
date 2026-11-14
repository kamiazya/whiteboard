//! Finding a text anchor's passage in a body that has since been edited
//! (`packages/model/src/text-anchor.ts`).
//!
//! A stored anchor carries a POSITION (`start`/`end`) and a QUOTE (`exact`,
//! with optional `prefix`/`suffix`). Resolution follows W3C Web Annotation's
//! `TextQuoteSelector`: the stored offsets if the text there is still the quote;
//! else, among the quote's occurrences nearest the stored start, the one whose
//! surroundings match the remembered context best, ties going to the nearest
//! and then the lower; else nothing, and the thread is orphaned.
//!
//! Every offset and length counts UTF-16 code units, as the TypeScript's do,
//! so the text is read as a slice of them.
//!
//! The TypeScript searches short quotes with `indexOf` and long ones with
//! Knuth–Morris–Pratt, and collects occurrences outward from the anchor a step
//! at a time; both are cost choices with one answer, so this port runs the
//! linear search alone and bounds the scored occurrences with
//! [`scored_occurrence_range`], which the TypeScript's `resolveTextAnchorAmong`
//! states is the same answer.

/// The most characters of a quote's context that resolution compares
/// (`TEXT_ANCHOR_CONTEXT_MAX_CHARS`).
pub const TEXT_ANCHOR_CONTEXT_MAX_CHARS: usize = 32;

/// The most occurrences of one quote that resolution scores: the ones nearest
/// where the anchor last was (`SCORED_OCCURRENCES_MAX`).
pub const SCORED_OCCURRENCES_MAX: usize = 1024;

/// What a passage says (`TextQuoteSelector`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TextQuote {
    pub prefix: Option<String>,
    pub exact: String,
    pub suffix: Option<String>,
}

/// A passage of prose (`TextAnchor`): of a text node's text when it names one,
/// else of a note's body.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TextAnchor {
    pub node_id: Option<String>,
    pub quote: TextQuote,
    pub start: usize,
    pub end: usize,
}

/// Where a passage was placed, as offsets into the body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlacedPassage {
    pub start: usize,
    pub end: usize,
}

/// Which end of a context touches the passage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextSide {
    /// A prefix: its last character touches the passage.
    Before,
    /// A suffix: its first character touches the passage.
    After,
}

/// The index range `[from, to)` of a sorted list of occurrences.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OccurrenceRange {
    pub from: usize,
    pub to: usize,
}

/// `border[i]`: the length of the longest proper prefix of `needle[..=i]` that
/// is also its suffix, where matching resumes after a mismatch or a match.
fn borders(needle: &[u16]) -> Vec<usize> {
    // The first unit has no proper prefix; an empty needle has no border.
    let mut border = vec![0; needle.len().min(1)];
    let mut k = 0;
    for &unit in needle.iter().skip(1) {
        while k > 0 && needle.get(k) != Some(&unit) {
            k = border.get(k.saturating_sub(1)).copied().unwrap_or(0);
        }
        if needle.get(k) == Some(&unit) {
            k = k.saturating_add(1);
        }
        border.push(k);
    }
    border
}

/// Every index where `needle` starts in `haystack`, overlaps included
/// (`textOccurrences`), in `haystack.len() + needle.len()` steps whatever the
/// text repeats. An empty needle occurs nowhere.
#[must_use]
pub fn text_occurrences(haystack: &[u16], needle: &[u16]) -> Vec<usize> {
    let border = borders(needle);
    let mut found = Vec::new();
    let mut k = 0;
    for (i, &unit) in haystack.iter().enumerate() {
        while k > 0 && needle.get(k) != Some(&unit) {
            k = border.get(k.saturating_sub(1)).copied().unwrap_or(0);
        }
        if needle.get(k) == Some(&unit) {
            k = k.saturating_add(1);
        }
        if k == needle.len() && k > 0 {
            found.push(i.saturating_add(1).saturating_sub(k));
            k = border.get(k.saturating_sub(1)).copied().unwrap_or(0);
        }
    }
    found
}

/// How many characters of a quote's `context` a text still has beside the
/// passage (`sharedContext`). `read(k)` is the text's `k`-th character outward
/// from the passage, `None` past its edge. Only the nearest
/// [`TEXT_ANCHOR_CONTEXT_MAX_CHARS`] count.
pub fn shared_context(
    context: &[u16],
    side: ContextSide,
    mut read: impl FnMut(usize) -> Option<u16>,
) -> usize {
    let reach = context.len().min(TEXT_ANCHOR_CONTEXT_MAX_CHARS);
    let expected = |shared: usize| match side {
        ContextSide::Before => context.iter().rev().nth(shared),
        ContextSide::After => context.get(shared),
    };
    let mut shared = 0;
    while shared < reach && read(shared).as_ref() == expected(shared) {
        shared = shared.saturating_add(1);
    }
    shared
}

/// Which of a quote's occurrences resolution scores around `around`, given
/// every one of them ascending (`scoredOccurrenceRange`): the range holding the
/// `max` nearest, the lower of two equally near kept at the cut. The nearest of
/// a sorted list are contiguous in it, so a range says it exactly.
#[must_use]
pub fn scored_occurrence_range(sorted: &[usize], around: usize, max: usize) -> OccurrenceRange {
    let split = sorted.partition_point(|&at| at < around);
    let before = sorted.get(..split).unwrap_or_default().iter().rev();
    let mut after = sorted.get(split..).unwrap_or_default().iter().peekable();
    let mut before = before.peekable();
    let taken = max.min(sorted.len());
    let mut from_before: usize = 0;
    for _ in 0..taken {
        // Merged nearest first: `before` runs downward, `after` upward.
        let left = before.peek().map(|&&at| around.saturating_sub(at));
        let right = after.peek().map(|&&at| at.saturating_sub(around));
        if right.is_none() || left.is_some_and(|left| right.is_some_and(|right| left <= right)) {
            before.next();
            from_before = from_before.saturating_add(1);
        } else {
            after.next();
        }
    }
    let from = split.saturating_sub(from_before);
    OccurrenceRange { from, to: from.saturating_add(taken) }
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Whether the stored offsets still select the quote
/// (`textAnchorOffsetsHold`).
#[must_use]
pub fn text_anchor_offsets_hold(body: &[u16], anchor: &TextAnchor) -> bool {
    body.get(anchor.start..anchor.end) == Some(units(&anchor.quote.exact).as_slice())
}

/// Where a passage now is in `body` (`resolveTextAnchor` without a live mark):
/// the stored offsets while they still select the quote, else the scored
/// occurrence nearest them, else `None` — orphaned.
#[must_use]
pub fn resolve_text_anchor(body: &[u16], anchor: &TextAnchor) -> Option<PlacedPassage> {
    if text_anchor_offsets_hold(body, anchor) {
        return Some(PlacedPassage { start: anchor.start, end: anchor.end });
    }
    let occurrences = text_occurrences(body, &units(&anchor.quote.exact));
    let range = scored_occurrence_range(&occurrences, anchor.start, SCORED_OCCURRENCES_MAX);
    place_among(body, anchor, occurrences.get(range.from..range.to).unwrap_or_default())
}

/// The candidate placed at (`placeAmong`): the most remembered context, then
/// the nearest the stored start, then the first.
fn place_among(body: &[u16], anchor: &TextAnchor, candidates: &[usize]) -> Option<PlacedPassage> {
    let exact = units(&anchor.quote.exact);
    let prefix = units(anchor.quote.prefix.as_deref().unwrap_or_default());
    let suffix = units(anchor.quote.suffix.as_deref().unwrap_or_default());
    let mut best: Option<(usize, usize, usize)> = None;
    for &candidate in candidates {
        let before = shared_context(&prefix, ContextSide::Before, |k| {
            candidate.checked_sub(k.saturating_add(1)).and_then(|at| body.get(at).copied())
        });
        let end = candidate.saturating_add(exact.len());
        let after = shared_context(&suffix, ContextSide::After, |k| {
            body.get(end.saturating_add(k)).copied()
        });
        let score = before.saturating_add(after);
        let distance = candidate.abs_diff(anchor.start);
        if best.is_none_or(|(_, s, d)| score > s || (score == s && distance < d)) {
            best = Some((candidate, score, distance));
        }
    }
    best.map(|(start, ..)| PlacedPassage { start, end: start.saturating_add(exact.len()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn u(text: &str) -> Vec<u16> {
        units(text)
    }

    #[test]
    fn an_empty_needle_occurs_nowhere() {
        assert_eq!(text_occurrences(&u("abc"), &[]), Vec::<usize>::new());
    }
}
