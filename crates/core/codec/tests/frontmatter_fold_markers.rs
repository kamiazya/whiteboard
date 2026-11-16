//! A scalar at the root that a fold at 80 columns would start a line of with a
//! directive or a document marker. Its own file because the examples beside it
//! (`frontmatter_examples.rs`) are at the file-size budget.

use whiteboard_codec::frontmatter::{Value, parse, stringify};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn s(text: &str) -> Value {
    Value::String(text.to_string())
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

#[test]
fn a_root_scalar_folded_onto_a_document_marker_or_directive_is_indented() {
    // At the root a scalar's lines start at column 0, so `yaml` indents one
    // whose text starts a line with `%`, `---` or `...` — but it looks before
    // folding, and a fold starts new lines. Unindented, `--- ` and `... ` end
    // the document (YAML 1.2 c-forbidden) and the subset refuses a `%`-led
    // line, so the value did not read back. Plain, single-quoted and `>` each fold; some width of the run before
    // the marker lands it at the start of a line in each.
    let cases = ["%x", "---", "..."].into_iter().flat_map(|marker| {
        (70..84).flat_map(move |width| {
            let long = "x".repeat(width);
            [
                format!("{long} {marker} yyyyyyyyyy z"),
                format!("\"{long} {marker} yyyyyyyyyy z"),
                format!("a\n{long} {marker} yyyyyyyyyy z"),
            ]
        })
    });
    for value in cases {
        let written = write(&s(&value));
        assert_eq!(read(&written), s(&value), "{written:?}");
    }
    // The counterexample the property found, as it shrank.
    let found = "𞗐0A ®\u{a8e0}®ଲ® 𝑖 0ਸ𞠀0౷🌀0\u{16ff0}ぁ𞹝\u{1e01b} 𞺫  $®\u{cca}a >\n  aaaaa aaaaa aaaaaaaaa aaaaaaaaa aaa %aaaaaaaaa aaa aaaaaaaa aaaa aaaaaaaaaaaa\n  aa aaaaaaaaaaaa aaaaaaaa\n    aaaaa aaaaa aaaaaaaaa aaaaaaaaa aaa aaaaaaaaaa aaa aaaaaaaa aaaa aaaaaaaaaaaa aa aaaaaaaaaaaa aaaaaaaa";
    let value = read(found);
    let written = write(&value);
    assert_eq!(read(&written), value, "{written:?}");
}

#[test]
fn a_root_scalar_folded_onto_no_marker_keeps_its_folds_at_the_margin() {
    // The re-fold is for a marker alone: a long single-quoted scalar at the
    // root whose folds start no line with one is written as yaml writes it,
    // continuation lines at column 0.
    let value = format!("\"{} yyyyyyyyyy z", "x".repeat(78));
    let written = write(&s(&value));
    assert!(written.starts_with('\''), "{written:?}");
    assert!(written.contains('\n'), "{written:?}");
    assert!(written.lines().skip(1).all(|line| !line.starts_with(' ')), "{written:?}");
    assert_eq!(read(&written), s(&value), "{written:?}");
}
