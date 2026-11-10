//! One function per fuzz target. A target compares the entry under test
//! against something computed by DIFFERENT machinery, or asserts an
//! invariant the entry promises; reusing the entry's own helpers as the
//! oracle would agree with whatever it got wrong.
use whiteboard_codec::frontmatter::Value;
use whiteboard_codec::okf::Document;

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
    // `serializeOkf` writes a mapping, so only a mapping is held to read
    // back: a root scalar folded onto a line that starts with `%` is a
    // directive to the subset, in the TypeScript as here. And two writings
    // `serializeOkf` gets wrong are copied byte for byte, so those do not
    // read back as themselves either.
    if !matches!(value, Value::Map(_)) || any_string(&value, serialize_okf_loses) {
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

/// The OKF envelope on any UTF-8 text: it must answer a document or a
/// refusal, never panic or run past its budget; the fence split and the
/// reader must agree about what a block is; and a document it reads that the
/// writer can spell must be written to a text that reads back to a document
/// the writer writes the same way. The check shares nothing with the parser
/// but its output, so a reader and a writer that agree on a wrong reading
/// would still pass; the recorded oracle is what holds both to the TypeScript.
///
/// # Panics
///
/// When the parser panics, the split and the reader disagree, or a written
/// document does not read back stably.
pub fn okf_parse(data: &[u8]) {
    use whiteboard_codec::okf::{Failure, has_frontmatter, parse, serialize};

    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let read = parse(text);
    assert_eq!(
        has_frontmatter(text),
        !matches!(read, Err(Failure::NoFence)),
        "the split and the reader disagree about a block in {text:?}"
    );
    let Ok(doc) = read else {
        return;
    };
    // Two writings `serializeOkf` gets wrong are copied byte for byte (see
    // `serialize_okf_loses`), so a document holding either is not held to it.
    if okf_strings(&doc).into_iter().any(serialize_okf_loses) {
        return;
    }
    let Ok(written) = serialize(&doc) else {
        return;
    };
    // Folding and indentation can carry a frontmatter read under the cap past it.
    if written.len() > whiteboard_codec::frontmatter::MAX_BYTES {
        return;
    }
    let again = parse(&written);
    assert!(again.is_ok(), "{doc:?} written as {written:?} is refused: {again:?}");
    let rewritten = again.map(|second| serialize(&second));
    assert_eq!(rewritten, Ok(Ok(written.clone())), "{written:?} does not read back stably");
}

/// Every string a document holds: its fields, its events and the values
/// under its facets and preserved keys. Keys are not among them, because the
/// writer quotes a key it cannot write plain.
fn okf_strings(doc: &Document) -> Vec<&str> {
    let fm = &doc.frontmatter;
    let mut found: Vec<&str> = [Some(&fm.r#type), fm.title.as_ref(), fm.description.as_ref()]
        .into_iter()
        .chain([fm.resource.as_ref(), fm.view.as_ref()])
        .flatten()
        .map(String::as_str)
        .chain(fm.tags.iter().flatten().map(String::as_str))
        .collect();
    let events = fm.generated.iter().chain(fm.verified.iter().flatten());
    for event in events {
        found.extend([event.by.as_str(), event.at.as_str()]);
        found.extend(event.extra.iter().flat_map(|(_, value)| value_strings(value)));
    }
    for (_, value) in fm.facets.iter().chain(&fm.facets_raw).flatten() {
        found.extend(value_strings(value));
    }
    found
}

fn value_strings(value: &Value) -> Vec<&str> {
    match value {
        Value::String(text) => vec![text],
        Value::Seq(items) => items.iter().flat_map(value_strings).collect(),
        Value::Map(entries) => entries.iter().flat_map(|(_, item)| value_strings(item)).collect(),
        _ => Vec::new(),
    }
}

/// The answer's first array element, `["<tag>",...`, or a finding.
fn answer_tag(answer: &str) -> &str {
    let tag = answer.strip_prefix("[\"").and_then(|rest| rest.split_once('"'));
    assert!(tag.is_some(), "the answer {answer:?} does not open with a tag");
    tag.map_or("", |(tag, _)| tag)
}

/// `okf_parse`, the export a host calls, on any UTF-8 text: it must answer one
/// of its three documented shapes and never panic or run past its budget; it
/// refuses exactly the text past its cap; and it reads exactly what the codec
/// reads, with a body offset in UTF-16 units that leaves the body as the
/// text's own tail, counted by std's encoder rather than the export's.
///
/// # Panics
///
/// When the export panics, disagrees with the codec, or answers off its shape.
pub fn okf_wasm_parse(data: &[u8]) {
    use whiteboard_wasm::input_caps::OKF_PARSE;
    use whiteboard_wasm::okf::okf_parse;

    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let answer = okf_parse(text);
    if text.len() > OKF_PARSE.max_bytes {
        assert_eq!(answer, "[\"refused\",\"input-too-large\"]");
        return;
    }
    let read = whiteboard_codec::okf::parse(text);
    let tag = answer_tag(&answer);
    assert!(matches!(tag, "ok" | "err"), "{tag} is no answer to a text within the cap");
    assert_eq!(tag == "ok", read.is_ok(), "the export and the codec disagree about {text:?}");
    let (Ok(doc), Some(offset)) = (
        read,
        answer
            .strip_prefix("[\"ok\",")
            .and_then(|rest| rest.split_once(',')?.0.parse::<usize>().ok()),
    ) else {
        assert_eq!(tag, "err", "an ok answer without a numeric offset: {answer:.80}");
        return;
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    let tail = units.get(offset..);
    assert!(tail.is_some(), "the offset {offset} is past the text");
    let body = String::from_utf16(tail.unwrap_or_default());
    assert_eq!(body.ok().as_deref(), Some(doc.body.as_str()), "the offset does not leave the body");
}

/// `okf_serialize`, the export a host calls, on any UTF-8 text read as a
/// document wire (the decode a host's bytes reach: JSON, the value wire, the
/// frontmatter schema): it must answer one of its three documented shapes
/// and never panic or run past its budget, refuse exactly the wire past its
/// cap, and write only a head that opens and closes with a fence.
///
/// # Panics
///
/// When the export panics or answers off its shape.
pub fn okf_wasm_serialize(data: &[u8]) {
    use whiteboard_wasm::input_caps::OKF_SERIALIZE;
    use whiteboard_wasm::okf::okf_serialize;

    let Ok(wire) = std::str::from_utf8(data) else {
        return;
    };
    let answer = okf_serialize(wire);
    if wire.len() > OKF_SERIALIZE.max_bytes {
        assert_eq!(answer, "[\"refused\",\"input-too-large\"]");
        return;
    }
    let fenced = answer.starts_with("[\"ok\",\"---\\n") && answer.ends_with("\\n---\\n\"]");
    let named = answer.starts_with("[\"unwritable\",\"") && answer.ends_with("\"]");
    let refused = answer == "[\"refused\",\"malformed\"]";
    assert!(fenced || named || refused, "{answer:.120} is not an answer");
}

/// The JSON Canvas codec on any UTF-8 text: it must answer a canvas, a refusal
/// or a decline, never panic or run past its budget; a canvas it reads must be
/// written in both modes without a panic; and the extended text must read
/// back to a canvas that is written to the same text. The check shares nothing
/// with the reader but its output, so a reader and a writer that agree on a
/// wrong reading would still pass; the recorded oracle is what holds both to
/// the TypeScript.
///
/// # Panics
///
/// When the codec panics, a canvas it read has no extended spelling, or its
/// spelling does not read back stably.
pub fn json_canvas_parse(data: &[u8]) {
    use whiteboard_codec::json_canvas::{Mode, parse, serialize};

    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let Ok(canvas) = parse(text) else {
        return;
    };
    let _ = serialize(&canvas, Mode::Strict);
    let written = serialize(&canvas, Mode::Extended);
    assert!(written.is_ok(), "{canvas:?} has no extended spelling: {written:?}");
    let written = written.unwrap_or_default();
    let again = parse(&written);
    assert!(again.is_ok(), "{canvas:?} written as {written:?} is refused: {again:?}");
    let rewritten = again.map(|second| serialize(&second, Mode::Extended));
    assert_eq!(rewritten, Ok(Ok(written.clone())), "{written:?} does not read back stably");
}
