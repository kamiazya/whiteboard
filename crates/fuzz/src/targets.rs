//! One function per fuzz target. A target compares the entry under test
//! against something computed by DIFFERENT machinery, or asserts an
//! invariant the entry promises; reusing the entry's own helpers as the
//! oracle would agree with whatever it got wrong.
use whiteboard_codec::frontmatter::Value;

/// The template target. `whiteboard-det` has no untrusted-input entry, so
/// this exists to carry the pipeline (registry, caps, corpus, regressions,
/// sanitizers) end to end: the UTF-16 length of any valid UTF-8 input must
/// equal the count of units std's own encoder emits.
///
/// # Panics
///
/// When the two lengths disagree: that is the finding.
pub fn det_utf16_len(data: &[u8]) {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    assert_eq!(
        whiteboard_det::utf16::len(text),
        text.encode_utf16().count(),
        "UTF-16 length disagrees with std's encoder for {text:?}"
    );
}

/// The routing wire's anchor entry: an edge id, two flagged points, two
/// flagged lane depths, two sides and the `around` flag.
const ANCHOR_ENTRY: usize = 14;

/// The numbers `edge_route_layout` answers per edge before its path: rounded,
/// from side, to side, from end, to end and the point count.
const ROUTE_HEADER: usize = 6;

/// `edge_route_layout` on bytes read as little-endian `f64`s (a trailing
/// partial value is dropped): the export is reachable by anything holding the
/// wasm glue, so it must refuse (an empty answer) or answer, never panic or
/// run past its budget. An answer is checked against its documented layout
/// by walking it from the front, which shares nothing with the encoder that
/// wrote it: the four accounts, an edge count, per edge a header and a path
/// of the point count it names, then an anchor count and fourteen numbers
/// each, ending exactly at the end of the array.
///
/// # Panics
///
/// When the export panics, or its answer is not laid out as it documents.
pub fn edge_route_layout(data: &[u8]) {
    let wire: Vec<f64> = data
        .chunks_exact(8)
        .map(|c| <[u8; 8]>::try_from(c).map_or(0.0, f64::from_le_bytes))
        .collect();
    let out = whiteboard_wasm::spatial_edges::edge_route_layout(&wire);
    if out.is_empty() {
        return;
    }
    let mut at = 4;
    let routes = count_at(&out, at);
    at += 1;
    for _ in 0..routes {
        at += ROUTE_HEADER + 2 * count_at(&out, at + ROUTE_HEADER - 1);
    }
    let anchors = count_at(&out, at);
    assert_eq!(
        out.len(),
        at + 1 + anchors * ANCHOR_ENTRY,
        "the answer is not laid out as documented"
    );
}

/// The whole, non-negative count at `at` in an answer, or a finding.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "range-checked on the line above; the bound is far below usize::MAX"
)]
fn count_at(out: &[f64], at: usize) -> usize {
    let n = out.get(at).copied().unwrap_or(f64::NAN);
    assert!(n >= 0.0 && n.fract() == 0.0 && n < 1e9, "{n} at {at} is not a count");
    n as usize
}

/// The frontmatter reader on any UTF-8 text: it must answer a value or a
/// refusal, never panic or run past its budget, and a value it reads that the
/// writer can spell must read back as itself. The check shares nothing with
/// the reader but its output, so a reader and a writer that agree on a wrong
/// reading would still pass; the recorded oracle is what holds both to the
/// TypeScript.
///
/// # Panics
///
/// When the reader panics, or a written value reads back as another.
pub fn frontmatter_parse(data: &[u8]) {
    use whiteboard_codec::frontmatter::{parse, stringify};

    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let Ok(value) = parse(text) else {
        return;
    };
    // Two writings `serializeOkf` gets wrong, which the Rust writer copies
    // byte for byte, so such a value does not read back as itself.
    if any_string(&value, serialize_okf_loses) {
        return;
    }
    let Ok(written) = stringify(&value) else {
        return;
    };
    let again = parse(&written);
    // Folding and indentation can carry a value read under the cap past it,
    // and the reader refuses what is over the cap whatever it says.
    if written.len() > whiteboard_codec::frontmatter::MAX_BYTES {
        assert_eq!(again, Err(whiteboard_codec::frontmatter::Refusal::TooLarge));
        return;
    }
    assert!(
        again.as_ref().is_ok_and(|read| same(read, &value)),
        "{value:?} written as {written:?} reads back as {again:?}"
    );
}

/// What `serializeOkf` cannot write back: a last value ending in two
/// newlines loses one, and a multi-line string with a line that starts with
/// a space or tab can be folded at a space on that more-indented line, which
/// a reader keeps as a line break.
fn serialize_okf_loses(text: &str) -> bool {
    text.ends_with("\n\n")
        || (text.contains('\n') && text.split('\n').any(|line| line.starts_with([' ', '\t'])))
}

fn any_string(value: &Value, holds: fn(&str) -> bool) -> bool {
    match value {
        Value::String(text) => holds(text),
        Value::Seq(items) => items.iter().any(|item| any_string(item, holds)),
        Value::Map(entries) => entries.iter().any(|(_, item)| any_string(item, holds)),
        _ => false,
    }
}

/// Equality that tells `-0` from `0` and counts `NaN` as itself.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.to_bits() == y.to_bits(),
        (Value::Seq(x), Value::Seq(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Map(x), Value::Map(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|((k, p), (l, q))| k == l && same(p, q))
        }
        _ => a == b,
    }
}
