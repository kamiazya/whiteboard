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

#[test]
fn the_shapes_reach_what_the_bounds_are_for() {
    // A shape list that stops containing the hostile cases tests nothing.
    assert!(ORDINARY.len() > 30);
    assert!(HOSTILE.len() >= 6);
}

/// Every reference is looked up among the definitions, and one that names none
/// looks at all of them: a list scanned per reference made this 3.2 s in release
/// at the byte cap and quadratic in the count.
#[test]
fn many_definitions_and_references_to_none_are_read_in_time() {
    let (definitions, references) =
        if cfg!(target_arch = "wasm32") { (4_000, 8_000) } else { (20_000, 40_000) };
    let mut text = String::new();
    for index in 0..definitions {
        text.push_str(&format!("[d{index}]: u\n"));
    }
    text.push('\n');
    for _ in 0..references {
        text.push_str("[zz] ");
    }
    let ((answer, spent), millis) = timed(|| parse_counting(&text));
    assert!(answer.is_ok(), "{:?}", answer.err());
    assert!(spent * 4 <= fuel_for(text.len()) * 3, "{spent} units of {}", fuel_for(text.len()));
    assert!(millis < CEILING_MS / 2, "{millis} ms");
}

/// Units a shape spends a hundredth of a byte, at least: the walks over the
/// events and over the bytes of a text that the parser charges. Each floor sits
/// between what the shape spent before that walk was charged and what it spends
/// now, so a walk that stops charging falls under it. They hold at
/// `LENGTH`; a shorter text has more of its cost in the fixed fuel.
const CHARGED_FLOOR: &[(&str, usize)] = &[
    ("plain paragraphs", 1354),
    ("blank lines", 3100),
    ("one-letter lines", 4975),
    ("one-letter items", 5375),
    ("empty items", 4525),
    ("ordered items", 4620),
    ("task items", 3844),
    ("nested items", 4450),
    ("quoted lines", 3387),
    ("headings", 2700),
    ("setext headings", 3891),
    ("breaks", 1450),
    ("fenced code", 1220),
    ("html blocks", 1071),
    ("a long table", 3033),
    ("definitions and references", 3668),
    ("footnotes", 3425),
    ("images", 3238),
    ("reference links", 1607),
    ("balanced brackets", 1816),
    ("unmatched label ends", 1050),
    ("unmatched openers", 1450),
    ("code spans", 1541),
    ("math spans", 1937),
    ("entities", 1433),
    ("autolinks", 903),
    ("literal autolinks", 1030),
    ("emails", 833),
    ("hard breaks", 3012),
    ("lazy block quote lines", 3916),
    ("escapes", 1700),
    ("a long dotted word", 550),
];

#[test]
fn the_walks_over_a_text_are_charged() {
    for (name, floor) in CHARGED_FLOOR {
        let Some(shape) = ORDINARY.iter().find(|shape| shape.name == *name) else {
            panic!("no shape named {name}");
        };
        let text = text_of(shape);
        let (answer, spent) = parse_counting(&text);
        assert!(answer.is_ok(), "{name}");
        assert!(
            spent * 100 >= floor * text.len(),
            "{name}: {} hundredths a byte",
            spent * 100 / text.len()
        );
    }
    assert!(CHARGED_FLOOR.len() > 30);
}
