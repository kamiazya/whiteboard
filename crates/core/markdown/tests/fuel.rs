//! The fuel a small text spends, exactly, so that a walk that stops charging
//! changes a figure here.
//!
//! The cost tests bound what a text may spend; they cannot see one walk among
//! thousands of units. Each text below reaches one walk the parser charges (an
//! event list handed to a resolver, a nested scan, a pass over the bytes of a
//! text, the passes over the finished events), and the figure is the whole
//! text's spend, measured. A change that adds or drops a charge moves the
//! figure and is a decision made in the diff that moves it.

use whiteboard_markdown::parse_counting;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A text, the walk it reaches, and the units it spends.
const SPENT: &[(&str, &str, usize)] = &[
    ("a paragraph: the resolvers and the passes over the finished events", "a\n", 152),
    ("a container: the document resolver's walks", "> a\n", 214),
    ("a line break: the trim of trailing whitespace", "a  \nb", 296),
    ("leading whitespace: the trim of the start of a line", "a\n  b", 354),
    ("an address: the scan of a text's bytes for an email", "a b@c.d e", 232),
    ("nested items: the scan for an item's end, and the open lists", "- a\n  - b\n- c\n", 882),
    (
        "a heading, an underline merged into the next paragraph, and a second heading",
        "x\n---\n--\ny\n---\n",
        692,
    ),
    ("emphasis inside an image: the open events each run keeps", "![*a* _b_](u)", 737),
    (
        "a URL after an entity: the second autolink pass over the finished text",
        "&amp;http://a.b/c d",
        329,
    ),
];

#[test]
fn each_walk_a_small_text_reaches_is_charged() {
    for (what, text, units) in SPENT {
        let (answer, spent) = parse_counting(text);
        assert!(answer.is_ok(), "{what}");
        assert_eq!(spent, *units, "{what}: {text:?}");
    }
}
