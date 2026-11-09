//! The OKF envelope as properties: whatever the writer writes the reader
//! reads back, the fence split and the reader agree about what a block is,
//! and the reader answers every text with a document or a refusal.

use whiteboard_codec::frontmatter::Value;
use whiteboard_codec::okf::{
    Document, Failure, Frontmatter, Map, TrustEvent, has_frontmatter, parse, serialize,
};
use whiteboard_proptest::proptest::prelude::{
    Strategy, any, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// Characters that decide how a string is quoted, folded and broken.
const AWKWARD: &[&str] = &[
    "\t",
    "\n",
    " ",
    "  ",
    "\u{85}",
    "\u{2028}",
    "\u{7f}",
    "\u{1}",
    "\"",
    "'",
    "#",
    ":",
    "-",
    "?",
    "|",
    ">",
    "\\",
    "\u{e9}",
    "\u{1f600}",
    "---",
    "...",
    "%",
    "[",
    "]",
    "{",
    "}",
    ",",
    "&",
    "*",
    "!",
    "a",
    "b",
    "0",
    "1",
];

const RESERVED: [&str; 10] = [
    "type",
    "title",
    "description",
    "resource",
    "tags",
    "view",
    "facets",
    "generated",
    "verified",
    "__proto__",
];

/// What `serializeOkf` cannot write back: a last value ending in two
/// newlines loses one, and a multi-line string with a line that starts with a
/// space or tab can be folded at a space on that more-indented line.
fn written_back(text: &str) -> bool {
    !(text.ends_with("\n\n")
        || (text.contains('\n') && text.split('\n').any(|line| line.starts_with([' ', '\t']))))
}

fn awkward() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => prop::collection::vec(prop::sample::select(AWKWARD), 0..16).prop_map(|p| p.concat()),
        1 => any::<String>().prop_map(|text| text.replace('\u{feff}', "")),
        2 => prop::collection::vec("[a-z]{1,10}", 8..16).prop_map(|w| w.join(" ")),
    ]
}

fn text() -> impl Strategy<Value = String> {
    awkward().prop_filter("a string the writer loses", |text| written_back(text))
}

fn key() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => awkward(),
        2 => prop::sample::select(&["2", "10", "01", "z", "a", "\u{ff5e}", "\u{1f600}", "\u{e000}"][..]).prop_map(str::to_string),
    ]
    .prop_filter("a reserved key", |key| !RESERVED.contains(&key.as_str()))
}

fn number() -> impl Strategy<Value = f64> {
    prop_oneof![
        3 => (-1000i32..1000).prop_map(f64::from),
        1 => prop::sample::select(&[0.0, -0.0, 1e21, 1e-7, 0.5, 5e-324][..]),
    ]
}

fn distinct(entries: Vec<(String, Value)>) -> Map {
    let mut seen = std::collections::BTreeSet::new();
    entries.into_iter().filter(|(k, _)| seen.insert(k.clone())).collect()
}

fn payload() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        text().prop_map(Value::String),
        number().prop_map(Value::Number),
        any::<bool>().prop_map(Value::Bool),
        prop::strategy::Just(Value::Null),
    ];
    leaf.prop_recursive(3, 24, 3, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..3).prop_map(Value::Seq),
            prop::collection::vec((key(), inner), 0..3).prop_map(|e| Value::Map(distinct(e))),
        ]
    })
}

fn event() -> impl Strategy<Value = TrustEvent> {
    (
        "[a-z]{1,5}[:/][a-z0-9.]{1,6}",
        prop::sample::select(&["2026-01-02T03:04:05Z", "2026-01-02T03:04:05.5+09:00"][..]),
        prop::collection::vec((key(), payload()), 0..3),
    )
        .prop_map(|(by, at, extra)| TrustEvent {
            by,
            at: at.to_string(),
            extra: distinct(extra).into_iter().filter(|(k, _)| k != "by" && k != "at").collect(),
        })
}

fn record(keys: impl Strategy<Value = String>, least: usize) -> impl Strategy<Value = Map> {
    prop::collection::vec((keys, payload()), least..4).prop_map(distinct)
}

