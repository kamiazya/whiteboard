//! What a text costs to read, by shape.
//!
//! Each shape is a unit repeated to a length. The ones that were quadratic in
//! the upstream parser are the point: an ordinary text that is read must stay
//! inside its fuel with room to spare, a text built to be quadratic must be
//! refused rather than run, and every shape must be answered in time whichever
//! way, which fuel cannot show alone: a loop that does not charge it is
//! invisible to the count and only the clock sees it.

use whiteboard_markdown::limits::fuel_for;
use whiteboard_markdown::{Refusal, parse_counting};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A unit repeated to `length` bytes, after a fixed prefix.
struct Shape {
    name: &'static str,
    prefix: &'static str,
    unit: &'static str,
}

const fn shape(name: &'static str, prefix: &'static str, unit: &'static str) -> Shape {
    Shape { name, prefix, unit }
}

/// Text a reader writes, at the two extremes of how short its lines are.
const ORDINARY: &[Shape] = &[
    shape("plain paragraphs", "", "word 1 and more words\n\n"),
    shape("blank lines", "", "\n"),
    shape("one-letter lines", "", "a\n"),
    shape("one-letter items", "", "- a\n"),
    shape("empty items", "", "-\n"),
    shape("ordered items", "", "1. a\n"),
    shape("task items", "", "- [ ] a\n"),
    shape("nested items", "- x\n", "  - a\n"),
    shape("quoted lines", "", "> a\n"),
    shape("headings", "", "# h\n"),
    shape("setext headings", "", "a\n---\n"),
    shape("breaks", "", "***\n"),
    shape("fenced code", "", "```\na\n```\n"),
    shape("html blocks", "", "<div>\n\n"),
    shape("a long table", "|a|b|\n|-|-|\n", "|x|y|\n"),
    shape("definitions and references", "", "[a]: b\n[a]\n"),
    shape("footnotes", "", "[^1]: x\nt[^1]\n"),
    shape("images", "", "![a](b) "),
    shape("reference links", "", "[a][b] "),
    shape("balanced brackets", "", "[a]"),
    shape("unmatched label ends", "", "a] "),
    shape("unmatched openers", "", "["),
    shape("code spans", "", "a&b`c`"),
    shape("lone backticks", "", "`"),
    shape("math spans", "", "$a$ "),
    shape("entities", "", "&amp; &#35; "),
    shape("autolinks", "", "<http://a.b> "),
    shape("literal autolinks", "", "awww."),
    shape("emails", "", "a@b.c "),
    shape("literal URLs after an entity", "", "&amp;http://a.b/c "),
    shape("literal www after an entity", "", "&amp;www.a.b. "),
    shape("emails after an entity", "", "&amp;a@b.co "),
    shape("emails refused one by one", "", "&amp;a@b- "),
    shape("hard breaks", "", "a  \n"),
    shape("lazy block quote lines", "", "> a\nb\n"),
    shape("escapes", "a]", "\\*"),
    shape("a long delimiter run", "", "*"),
    shape("a long dotted word", "", "a."),
];

/// Text built to be quadratic: refused, whatever its length.
const HOSTILE: &[Shape] = &[
    shape("one-line nested items", "", "- "),
    shape("one-line nested quotes", "", "> "),
    shape("unmatched emphasis closers", "", "a* "),
    shape("mixed openers and closers", "", "*a_ "),
    shape("unmatched strikethrough closers", "", "a~ "),
    shape("a refused literal autolink retried", "", "www._"),
];

/// Bytes of repeated unit: small enough that a debug build, and wasm, finish.
const LENGTH: usize = if cfg!(target_arch = "wasm32") { 24_000 } else { 64_000 };

/// What a shape's text answers in this much time, in a debug build on a loaded machine.
const CEILING_MS: u128 = 10_000;

fn text_of(shape: &Shape) -> String {
    let mut text = String::from(shape.prefix);
    while text.len() < LENGTH {
        text.push_str(shape.unit);
    }
    text
}

#[cfg(not(target_arch = "wasm32"))]
#[expect(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "this test reads the clock to see a loop that spends no fuel; the parser never does"
)]
fn timed<T>(work: impl FnOnce() -> T) -> (T, u128) {
    let started = std::time::Instant::now();
    let answer = work();
    (answer, started.elapsed().as_millis())
}

/// wasm32-unknown-unknown has no clock to read.
#[cfg(target_arch = "wasm32")]
fn timed<T>(work: impl FnOnce() -> T) -> (T, u128) {
    (work(), 0)
}

#[test]
fn ordinary_text_is_read_with_fuel_to_spare() {
    for shape in ORDINARY {
        let text = text_of(shape);
        let ((answer, spent), millis) = timed(|| parse_counting(&text));
        assert!(answer.is_ok(), "{}: {:?}", shape.name, answer.err());
        // A quarter of the fuel is headroom against a text a little denser
        // than the densest here.
        assert!(
            spent * 4 <= fuel_for(text.len()) * 3,
            "{}: {spent} units of {}",
            shape.name,
            fuel_for(text.len())
        );
        assert!(millis < CEILING_MS, "{}: {millis} ms", shape.name);
    }
}

#[test]
fn a_text_built_to_be_quadratic_is_refused_inside_the_time() {
    for shape in HOSTILE {
        let text = text_of(shape);
        let ((answer, spent), millis) = timed(|| parse_counting(&text));
        // Nested containers are refused for their depth before they cost anything.
        let why = if shape.name.starts_with("one-line nested") {
            Refusal::TooDeep
        } else {
            Refusal::TooCostly
        };
        assert_eq!(answer.err(), Some(why), "{}", shape.name);
        assert!(spent <= fuel_for(text.len()), "{}: {spent}", shape.name);
        assert!(millis < CEILING_MS, "{}: {millis} ms", shape.name);
    }
}

/// The dearest text the second autolink pass can be given and still read: every `www.`
/// start in one long unbroken run is a failed attempt that reads 2,304 characters. The
/// pass charges the work, so the text is read inside its fuel (about 50 units a byte
/// in all, against 64 allowed), and a text a little denser is refused.
#[test]
fn a_run_of_failing_literal_urls_is_read_inside_the_fuel_it_charges() {
    let text = "&amp;www.a\\_".repeat(if cfg!(target_arch = "wasm32") { 2_000 } else { 5_000 });
    let ((answer, spent), millis) = timed(|| parse_counting(&text));
    assert!(answer.is_ok(), "{:?}", answer.err());
    assert!(spent <= fuel_for(text.len()), "{spent}");
    // The pass, not the tokenizer, is most of it.
    assert!(spent > fuel_for(text.len()) / 2, "{spent}");
    assert!(millis < CEILING_MS, "{millis} ms");
}

#[test]
fn the_shapes_reach_what_the_bounds_are_for() {
    // A shape list that stops containing the hostile cases tests nothing.
    assert!(ORDINARY.len() > 30);
    assert!(HOSTILE.len() >= 6);
}
