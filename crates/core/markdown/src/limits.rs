//! What the parser reads, and what it refuses instead.
//!
//! The parser takes text from anywhere a document can come from, and a wasm
//! instance that panics, overflows its stack or spins is gone for every
//! document, so each of those is turned into an answer: a [`Refusal`], which a
//! root answers by asking the TypeScript parser, whose own bounds differ.
//! Nothing here changes a tree: a text the parser reads has the tree the
//! vendored tokenizer gives it, and a text it does not is refused whole.

/// Why a text was not parsed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    /// Longer than [`MAX_BYTES`].
    TooLarge,
    /// Containers or inline structures nested past [`MAX_CONTAINER_DEPTH`] or [`MAX_DEPTH`].
    TooDeep,
    /// The work a text needs went past its [`fuel_for`] budget, or past one of
    /// the per-run counts that bound a walk the budget cannot see.
    TooCostly,
}

/// The longest text read, in bytes.
///
/// A markdown body holds at most 256 Ki UTF-16 units, which is at most 768 KiB
/// of UTF-8, so every body the model admits is read.
pub const MAX_BYTES: usize = 786_432;

/// The deepest nesting of block containers (block quotes and list items)
/// read.
///
/// The TypeScript tokenizer stops opening containers at 32, and reads the
/// marker past it as text. A text that nests deeper is refused rather than
/// read the other way.
pub const MAX_CONTAINER_DEPTH: usize = 32;

/// The deepest nesting of the events a tree is built from, which is at least
/// the depth of the tree: every node is an event and some events are not nodes.
///
/// Dropping and walking a tree recurses once per level, and a wasm stack is
/// 1 MiB: a text that nests deeper is refused before the tree is built.
pub const MAX_DEPTH: usize = 1024;

/// Delimiter runs one inline run may hold before the text is refused.
///
/// Emphasis, strikethrough and label resolution walk back from each closer
/// over the runs before it, so their cost is the square of this. The
/// TypeScript parser caps delimiter characters per run at 1,024 and reads the
/// rest as text; this is the same figure counted in runs, and refuses.
pub const MAX_RUNS_PER_INLINE: usize = 1_024;

/// Work units a text of `len` bytes may spend before it is refused.
///
/// One unit is a step of the tokenizer, an event a resolver walks over, a byte
/// of a text a pass reads, or one step of a walk a resolver makes over what
/// came before it. The figure is a multiple of the dearest ordinary
/// text measured (`tests/cost.rs`), so no real document is refused, and a text
/// built to be quadratic is refused after a time that grows with its length
/// alone.
#[must_use]
pub const fn fuel_for(len: usize) -> usize {
    FUEL_BASE.saturating_add(FUEL_PER_BYTE.saturating_mul(len))
}

/// Fuel every text has, so that a short one is never refused for being short.
const FUEL_BASE: usize = 1 << 16;

/// Fuel per byte of text: the dearest ordinary shape in `tests/cost.rs` spends
/// 68.5 a byte, so a quarter of this is headroom over it.
const FUEL_PER_BYTE: usize = 96;

/// Refuse a text whose lines open more containers than [`MAX_CONTAINER_DEPTH`].
///
/// A line that opens its containers in one go (`- - - - x`) is quadratic for
/// the tokenizer, which rescans the rest of the line at every level, and a
/// stack of them is the shape of a stack overflow, so this reads the markers
/// at the start of each line before the tokenizer reads anything. It counts
/// what could open a container, not what does: a line the tokenizer would read
/// as text may be refused, which costs a call to the TypeScript parser and
/// nothing else.
///
/// # Errors
///
/// [`Refusal::TooDeep`] for a line with more markers than the bound.
pub(crate) fn prescan(text: &str) -> Result<(), Refusal> {
    for line in text.split(['\n', '\r']) {
        if markers_opened(line.as_bytes()) > MAX_CONTAINER_DEPTH {
            return Err(Refusal::TooDeep);
        }
    }
    Ok(())
}

/// The block quote and list markers a line opens with, in a row.
fn markers_opened(line: &[u8]) -> usize {
    let mut rest = line;
    let mut count = 0_usize;
    while let Some((&byte, after)) = rest.split_first() {
        match byte {
            b' ' | b'\t' => rest = after,
            b'>' => {
                count = count.saturating_add(1);
                rest = after;
            }
            b'-' | b'+' | b'*' if is_blank_or_end(after.first()) => {
                count = count.saturating_add(1);
                rest = after;
            }
            b'0'..=b'9' => match ordered_marker_rest(rest) {
                Some(after_marker) => {
                    count = count.saturating_add(1);
                    rest = after_marker;
                }
                None => return count,
            },
            _ => return count,
        }
    }
    count
}

fn is_blank_or_end(byte: Option<&u8>) -> bool {
    matches!(byte, None | Some(b' ' | b'\t'))
}

/// What follows `1.` or `12)` at the start of `rest`, when a space or the end follows it.
fn ordered_marker_rest(rest: &[u8]) -> Option<&[u8]> {
    let digits = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
    let after_digits = rest.get(digits..)?;
    match after_digits.split_first() {
        Some((b'.' | b')', after)) if is_blank_or_end(after.first()) => Some(after),
        _ => None,
    }
}