fn frontmatter() -> impl Strategy<Value = Frontmatter> {
    let head = (
        text().prop_filter("a document needs a type", |t| !t.is_empty()),
        prop::option::of(text()),
        prop::option::of(text()),
        prop::option::of(text()),
        prop::option::of(prop::collection::vec(text(), 0..4)),
        prop::option::of(text()),
    );
    let tail = (
        prop::option::of(event()),
        prop::option::of(prop::collection::vec(event(), 0..3)),
        prop::option::of(record("[a-z][a-z0-9-]{0,5}\\.[a-z][a-z0-9-]{0,5}/v[0-9]{1,2}", 0)),
        prop::option::of(record(key(), 1)),
    );
    (head, tail).prop_map(|((r#type, title, description, resource, tags, view), tail)| {
        let (generated, verified, facets, facets_raw) = tail;
        Frontmatter {
            r#type,
            title,
            description,
            resource,
            tags,
            view,
            generated,
            verified,
            facets,
            facets_raw,
        }
    })
}

fn document() -> impl Strategy<Value = Document> {
    (frontmatter(), prop_oneof![awkward(), any::<String>()])
        .prop_map(|(frontmatter, body)| Document { frontmatter, body })
}

/// JavaScript's key order, computed here from the number a key spells.
fn enumeration(entries: Map) -> Map {
    let index = |k: &str| k.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == k);
    let (mut indexed, rest): (Vec<_>, Vec<_>) =
        entries.into_iter().partition(|(k, _)| index(k).is_some());
    indexed.sort_by_key(|(k, _)| index(k));
    indexed.into_iter().chain(rest).map(|(k, v)| (k, normal_value(v))).collect()
}

fn normal_value(value: Value) -> Value {
    match value {
        Value::Seq(items) => Value::Seq(items.into_iter().map(normal_value).collect()),
        Value::Map(entries) => Value::Map(enumeration(entries)),
        other => other,
    }
}

/// A record as the writer writes it and the reader reads it back: sorted by
/// UTF-16 code units, then enumerated the way JavaScript enumerates.
fn canonical(entries: Map) -> Map {
    let mut sorted = entries;
    sorted.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    enumeration(sorted)
}

fn normal_event(event: TrustEvent) -> TrustEvent {
    TrustEvent { extra: enumeration(event.extra), ..event }
}

fn normal(doc: Document) -> Document {
    let fm = doc.frontmatter;
    let frontmatter = Frontmatter {
        generated: fm.generated.map(normal_event),
        verified: fm.verified.map(|list| list.into_iter().map(normal_event).collect()),
        facets: fm.facets.map(canonical),
        facets_raw: fm.facets_raw.map(canonical),
        ..fm
    };
    Document { frontmatter, body: doc.body }
}

#[test]
fn what_the_writer_writes_the_reader_reads_back_as_the_same_document() {
    let facets = Floor::new("a document with facets");
    let raw = Floor::new("a document with preserved keys");
    let trust = Floor::new("a document with a trust event");
    let blocks = Floor::new("a document with a block scalar");
    check(document(), None, |doc| {
        let written = serialize(&doc);
        prop_assert!(written.is_ok(), "{doc:?} has no spelling: {written:?}");
        let written = written.unwrap_or_default();
        facets.draw(doc.frontmatter.facets.as_ref().is_some_and(|f| !f.is_empty()));
        raw.draw(doc.frontmatter.facets_raw.is_some());
        trust.draw(doc.frontmatter.generated.is_some() || doc.frontmatter.verified.is_some());
        blocks.draw(written.contains(": |") || written.contains(": >"));
        let read = parse(&written);
        prop_assert!(read.is_ok(), "{written:?} is refused: {read:?}");
        let expected = normal(doc);
        let read = read.unwrap_or_else(|_| expected.clone());
        prop_assert_eq!(format!("{read:?}"), format!("{expected:?}"), "{:?}", written);
        Ok(())
    });
    facets.assert(40);
    raw.assert(40);
    trust.assert(40);
    blocks.assert(10);
}

