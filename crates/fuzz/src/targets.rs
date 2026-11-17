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
    // directive to the subset, in the TypeScript as here. And a writing
    // `serializeOkf` gets wrong is copied byte for byte, so that does not
    // read back as itself either.
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
/// newlines loses one.
fn serialize_okf_loses(text: &str) -> bool {
    text.ends_with("\n\n")
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
    // A writing `serializeOkf` gets wrong is copied byte for byte (see
    // `serialize_okf_loses`), so a document holding it is not held to it.
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
    let answer = okf_parse(text, 0);
    if text.len() > OKF_PARSE.max_bytes {
        assert_eq!(answer, "[\"refused\",\"input-too-large\"]");
        return;
    }
    // A mark changes only the text that holds it: the export answers as the
    // codec does for the same mark, whatever the text.
    let marked = okf_parse(text, 0xE000);
    let codec_marked = whiteboard_codec::okf::parse_marked(text, Some('\u{e000}'));
    assert_eq!(
        answer_tag(&marked) == "ok",
        codec_marked.is_ok(),
        "the export and the codec disagree about {text:?} marked"
    );
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
    let named = answer.starts_with("[\"unwritable\",[[") && answer.ends_with("]]");
    // Too large also answers a wire within the cap whose faults would not fit the answer.
    let refused =
        answer == "[\"refused\",\"malformed\"]" || answer == "[\"refused\",\"input-too-large\"]";
    assert!(fenced || named || refused, "{answer:.120} is not an answer");
}

/// `facet_bucket_check`, the export a host calls, on any UTF-8 text read as a
/// facets bucket: the first byte picks what the write targets, the text up to
/// the first line feed is the bucket's wire and the rest the stored library's.
/// It must answer one of its three documented shapes and never panic or run
/// past its budget, decline exactly the input past its cap, and, when it
/// stores, hold the bucket's keys: the sets and the deletions together are the
/// bucket's keys, in its order, found by reading the bucket as plain JSON,
/// which shares nothing with the wire decode. A refusal names a key the bucket
/// holds.
///
/// # Panics
///
/// When the export panics, answers off its shape or loses a key.
pub fn facet_wasm_bucket_check(data: &[u8]) {
    use whiteboard_model::Value;
    use whiteboard_model::json::parse;
    use whiteboard_wasm::facet_write::facet_bucket_check;
    use whiteboard_wasm::input_caps::FACET_BUCKET_CHECK;

    const TARGETS: [&str; 4] = ["document", "canvas", "node", "edge"];
    let Some((first, rest)) = data.split_first() else {
        return;
    };
    let Ok(text) = std::str::from_utf8(rest) else {
        return;
    };
    let (bucket, library) = text.split_once('\n').unwrap_or((text, "[\"m\"]"));
    let target = TARGETS.get(usize::from(*first) % TARGETS.len()).copied().unwrap_or("node");
    let answer = facet_bucket_check(target, bucket, library);
    if bucket.len() + library.len() > FACET_BUCKET_CHECK.max_bytes {
        assert_eq!(answer, "[\"declined\",\"input-too-large\",\"too-large\"]");
        return;
    }
    let read = parse(&answer);
    assert!(matches!(read, Ok(Value::Seq(_))), "{answer:.120} is not an answer");
    let Ok(Value::Seq(parts)) = read else {
        return;
    };
    let text_at = |at: usize| match parts.get(at) {
        Some(Value::String(text)) => Some(text.as_str()),
        _ => None,
    };
    let held = held_bucket_keys(bucket);
    match text_at(0) {
        Some("ok") => assert_stored_keys(&parts, &held),
        Some("refused") => {
            let key = text_at(1).unwrap_or_default();
            assert!(
                held.iter().any(|(name, _)| name == key),
                "{answer:.120} names no key of the bucket"
            );
            assert!(text_at(2).is_some(), "{answer:.120} names no stage");
        }
        Some("declined") => {
            assert!(parts.len() == 3 && (0..3).all(|at| text_at(at).is_some()), "{answer:.120}");
        }
        other => assert_eq!(other, Some("ok"), "{answer:.120} is not an answer"),
    }
}

