//! A block scalar whose first line starts with a space: `yaml` 2.9 wrote
//! one that did not read back, folded or at the root, and the writer writes
//! one that does. `frontmatter_examples.rs` holds the rest of the writer.

use whiteboard_codec::frontmatter::{Value, parse, stringify};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn s(text: &str) -> Value {
    Value::String(text.to_string())
}

fn map(entries: &[(&str, Value)]) -> Value {
    Value::Map(entries.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect())
}

fn read(text: &str) -> Value {
    let read = parse(text);
    assert!(read.is_ok(), "{text:?} is refused: {read:?}");
    read.unwrap_or(Value::Null)
}

fn write(value: &Value) -> String {
    let written = stringify(value);
    assert!(written.is_ok(), "{value:?} is unwritable: {written:?}");
    written.unwrap_or_default()
}

/// `word0 word1 ... word39`.
fn prose() -> String {
    (0..=39).map(|i| format!("word{i}")).collect::<Vec<_>>().join(" ")
}

/// A block scalar whose first line starts with a space carries an indentation
/// indicator, and that line is more indented than the rest. A reader keeps
/// every line break around a more-indented line, so a string whose first line
/// would be folded is written literal instead; and a root scalar is indented
/// two columns, since `|1` at the root reads its content at column one.
#[test]
fn a_block_scalar_whose_first_line_starts_with_a_space_reads_back() {
    let led = format!(" {}\nb", prose());
    let written = write(&map(&[("a", s(&led))]));
    assert_eq!(written, format!("a: |2-\n   {}\n  b", prose()));
    assert_eq!(read(&written), map(&[("a", s(&led))]));
    let nested = map(&[("o", map(&[("a", s(&led))]))]);
    assert_eq!(read(&write(&nested)), nested);
    let in_list = Value::Seq(vec![s(&led)]);
    assert_eq!(read(&write(&in_list)), in_list);
    for root in [" a\nb", " a\n", "\n a", "  a\n b\n", led.as_str()] {
        let written = write(&s(root));
        assert!(written.starts_with("|2") || written.starts_with(">2"), "{written:?}");
        assert_eq!(read(&written), s(root), "{written:?}");
    }
    assert_eq!(write(&s(" a\nb")), "|2-\n   a\n  b");
}

#[test]
fn a_long_first_line_that_starts_with_a_space_is_written_unfolded() {
    // `yaml` 2.9 wrote a long string that starts with a space as a folded
    // scalar and folded its first, more-indented line, where a reader keeps
    // the line break: the space came back as a newline. Such a string is
    // written as a literal scalar now, which holds the line whole.
    let a = "word0 word1 word2 word3 word4 wordkkkkkkkkkkkk+kkkkkken text";
    let first = format!(" {}+{}4", "k".repeat(11), "k".repeat(51));
    let second = format!("word3{}8 wor{}d3kk", "k".repeat(25), "k".repeat(15));
    let value = map(&[("a", s(a)), ("c", s(&format!("{first} {second}\n")))]);
    let written = write(&value);
    assert_eq!(written, format!("a: {a}\nc: |2\n  {first} {second}"));
    assert_eq!(read(&written), value);
}