fn damage() -> impl Strategy<Value = String> {
    (
        document(),
        prop::collection::vec(
            (
                any::<prop::sample::Index>(),
                0u8..3,
                prop::sample::select(&["-", "\n", "\r", ":", " ", "\"", "#"][..]),
            ),
            0..4,
        ),
    )
        .prop_map(|(doc, edits)| {
            let mut chars: Vec<char> = serialize(&doc).unwrap_or_default().chars().collect();
            for (at, kind, piece) in edits {
                let i = at.index(chars.len() + 1).min(chars.len());
                let piece = piece.chars().next().unwrap_or(' ');
                match (kind, chars.get(i)) {
                    (0, _) => chars.insert(i, piece),
                    (1, Some(_)) => {
                        chars.remove(i);
                    }
                    (_, Some(_)) => chars[i] = piece,
                    _ => {}
                }
            }
            chars.into_iter().collect()
        })
}

/// Texts built from the pieces a fence and a frontmatter are made of.
fn soup() -> impl Strategy<Value = String> {
    let pieces = &[
        "---",
        "\r",
        "\n",
        "\r\n",
        "a: 1",
        "type: x",
        " ",
        "-",
        "{",
        "\"",
        "&a",
        "*a",
        "\n---\n",
        "type: note\n",
    ][..];
    prop::collection::vec(prop::sample::select(pieces), 0..24).prop_map(|p| p.concat())
}

/// Whether a string the document holds is one the writer loses a character of.
fn holds_lossy_text(doc: &Document) -> bool {
    fn lossy(value: &Value) -> bool {
        match value {
            Value::String(text) => !written_back(text),
            Value::Seq(items) => items.iter().any(lossy),
            Value::Map(entries) => entries.iter().any(|(_, item)| lossy(item)),
            _ => false,
        }
    }
    let fm = &doc.frontmatter;
    let texts = [
        Some(&fm.r#type),
        fm.title.as_ref(),
        fm.description.as_ref(),
        fm.resource.as_ref(),
        fm.view.as_ref(),
    ];
    let events = fm.generated.iter().chain(fm.verified.iter().flatten());
    texts.into_iter().flatten().chain(fm.tags.iter().flatten()).any(|t| !written_back(t))
        || events.flat_map(|e| [&e.by, &e.at]).any(|t| !written_back(t))
        || fm
            .verified
            .iter()
            .flatten()
            .chain(fm.generated.iter())
            .any(|e| e.extra.iter().any(|(_, v)| lossy(v)))
        || [&fm.facets, &fm.facets_raw].into_iter().flatten().flatten().any(|(_, v)| lossy(v))
}

#[test]
fn the_split_and_the_reader_agree_and_what_is_read_writes_back_stably() {
    let accepted = Floor::new("an accepted text");
    let unfenced = Floor::new("a text with no block");
    let schema = Floor::new("a text the schema refused");
    let stable = Floor::new("a text read, written and read again");
    check(prop_oneof![3 => damage(), 1 => soup()], None, |text| {
        let first = parse(&text);
        prop_assert_eq!(has_frontmatter(&text), first != Err(Failure::NoFence), "{:?}", text);
        accepted.draw(first.is_ok());
        unfenced.draw(first == Err(Failure::NoFence));
        schema.draw(matches!(first, Err(Failure::Schema(_))));
        let Ok(read) = first else { return Ok(()) };
        // Only what the writer can spell and read back is held to a second reading.
        let Ok(written) = serialize(&read) else { return Ok(()) };
        let skipped = holds_lossy_text(&read);
        stable.draw(!skipped);
        if skipped {
            return Ok(());
        }
        let again = parse(&written).map(|doc| serialize(&doc));
        prop_assert_eq!(again, Ok(Ok(written.clone())), "{:?}", written);
        Ok(())
    });
    accepted.assert(40);
    unfenced.assert(20);
    schema.assert(5);
    stable.assert(40);
}

#[test]
fn the_reader_never_panics_on_arbitrary_text() {
    check(any::<String>(), None, |text| {
        let _ = parse(&text);
        let _ = has_frontmatter(&text);
        Ok(())
    });
    check(soup(), None, |text| {
        let _ = parse(&text);
        Ok(())
    });
}
