//! `BudouX`'s phrase segmenter over the Japanese model, ported from
//! `packages/canvas-render/src/vendor/budoux` (ADR-0054 step 7).
//!
//! A text is scored at every UTF-16 index from 1: thirteen features each look
//! up the substring of a fixed window around the index in their group's table
//! (an absent key weighs 0) and the weights are summed. The TypeScript starts
//! from half the total of every weight, negated, and cuts where the score is
//! above zero; every weight is an integer, so the same comparison here is
//! exact in doubled integers: `2 * sum > total`.
//!
//! The window follows `String.prototype.substring`, which the TypeScript used:
//! both ends are clamped into the text, so near either end a window is shorter
//! than its feature's length and is looked up as the shorter key it is. A
//! window may start or end between the halves of a surrogate pair; the keys of
//! [`model`] are units, so those halves are looked up like any other.
//!
//! After the TypeScript is deleted this module IS the specification of the
//! phrase breaker: the tables are generated once from the model it vendored
//! (`scripts/gen-budoux-model.mjs`) and the recorded `budoux.jsonl` pins what
//! they answer.

mod model;

use model::{BW1, BW2, BW3, Entry, TOTAL, TW1, TW2, TW3, TW4, UW1, UW2, UW3, UW4, UW5, UW6};

/// One scored feature: its table, and its window as offsets from the index.
struct Feature {
    table: &'static [Entry],
    from: isize,
    to: isize,
}

const fn feature(table: &'static [Entry], from: isize, len: isize) -> Feature {
    Feature { table, from, to: from.saturating_add(len) }
}

/// The groups in the order the model scores them: six one-unit windows at
/// offsets -3 to 2 from the index, three two-unit windows from -2 to 0, four
/// three-unit windows from -3 to 0.
static FEATURES: [Feature; 13] = [
    feature(&UW1, -3, 1),
    feature(&UW2, -2, 1),
    feature(&UW3, -1, 1),
    feature(&UW4, 0, 1),
    feature(&UW5, 1, 1),
    feature(&UW6, 2, 1),
    feature(&BW1, -2, 2),
    feature(&BW2, -1, 2),
    feature(&BW3, 0, 2),
    feature(&TW1, -3, 3),
    feature(&TW2, -2, 3),
    feature(&TW3, -1, 3),
    feature(&TW4, 0, 3),
];

/// The weight of the clamped window of `feature` at `index`; 0 for an absent key.
fn weight(feature: &Feature, text: &[u16], index: usize) -> i64 {
    let end = text.len();
    let start = index.saturating_add_signed(feature.from).min(end);
    let stop = index.saturating_add_signed(feature.to).min(end);
    let key = text.get(start..stop).unwrap_or(&[]);
    feature
        .table
        .binary_search_by(|(candidate, _)| (*candidate).cmp(key))
        .ok()
        .and_then(|found| feature.table.get(found))
        .map_or(0, |(_, weight)| i64::from(*weight))
}

/// The indices of `text` at which a boundary falls, by `features` over a model
/// whose weights sum to `total`.
fn boundaries(text: &[u16], features: &[Feature], total: i64) -> Vec<usize> {
    (1..text.len())
        .filter(|&index| {
            let sum =
                features.iter().fold(0_i64, |sum, f| sum.saturating_add(weight(f, text, index)));
            sum.saturating_mul(2) > total
        })
        .collect()
}

/// The UTF-16 indices at which a phrase boundary falls, in increasing order.
/// A boundary is never at 0 or at the text's end.
#[must_use]
pub fn parse_boundaries(text: &[u16]) -> Vec<usize> {
    boundaries(text, &FEATURES, TOTAL)
}

/// The text split at its phrase boundaries; no phrase for an empty text.
#[must_use]
pub fn parse(text: &[u16]) -> Vec<&[u16]> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut phrases = Vec::new();
    let mut start = 0;
    for boundary in parse_boundaries(text) {
        phrases.push(text.get(start..boundary).unwrap_or(&[]));
        start = boundary;
    }
    phrases.push(text.get(start..).unwrap_or(&[]));
    phrases
}

#[cfg(test)]
mod tests;
