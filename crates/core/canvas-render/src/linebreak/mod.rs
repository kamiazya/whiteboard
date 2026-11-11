//! Where a line may break, ported from `css-line-break` 2.1.0 with
//! `lineBreak: 'strict'` and `wordBreak: 'normal'` (ADR-0054 step 7).
//!
//! **After the TypeScript is deleted this port IS the specification, holes
//! included.** It is not UAX #14 as published; it is the walk `css-line-break`
//! hand-wrote over a Unicode 13-era class table, and the layout's goldens were
//! recorded against it. Moving off the holes below is one conscious decision
//! taken on both sides at once, with the recorded oracle re-recorded, never a
//! drive-by fix here. The holes:
//!
//! - **No `x CM` rule.** LB9 only gives a combining mark or ZWJ the class of
//!   the character before it; nothing forbids a break before it. A mark after
//!   `PO`, `PR`, `EB`, `H3` or any other class that may break after itself
//!   breaks there, and `ア` + U+0301 breaks between the two. The one exception
//!   is a mark that LB9 folds into the very first character: the position the
//!   fold maps to index 0 is never a break (LB2).
//! - **LB25 is the old subset.** There is no `CL x PR`, `CL x PO`, `CP x PR`
//!   (with a number before the closer excepted by the look-behind below),
//!   `CP x PO`, `PR x OP`, `PO x OP`, `IS x NU` or `SY x NU`, except where
//!   the look-behind rules happen to reach them.
//! - **LB30 is the pre-Unicode-13 shape.** Only U+2329 and U+FF08 are exempt
//!   from "letter or digit x OP"; an East Asian wide or fullwidth opener
//!   otherwise stays unbreakable after a letter, and no other opener is
//!   exempt.
//! - **The table stops at Unicode 13.** A code point added later (U+061D and
//!   the 14.0 to 18.0 blocks) is class `XX`, read as `AL` below plane 2.
//!
//! Also deliberate to the oracle, though not holes: `SA`, `AI` and `CJ` are
//! read as `AL`, `AL` and `NS` (strict); Thai is never broken; `XX` in
//! planes 2 and 3 is `ID`; a lone surrogate is one code point of its own; and
//! `LB8a` and the emoji-ZWJ rule read the RAW class of the code point itself,
//! not the folded one.
//!
//! The table ([`table`]) is generated from the oracle's own trie by
//! `packages/canvas-render/scripts/gen-linebreak-table.mjs`; the walk
//! ([`Classes::allowed`]) holds LB4 to `LB30b` in the oracle's order. Offsets
//! are UTF-16 code units, as the layout's `uaxSegments` counts them.

mod table;

pub use table::SOURCE_VERSION;

/// The trie's raw value is the class plus this when the code point is also a
/// letter or number (what the oracle calls `LETTER_NUMBER_MODIFIER`).
const LETTER_NUMBER_MODIFIER: u8 = 50;

// Class numbers are the oracle's, which the generated table stores raw.
const BK: u8 = 1;
const CR: u8 = 2;
const LF: u8 = 3;
const CM: u8 = 4;
const NL: u8 = 5;
const WJ: u8 = 7;
const ZW: u8 = 8;
const GL: u8 = 9;
const SP: u8 = 10;
const ZWJ: u8 = 11;
const B2: u8 = 12;
const BA: u8 = 13;
const BB: u8 = 14;
const HY: u8 = 15;
const CB: u8 = 16;
const CL: u8 = 17;
const CP: u8 = 18;
const EX: u8 = 19;
const IN: u8 = 20;
const NS: u8 = 21;
const OP: u8 = 22;
const QU: u8 = 23;
const IS: u8 = 24;
const NU: u8 = 25;
const PO: u8 = 26;
const PR: u8 = 27;
const SY: u8 = 28;
const AI: u8 = 29;
const AL: u8 = 30;
const CJ: u8 = 31;
const EB: u8 = 32;
const EM: u8 = 33;
const H2: u8 = 34;
const H3: u8 = 35;
const HL: u8 = 36;
const ID: u8 = 37;
const JL: u8 = 38;
const JV: u8 = 39;
const JT: u8 = 40;
const RI: u8 = 41;
const SA: u8 = 42;
const XX: u8 = 43;

