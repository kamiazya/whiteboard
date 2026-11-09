//! The frontmatter reader and writer as properties: whatever the writer
//! writes the reader reads back as the same value, and the reader answers every
//! text, at any damage, with a value or a refusal and never a panic.
//!
//! The TypeScript twin is `frontmatter-subset.property.test.ts`.

use whiteboard_codec::frontmatter::{Refusal, Value, parse, stringify};
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, any, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// Characters that decide how a string is quoted, folded and broken, weighted
/// far above their share of random text: a string of letters never reaches a
/// block scalar, a folded line or an escape.
const AWKWARD: &[&str] = &[
    "\t",
    "\n",
    "\n\n",
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
    "\r",
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
    "@",
    "`",
];

/// A string ending in two newlines is left out: `serializeOkf` drops one of
/// them from the last value of a document (`yaml` keeps trailing blank lines
/// of a `|+` scalar and `serializeOkf` strips one newline after them), so the
/// TypeScript pair does not round-trip it either. The example test
/// `a_last_value_ending_in_two_newlines_loses_one_as_serialize_okf_does` pins
/// the shared behaviour.
fn awkward_string() -> impl Strategy<Value = String> {
    awkward_text().prop_filter("a string ending in two newlines", |text| !text.ends_with("\n\n"))
}

fn awkward_text() -> impl Strategy<Value = String> {
    let unit = prop_oneof![
        3 => prop::sample::select(AWKWARD).prop_map(str::to_string),
        1 => prop::sample::select(&["a", "b", "Z", "0", "1"][..]).prop_map(str::to_string),
    ];
    prop_oneof![
        4 => prop::collection::vec(unit, 0..24).prop_map(|parts| parts.concat()),
        1 => any::<String>().prop_map(|text| text.replace('\u{feff}', "")),
        2 => prop::collection::vec("[a-z]{1,12}", 12..24).prop_map(|words| words.join(" ")),
        6 => prop::collection::vec("[ a-z]{1,10}", 2..5).prop_map(|lines| lines.join("\n")),
        2 => prop::collection::vec("[a-z]{1,12}", 12..24)
            .prop_map(|words| format!("{}\n  {}\n", words.join(" "), words.join(" "))),
        1 => Just("k".repeat(1025)),
        1 => (1020usize..1030).prop_map(|n| "k".repeat(n)),
    ]
}

/// The doubles `JSON.stringify` and `String` print and read back: finite.
fn finite() -> impl Strategy<Value = f64> {
    use whiteboard_proptest::proptest::num::f64::{NEGATIVE, NORMAL, POSITIVE, SUBNORMAL, ZERO};
    prop_oneof![
        3 => NORMAL | SUBNORMAL | ZERO | POSITIVE | NEGATIVE,
        1 => (-1000i32..1000).prop_map(f64::from),
        1 => prop::sample::select(&[0.0, -0.0, 1e21, 1e-7, 9_007_199_254_740_992.0, 1e300, 5e-324][..]),
    ]
}

fn leaf() -> impl Strategy<Value = Value> {
    prop_oneof![
        awkward_string().prop_map(Value::String),
        finite().prop_map(Value::Number),
        any::<bool>().prop_map(Value::Bool),
        Just(Value::Null),
    ]
}

/// A document: a mapping, as frontmatter is, of values the writer has a
/// spelling for (finite numbers, no byte-order mark, no reserved key, distinct keys).
fn value() -> impl Strategy<Value = Value> {
    prop::collection::vec((awkward_string(), nested_value()), 1..5).prop_map(distinct_keys)
}

fn distinct_keys(entries: Vec<(String, Value)>) -> Value {
    let mut seen = std::collections::BTreeSet::new();
    Value::Map(
        entries.into_iter().filter(|(k, _)| k != "__proto__" && seen.insert(k.clone())).collect(),
    )
}

fn nested_value() -> impl Strategy<Value = Value> {
    leaf().prop_recursive(4, 40, 4, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Seq),
            prop::collection::vec((awkward_string(), inner), 0..4).prop_map(distinct_keys),
        ]
    })
}

/// Equality that tells `-0` from `0`, which `==` on doubles does not.
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

#[test]
fn what_the_writer_writes_the_reader_reads_back_as_the_same_value() {
    let blocks = Floor::new("a text with a block scalar");
    let explicit = Floor::new("a text with an explicit key");
    let folded = Floor::new("a text with a folded line");
    let nested = Floor::new("a text nested three deep");
    check(value(), None, |v| {
        let text = stringify(&v);
        prop_assert!(text.is_ok(), "{v:?} has no spelling");
        let text = text.unwrap_or_default();
        blocks.draw(
            text.contains(": |")
                || text.contains(": >")
                || text.starts_with('|')
                || text.starts_with('>'),
        );
        explicit.draw(text.starts_with("? ") || text.contains("\n? ") || text.contains("\n  ? "));
        folded.draw(
            text.lines()
                .any(|l| l.starts_with("  ") && !l.trim_start().starts_with(['-', '?', ':'])),
        );
        nested.draw(text.lines().any(|l| l.starts_with("      ")));
        let read = parse(&text).map_err(|why| format!("{text:?} is refused: {why:?}"));
        prop_assert!(read.is_ok(), "{read:?}");
        let read = read.unwrap_or(Value::Null);
        prop_assert!(same(&read, &v), "{text:?} reads as {read:?}, not {v:?}");
        Ok(())
    });
    blocks.assert(20);
    explicit.assert(10);
    folded.assert(20);
    nested.assert(10);
}

const DAMAGE: &[&str] = &[
    " ", ":", "#", "-", "'", "\"", "\n", "\t", "[", "]", "{", "}", ",", "&", "*", "!", "|", ">",
    "?", "%", "~", "\\",
];

/// A written text with a few characters inserted, deleted or swapped.
fn damaged() -> impl Strategy<Value = String> {
    (
        value(),
        prop::collection::vec(
            (any::<prop::sample::Index>(), 0u8..3, prop::sample::select(DAMAGE)),
            1..6,
        ),
    )
        .prop_map(|(v, edits)| {
            let mut chars: Vec<char> = stringify(&v).unwrap_or_default().chars().collect();
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

#[test]
fn the_reader_answers_every_text_and_what_it_accepts_it_can_write_back() {
    let accepted = Floor::new("an accepted text");
    let refused = Floor::new("a refused text");
    let subset = Floor::new("a text refused as outside the subset");
    check(damaged(), None, |text| {
        let first = parse(&text);
        prop_assert_eq!(&first, &parse(&text), "the same text, read twice");
        accepted.draw(first.is_ok());
        refused.draw(first.is_err());
        subset.draw(matches!(first, Err(Refusal::Subset(_))));
        if let Ok(read) = first {
            // What was read is a value of the writer's domain unless it holds a
            // double or a digit string the writer has no spelling for.
            if let Ok(written) = stringify(&read) {
                let again = parse(&written);
                prop_assert!(
                    again.as_ref().is_ok_and(|a| same(a, &read)),
                    "{written:?} reads as {again:?}, not {read:?}"
                );
            }
        }
        Ok(())
    });
    accepted.assert(40);
    refused.assert(40);
    subset.assert(5);
}

#[test]
fn the_reader_never_panics_on_arbitrary_text() {
    check(any::<String>(), None, |text| {
        let _ = parse(&text);
        Ok(())
    });
    check(
        prop::collection::vec(prop::sample::select(DAMAGE), 0..60).prop_map(|p| p.concat()),
        None,
        |text| {
            let _ = parse(&text);
            Ok(())
        },
    );
}