/// The keys a bucket's wire holds, each with whether its value is null (a
/// deletion). The wire's mapping is `["m", key, value, key, value, ...]`, so
/// they are every second element after the tag. A bucket this reader refuses
/// is one the export declined or refused, and has no keys to hold it to.
fn held_bucket_keys(bucket: &str) -> Vec<(String, bool)> {
    use whiteboard_model::Value;
    match whiteboard_model::json::parse(bucket) {
        Ok(Value::Seq(items)) => items
            .get(1..)
            .unwrap_or_default()
            .chunks(2)
            .filter_map(|pair| match pair {
                [Value::String(key), value] => Some((key.clone(), *value == Value::Null)),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The sets an `["ok", sets, deletions]` answer names are the bucket's
/// non-null keys, and its deletions the null ones, in the bucket's order.
fn assert_stored_keys(parts: &[whiteboard_model::Value], held: &[(String, bool)]) {
    use whiteboard_model::Value;
    let names = |at: usize, skip: usize, step: usize| -> Vec<&str> {
        match parts.get(at) {
            Some(Value::Seq(items)) => items
                .iter()
                .skip(skip)
                .step_by(step)
                .filter_map(|item| match item {
                    Value::String(text) => Some(text.as_str()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    };
    let want = |gone: bool| -> Vec<&str> {
        held.iter().filter(|(_, null)| *null == gone).map(|(key, _)| key.as_str()).collect()
    };
    assert_eq!(names(1, 1, 2), want(false), "the stored keys are not the bucket's");
    assert_eq!(names(2, 1, 1), want(true), "the deleted keys are not the bucket's");
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
    use whiteboard_codec::json_canvas::{Decline, Failure, MAX_BYTES, Mode, parse, serialize};

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
    // A number writes longer than it may be spelt (`1e20` is 21 digits), so a
    // spelling can outgrow the reader's cap; that one is declined, not refused.
    if written.len() > MAX_BYTES {
        assert_eq!(again, Err(Failure::Declined(Decline::TooLarge)), "{written:?} past the cap");
        return;
    }
    assert!(again.is_ok(), "{canvas:?} written as {written:?} is refused: {again:?}");
    let rewritten = again.map(|second| serialize(&second, Mode::Extended));
    assert_eq!(rewritten, Ok(Ok(written.clone())), "{written:?} does not read back stably");
}

/// `json_canvas_parse`, the export a host calls, on any UTF-8 text: it must
/// answer one of its documented shapes and never panic or run past its budget,
/// refuse exactly the text past its cap, and read exactly what the codec
/// reads, a refusal for each decline and an `ok` for each canvas.
///
/// # Panics
///
/// When the export panics, disagrees with the codec, or answers off its shape.
pub fn json_canvas_wasm_parse(data: &[u8]) {
    use whiteboard_codec::json_canvas::{Failure, parse};
    use whiteboard_wasm::input_caps::JSON_CANVAS_PARSE;
    use whiteboard_wasm::json_canvas::json_canvas_parse;

    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let answer = json_canvas_parse(text);
    if text.len() > JSON_CANVAS_PARSE.max_bytes {
        assert_eq!(answer, "[\"refused\",\"input-too-large\",\"too-large\"]");
        return;
    }
    let shape = match parse(text) {
        Ok(_) => "[\"ok\",[\"m\",\"nodes\",[\"s\"",
        Err(Failure::Syntax) => "[\"err\",\"json-syntax\",\"syntax\",[]]",
        Err(Failure::Conversation) => "[\"err\",\"json-canvas-schema\",\"conversation\",[]]",
        Err(Failure::Schema(_)) => "[\"err\",\"json-canvas-schema\",\"schema\",[[[",
        Err(Failure::Declined(_)) => "[\"refused\",\"malformed\",\"",
    };
    assert!(answer.starts_with(shape), "{answer:.120} is not the codec's answer for {text:?}");
}

/// `json_canvas_serialize`, the export a host calls, on any UTF-8 text read as
/// a canvas wire (the decode a host's bytes reach: JSON, the value wire, the
/// canvas contract), in both modes: it must answer one of its documented
/// shapes and never panic or run past its budget, refuse exactly the wire past
/// its cap, and write only a text that opens and closes as an object.
///
/// # Panics
///
/// When the export panics or answers off its shape.
pub fn json_canvas_wasm_serialize(data: &[u8]) {
    use whiteboard_wasm::input_caps::JSON_CANVAS_SERIALIZE;
    use whiteboard_wasm::json_canvas::json_canvas_serialize;

    let Ok(wire) = std::str::from_utf8(data) else {
        return;
    };
    for strict in [false, true] {
        let answer = json_canvas_serialize(wire, strict);
        if wire.len() > JSON_CANVAS_SERIALIZE.max_bytes {
            assert_eq!(answer, "[\"refused\",\"input-too-large\",\"too-large\"]");
            continue;
        }
        let written = answer.starts_with("{\"nodes\":[") && answer.ends_with('}');
        let named = answer.starts_with("[\"schema\",[[[") && answer.ends_with("]]");
        let refused =
            answer.starts_with("[\"refused\",\"malformed\",\"") && answer.ends_with("\"]");
        assert!(written || named || refused, "{answer:.120} is not an answer");
        assert!(strict || !named, "the extended mode validates nothing: {answer:.120}");
    }
}

/// The deepest nesting of nodes in a tree, and of block containers in it,
/// walked from the root without the parser's own counts.
fn tree_depths(node: &whiteboard_markdown::mdast::Node, containers: usize) -> (usize, usize) {
    use whiteboard_markdown::mdast::Node;
    let own = usize::from(matches!(
        node,
        Node::Blockquote(_) | Node::ListItem(_) | Node::FootnoteDefinition(_)
    ));
    let containers = containers.saturating_add(own);
    let mut deepest = (1, containers);
    for child in node.children().into_iter().flatten() {
        let (below, below_containers) = tree_depths(child, containers);
        deepest = (deepest.0.max(below.saturating_add(1)), deepest.1.max(below_containers));
    }
    deepest
}

/// `whiteboard_markdown::parse_counting` on any valid UTF-8 text (an invalid
/// one is not a string to hand it): the parser answers a tree or a refusal,
/// never a panic, spends no more than its text's fuel, builds no tree deeper
/// than its declared bounds, and refuses for size only what is over the cap.
///
/// # Panics
///
/// When the parser panics, or an answer goes past a bound it declares.
pub fn markdown_parse(data: &[u8]) {
    use whiteboard_markdown::limits::{MAX_BYTES, MAX_CONTAINER_DEPTH, MAX_DEPTH, fuel_for};
    use whiteboard_markdown::{Refusal, parse_counting};
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let (answer, spent) = parse_counting(text);
    assert!(spent <= fuel_for(text.len()), "spent {spent} on {} bytes", text.len());
    match answer {
        Ok(root) => {
            let (nodes, containers) = tree_depths(&root, 0);
            assert!(nodes <= MAX_DEPTH.saturating_add(1), "{nodes} levels of nodes");
            assert!(containers <= MAX_CONTAINER_DEPTH, "{containers} levels of containers");
        }
        Err(Refusal::TooLarge) => assert!(text.len() > MAX_BYTES),
        Err(Refusal::TooDeep | Refusal::TooCostly) => {}
    }
}

/// The sfnt reader on any bytes, the way the daemon reads a font a user
/// installed: a file over the cap is refused by name, anything else is an
/// answer or an error and never a panic, and a face that parses must make the
/// measurer answer finite, non-negative advances for any text and size,
/// nothing for an empty one, and a glyph index that repeats.
///
/// # Panics
///
/// When the reader panics, accepts what the cap refuses, or a parsed face
/// measures off its contract.
pub fn sfnt_parse(data: &[u8]) {
    use whiteboard_canvas_render::font_measure::FontTableMeasurer;
    use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle, Measure};
    use whiteboard_canvas_render::sfnt::{MAX_BYTES, Sfnt, SfntError};

    let parsed = Sfnt::parse(data);
    if data.len() > MAX_BYTES {
        assert_eq!(parsed.err(), Some(SfntError::TooLarge));
        return;
    }
    let measurer = FontTableMeasurer::new().with_face("F", false, FontStyle::Normal, data);
    assert_eq!(parsed.is_ok(), measurer.is_ok(), "the reader and the measurer disagree");
    let (Ok(face), Ok(measurer)) = (parsed, measurer) else {
        return;
    };
    for ch in ['\0', 'A', 'z', '\u{ffff}', '\u{10000}', '\u{10ffff}'] {
        assert_eq!(face.glyph_index(ch), face.glyph_index(ch), "{ch:?}");
    }
    let font = |size_px| FontDescriptor {
        family: "F".to_owned(),
        fallback_chain: Vec::new(),
        weight: 400.0,
        style: FontStyle::Normal,
        size_px,
    };
    for size in [0.0, 12.0, 1e9] {
        let advance = measurer.advance_width("Hamburgefonstiv \u{ffff}", &font(size));
        assert!(advance.is_finite() && advance >= 0.0, "{advance} at {size}");
        assert!(measurer.advance_width("", &font(size)).abs() < f64::EPSILON);
        let v = measurer.vertical_metrics(&font(size));
        assert!(v.ascent.is_finite() && v.descent.is_finite() && v.line_gap.is_finite());
    }
}

/// A deterministic stand-in for the browser's measurer, which a native build
/// cannot reach: every number a function of the text and the font key, the
/// empty text with no ascent (as the browser answers it), and a key that does
/// not name a font left unanswered, so both of the host's outcomes are driven.
pub struct StandInHost;

impl whiteboard_wasm::spatial_layout::Host for StandInHost {
    fn measure(&self, text: &str, font: &str) -> Option<[f64; 4]> {
        // A key ends in the font's size: `[..., sizePx]`.
        let size: f64 = font.strip_suffix(']')?.rsplit(',').next()?.parse().ok()?;
        let units = f64::from(u32::try_from(text.chars().count()).unwrap_or(u32::MAX));
        let ascent = if text.is_empty() { 0.0 } else { size * 0.8 };
        Some([units * size * 0.55, ascent, size * 0.2, 0.0])
    }
}

/// The whole layout's export: a request, read up to the first NUL, a
/// host-measured one measured by [`StandInHost`]. Every answer is one of the
/// outcomes (laid out, refused, a markdown section missing, or the fences whose
/// tokens the host must send; never declined, owner decision q81 D7a), a call
/// past the cap is refused before it is read, and a
/// laid-out request naming a content cache is answered the same again.
///
/// # Panics
///
/// On an answer that is none of those, an input past the cap that is not
/// refused, or a warm cache that changed the answer.
pub fn layout_spatial_canvas_wasm(data: &[u8]) {
    use whiteboard_wasm::input_caps::LAYOUT_SPATIAL_CANVAS;
    use whiteboard_wasm::spatial_layout::layout_with_host;

    let at = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    let Ok(request) = std::str::from_utf8(data.get(..at).unwrap_or_default()) else {
        return;
    };
    let answer = layout_with_host(request, Some(&StandInHost));
    if request.len() > LAYOUT_SPATIAL_CANVAS.max_bytes {
        assert_eq!(answer, "[\"refused\",\"input-too-large\",\"too-large\"]");
        return;
    }
    assert_layout_answer(&answer);
    // A request naming a content cache is laid out again over what the first
    // kept: a warm cache changes timings, never the answer.
    if answer.starts_with("[\"ok\",") && request.contains("\"cache\"") {
        assert_eq!(layout_with_host(request, Some(&StandInHost)), answer);
    }
}

/// The query export: a request, read up to the first NUL, a host-measured one
/// measured by [`StandInHost`]. Every answer is laid out, refused or the fences
/// whose tokens the host must send (never declined, D7a), and a call past the cap is
/// refused before it is read.
///
/// # Panics
///
/// On an answer that is none of those, or an input past the cap that is not
/// refused.
pub fn layout_query_wasm(data: &[u8]) {
    use whiteboard_wasm::input_caps::LAYOUT_QUERY;
    use whiteboard_wasm::spatial_layout::query_with_host;

    let at = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    let Ok(request) = std::str::from_utf8(data.get(..at).unwrap_or_default()) else {
        return;
    };
    let answer = query_with_host(request, Some(&StandInHost));
    if request.len() > LAYOUT_QUERY.max_bytes {
        assert_eq!(answer, "[\"refused\",\"input-too-large\",\"too-large\"]");
        return;
    }
    let laid = answer.starts_with("[\"ok\",[") && answer.ends_with(']');
    let refused = answer.starts_with("[\"refused\",\"") && answer.ends_with("\"]");
    let needs = answer.starts_with("[\"needs\",{\"code\":[") && answer.ends_with("]}]");
    assert!(laid || refused || needs, "{answer:.120} is not an answer");
}

fn assert_layout_answer(answer: &str) {
    let laid = answer.starts_with("[\"ok\",{\"nodes\":[") && answer.ends_with("]]");
    let refused = answer.starts_with("[\"refused\",\"") && answer.ends_with("\"]");
    let needs = answer.starts_with("[\"needs\",{\"code\":[") && answer.ends_with("]}]");
    let missing = answer == "[\"missing\",\"section\"]";
    assert!(laid || refused || needs || missing, "{answer:.120} is not an answer");
}

/// The font registration's export: the faces' wire and the bytes they point
/// into, split at the first NUL. Every answer is a handle or a refusal, a call
/// past the cap is refused before it is read, and a handle measures a layout
/// (whatever the fuzzed faces hold) until it is released, after which the
/// layout names the handle unknown.
///
/// # Panics
///
/// On an answer that is neither, an input past the cap that is not refused,
/// a layout over the handle that is not an answer or names the handle unknown,
/// or a release that does not forget it.
pub fn register_layout_fonts_wasm(data: &[u8]) {
    use whiteboard_wasm::input_caps::REGISTER_LAYOUT_FONTS;
    use whiteboard_wasm::spatial_layout::{
        layout_spatial_canvas, register_layout_fonts, release_layout_fonts,
    };

    let at = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    let (faces, bytes) = data.split_at(at);
    let Ok(faces) = std::str::from_utf8(faces) else {
        return;
    };
    let bytes = bytes.get(1..).unwrap_or_default();
    let answer = register_layout_fonts(bytes, faces);
    if faces.len() + bytes.len() > REGISTER_LAYOUT_FONTS.max_bytes {
        assert_eq!(answer, "[\"refused\",\"input-too-large\",\"too-large\"]");
        return;
    }
    let handle = answer.strip_prefix("[\"ok\",").and_then(|rest| rest.strip_suffix(']'));
    let Some(handle) = handle.and_then(|h| h.parse::<u32>().ok()) else {
        let refused = answer.starts_with("[\"refused\",\"") && answer.ends_with("\"]");
        assert!(refused, "{answer:.120} is not an answer");
        return;
    };
    let request = format!(
        "[\"m\",\"canvas\",[\"m\",\"nodes\",[\"s\",[\"m\",\"id\",\"a\",\"x\",0,\"y\",0,\"width\",160,\"height\",80,\"resource\",[\"m\",\"mimeType\",\"text/markdown\",\"content\",\"Hamburgefonstiv \\u00e9\"]]],\"edges\",[\"s\"]],\"measure\",[\"m\",\"kind\",\"fonts\",\"handle\",{handle}],\"mode\",\"light\",\"expand\",true]"
    );
    let lost = "[\"refused\",\"malformed\",\"font-handle\"]";
    let held = layout_spatial_canvas(&request, None);
    assert_layout_answer(&held);
    assert_ne!(held, lost, "{handle} was answered but names no faces");
    assert!(release_layout_fonts(handle), "{handle} was not held");
    assert_eq!(layout_spatial_canvas(&request, None), lost);
}

/// `search_op`, the one export a host calls for every search question, on any
/// UTF-8 text read as its request. It holds an index and label sets between
/// calls, so a run of inputs drives the handle table too. It must answer one
/// JSON text, `["ok", ...]` or `["refused", code]` with a code from the
/// refusal vocabulary, refuse exactly the request past its cap as too large,
/// and never panic or run past its budget.
///
/// # Panics
///
/// When the export panics or answers off its shape.
pub fn search_wasm(data: &[u8]) {
    use whiteboard_wasm::input_caps::SEARCH_OP;
    use whiteboard_wasm::search::search_op;

    let Ok(request) = std::str::from_utf8(data) else {
        return;
    };
    let answer = search_op(request);
    if request.len() > SEARCH_OP.max_bytes {
        assert_eq!(answer, "[\"refused\",\"input-too-large\"]");
        return;
    }
    let ok = answer.starts_with("[\"ok\"") && answer.ends_with(']');
    let refused =
        answer == "[\"refused\",\"malformed\"]" || answer == "[\"refused\",\"input-too-large\"]";
    assert!(ok || refused, "{answer:.120} is not an answer");
}