const HARD_LINE_BREAKS: [u8; 4] = [BK, CR, LF, NL];
const SPACE: [u8; 2] = [SP, ZW];
const LINE_BREAKS: [u8; 6] = [BK, CR, LF, NL, SP, ZW];
const ALPHABETICS: [u8; 2] = [AL, HL];
const PREFIX_POSTFIX: [u8; 2] = [PR, PO];
const KOREAN_SYLLABLE_BLOCK: [u8; 5] = [JL, JV, JT, H2, H3];
const HYPHEN: [u8; 2] = [HY, BA];
/// The only openers LB30 exempts: U+2329 and U+FF08.
const EA_OP: [u32; 2] = [0x2329, 0xff08];

/// The raw trie value of `code_point`: its class, plus 50 when it is also a
/// letter or number. A value past U+10FFFF has none (0).
#[must_use]
pub fn raw_class(code_point: u32) -> u8 {
    let runs = &table::RUNS;
    let after = runs.partition_point(|run| (run >> 8) <= code_point);
    after.checked_sub(1).and_then(|i| runs.get(i)).map_or(0, |run| (run & 0xff) as u8)
}

/// The UTF-16 offset of the end of every segment `css-line-break` cuts `text`
/// into, last included; none for the empty text. A segment's end is a break
/// opportunity, so the interior ends are the offsets a line may break at.
#[must_use]
pub fn segment_ends(text: &[u16]) -> Vec<usize> {
    let classes = Classes::new(text);
    let mut ends: Vec<usize> = (1..classes.cps.len())
        .filter(|&index| classes.allowed(index))
        .filter_map(|index| classes.starts.get(index).copied())
        .collect();
    if !text.is_empty() {
        ends.push(text.len());
    }
    ends
}

/// Decodes `text` as the oracle's code-point decoding does: a high surrogate
/// followed by a low one is one code point, anything else a unit of its own
/// (which is how `char::decode_utf16` reports an unpaired surrogate).
/// Returns each code point and the offset of its first unit.
fn code_points(text: &[u16]) -> (Vec<u32>, Vec<usize>) {
    let mut cps = Vec::with_capacity(text.len());
    let mut starts = Vec::with_capacity(text.len());
    let mut offset = 0usize;
    for decoded in char::decode_utf16(text.iter().copied()) {
        starts.push(offset);
        let (cp, width) = match decoded {
            Ok(c) => (u32::from(c), c.len_utf16()),
            Err(e) => (u32::from(e.unpaired_surrogate()), 1),
        };
        cps.push(cp);
        offset = offset.saturating_add(width);
    }
    (cps, starts)
}

/// A text read into the oracle's three parallel arrays.
struct Classes {
    cps: Vec<u32>,
    /// UTF-16 offset of each code point.
    starts: Vec<usize>,
    /// The class each code point takes in the rules, after LB9's fold.
    types: Vec<u8>,
    /// The index of the code point a class was inherited from (its own, except
    /// for a mark LB9 folded into the one before it).
    indices: Vec<usize>,
}

impl Classes {
    fn new(text: &[u16]) -> Self {
        let (cps, starts) = code_points(text);
        let mut types: Vec<u8> = Vec::with_capacity(cps.len());
        let mut indices: Vec<usize> = Vec::with_capacity(cps.len());
        for (index, &cp) in cps.iter().enumerate() {
            let raw = raw_class(cp);
            let class = if raw > LETTER_NUMBER_MODIFIER {
                raw.saturating_sub(LETTER_NUMBER_MODIFIER)
            } else {
                raw
            };
            let previous = index.checked_sub(1);
            if class == CM || class == ZWJ {
                // LB10 at the start of text, LB9 after a base: the mark takes
                // the base's class and stands at the base's index.
                let base = previous
                    .and_then(|p| types.get(p).copied())
                    .filter(|prev| !LINE_BREAKS.contains(prev));
                if let (Some(prev), Some(p)) = (base, previous) {
                    indices.push(indices.get(p).copied().unwrap_or(index));
                    types.push(prev);
                } else {
                    indices.push(index);
                    types.push(AL);
                }
                continue;
            }
            indices.push(index);
            types.push(match class {
                CJ => NS,
                XX if (0x2_0000..=0x2_fffd).contains(&cp)
                    || (0x3_0000..=0x3_fffd).contains(&cp) =>
                {
                    ID
                }
                SA | AI | XX => AL,
                other => other,
            });
        }
        Self { cps, starts, types, indices }
    }

    /// The class at `i`; 0, which no class is, past either end.
    fn ty(&self, i: usize) -> u8 {
        self.types.get(i).copied().unwrap_or(0)
    }

    /// The class of the nearest code point at or before `i` that is not a space.
    fn previous_non_space(&self, i: usize) -> u8 {
        (0..=i).rev().map(|j| self.ty(j)).find(|&t| t != SP).unwrap_or(0)
    }

    /// Whether the classes at the scan's start in `from` are followed by `b`,
    /// ignoring spaces: the oracle's adjacency test that skips spaces.
    fn followed_by_ignoring_spaces(&self, from: usize, b: u8) -> bool {
        for j in from.saturating_add(1)..self.types.len() {
            let t = self.ty(j);
            if t == b {
                return true;
            }
            if t != SP {
                return false;
            }
        }
        false
    }

    fn adjacent_ignoring_spaces(&self, a: &[u8], b: u8, current_index: usize) -> bool {
        let current = self.ty(current_index);
        if a.contains(&current) && self.followed_by_ignoring_spaces(current_index, b) {
            return true;
        }
        if current == SP {
            for j in (0..current_index).rev() {
                let prev = self.ty(j);
                if a.contains(&prev) && self.followed_by_ignoring_spaces(current_index, b) {
                    return true;
                }
                if prev != SP {
                    break;
                }
            }
        }
        false
    }

    /// Whether walking left from `start` over `SY` and `IS` reaches a `NU`.
    fn numeric_before(&self, start: Option<usize>) -> bool {
        let Some(start) = start else { return false };
        for j in (0..=start).rev() {
            let t = self.ty(j);
            if t == NU {
                return true;
            }
            if t != SY && t != IS {
                break;
            }
        }
        false
    }

    /// Whether a line may break before the code point at `index` (1 to len-1):
    /// LB4 to `LB30b` in the oracle's order, each rule answering at once.
    fn allowed(&self, index: usize) -> bool {
        // LB2 by way of LB9: a mark folded into the first code point.
        if self.indices.get(index).copied() == Some(0) {
            return false;
        }
        let cur = index.saturating_sub(1);
        let pair = Pair {
            index,
            cur,
            current: self.ty(cur),
            next: self.ty(index),
            before: cur.checked_sub(1).map_or(0, |b| self.ty(b)),
        };
        self.hard_break_rules(&pair)
            .or_else(|| self.joiner_and_bracket_rules(&pair))
            .or_else(|| Self::hyphen_and_affix_rules(&pair))
            .or_else(|| self.numeric_rules(&pair))
            .or_else(|| self.syllable_and_letter_rules(&pair))
            .unwrap_or(true)
    }

    /// LB4 to LB8: hard breaks, spaces and the zero width space.
    /// `Some` is the verdict; `None` leaves it to the later rules.
    fn hard_break_rules(&self, pair: &Pair) -> Option<bool> {
        let Pair { cur, current, next, .. } = *pair;
        // LB4, LB5
        if current == CR && next == LF {
            return Some(false);
        }
        if HARD_LINE_BREAKS.contains(&current) {
            return Some(true);
        }
        // LB6, LB7
        if HARD_LINE_BREAKS.contains(&next) || SPACE.contains(&next) {
            return Some(false);
        }
        // LB8
        (self.previous_non_space(cur) == ZW).then_some(true)
    }

    /// `LB8a` to LB20: joiners, glue, brackets, quotes and the break after a space.
    fn joiner_and_bracket_rules(&self, pair: &Pair) -> Option<bool> {
        let Pair { index, cur, current, next, .. } = *pair;
        let next_raw = self.cps.get(index).copied().map_or(0, raw_class);
        // LB8a, and the same for an emoji before a joiner
        if self.cps.get(cur).copied().map(raw_class) == Some(ZWJ)
            || ((current == EB || current == EM) && next_raw == ZWJ)
        {
            return Some(false);
        }
        // LB11, LB12, LB12a
        if current == WJ || next == WJ || current == GL {
            return Some(false);
        }
        if ![SP, BA, HY].contains(&current) && next == GL {
            return Some(false);
        }
        // LB13, LB14
        if [CL, CP, EX, IS, SY].contains(&next) || self.previous_non_space(cur) == OP {
            return Some(false);
        }
        // LB15, LB16, LB17
        if self.adjacent_ignoring_spaces(&[QU], OP, cur)
            || self.adjacent_ignoring_spaces(&[CL, CP], NS, cur)
            || self.adjacent_ignoring_spaces(&[B2], B2, cur)
        {
            return Some(false);
        }
        // LB18
        if current == SP {
            return Some(true);
        }
        // LB19
        if current == QU || next == QU {
            return Some(false);
        }
        // LB20
        (next == CB || current == CB).then_some(true)
    }

    /// LB21 to LB24: hyphens, ellipses, and the numeric and alphabetic affixes.
    fn hyphen_and_affix_rules(pair: &Pair) -> Option<bool> {
        let Pair { current, next, before, .. } = *pair;
        // LB21, LB21a, LB21b, LB22
        if [BA, HY, NS].contains(&next) || current == BB {
            return Some(false);
        }
        if before == HL && HYPHEN.contains(&current) {
            return Some(false);
        }
        if (current == SY && next == HL) || next == IN {
            return Some(false);
        }
        // LB23
        let alpha_current = ALPHABETICS.contains(&current);
        let alpha_next = ALPHABETICS.contains(&next);
        if (alpha_next && current == NU) || (alpha_current && next == NU) {
            return Some(false);
        }
        // LB23a
        let ideographic = |t: u8| [ID, EB, EM].contains(&t);
        if (current == PR && ideographic(next)) || (ideographic(current) && next == PO) {
            return Some(false);
        }
        // LB24
        let prefix_postfix = |t: u8| PREFIX_POSTFIX.contains(&t);
        ((alpha_current && prefix_postfix(next)) || (prefix_postfix(current) && alpha_next))
            .then_some(false)
    }

    /// LB25: numbers with their prefixes, postfixes and punctuation.
    fn numeric_rules(&self, pair: &Pair) -> Option<bool> {
        let Pair { index, cur, current, next, .. } = *pair;
        let prefix_postfix = |t: u8| PREFIX_POSTFIX.contains(&t);
        let after_next = self.ty(index.saturating_add(1));
        if (prefix_postfix(current)
            && (next == NU || ([OP, HY].contains(&next) && after_next == NU)))
            || ([OP, HY].contains(&current) && next == NU)
            || (current == NU && [NU, SY, IS].contains(&next))
        {
            return Some(false);
        }
        if [NU, SY, IS, CL, CP].contains(&next) && self.numeric_before(Some(cur)) {
            return Some(false);
        }
        if prefix_postfix(next) {
            let start = if [CL, CP].contains(&current) { cur.checked_sub(1) } else { Some(cur) };
            if self.numeric_before(start) {
                return Some(false);
            }
        }
        None
    }

    /// LB26 to `LB30b`: Korean syllables, letters, brackets and regional indicators.
    fn syllable_and_letter_rules(&self, pair: &Pair) -> Option<bool> {
        let Pair { index, cur, current, next, .. } = *pair;
        let alpha_current = ALPHABETICS.contains(&current);
        let alpha_next = ALPHABETICS.contains(&next);
        // LB26, LB27
        let korean = |t: u8| KOREAN_SYLLABLE_BLOCK.contains(&t);
        if (current == JL && [JL, JV, H2, H3].contains(&next))
            || ([JV, H2].contains(&current) && [JV, JT].contains(&next))
            || ([JT, H3].contains(&current) && next == JT)
            || (korean(current) && [IN, PO].contains(&next))
            || (korean(next) && current == PR)
        {
            return Some(false);
        }
        // LB28, LB29
        if alpha_next && (alpha_current || current == IS) {
            return Some(false);
        }
        // LB30
        let next_cp = self.cps.get(index).copied().unwrap_or(0);
        if ((alpha_current || current == NU) && next == OP && !EA_OP.contains(&next_cp))
            || ((alpha_next || next == NU) && current == CP)
        {
            return Some(false);
        }
        // LB30a: a pair of regional indicators breaks only after an even run.
        if current == RI && next == RI && !self.even_run_before(cur) {
            return Some(false);
        }
        // LB30b
        (current == EB && next == EM).then_some(false)
    }

    /// Whether an even number of regional indicators precede the pair ending
    /// at `cur`'s class, counted back from the index its class was read at.
    fn even_run_before(&self, cur: usize) -> bool {
        let start = self.indices.get(cur).copied().unwrap_or(0);
        let before = (0..start).rev().take_while(|&i| self.ty(i) == RI).count();
        before.saturating_add(1).is_multiple_of(2)
    }
}

/// The two classes either side of the position being decided, and where they sit.
#[derive(Clone, Copy)]
struct Pair {
    index: usize,
    cur: usize,
    current: u8,
    next: u8,
    /// The class before `current`; 0 at the start of text.
    before: u8,
}
