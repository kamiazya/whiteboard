//! What the wire schema's Zod checks do that a grammar does not say: the
//! document's own refinements, and the length check on a value that is not a
//! string, as `nodeIdSchema` (`z.string().min(1)`) meets it in an edge's `fromNode`.
//!
//! Zod runs `min(1)` on anything that has a `length`, after refusing it as the
//! wrong type, and the host compares that length with `>=`, coercing it. Each
//! value below is what Zod 4 answers for it, checked against the installed Zod.

use whiteboard_codec::json_canvas::{Code, Failure, Issue, PathStep, parse};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const BOX: &str = r#""x":0,"y":0,"width":10,"height":10"#;

/// Refused once, as the wrong type: its length reaches one or it has none.
const WRONG_TYPE_ONLY: &[&str] = &[
    "[[]]",
    "[1]",
    "[0,1]",
    "{}",
    "5",
    "null",
    r#"{"length":1}"#,
    r#"{"length":true}"#,
    r#"{"length":"1"}"#,
    r#"{"length":"  1 \n"}"#,
    r#"{"length":"1e0"}"#,
    r#"{"length":".5e1"}"#,
    r#"{"length":"5."}"#,
    r#"{"length":"Infinity"}"#,
    r#"{"length":"0x10"}"#,
    r#"{"length":"0o7"}"#,
    r#"{"length":"0b1"}"#,
    r#"{"length":[2]}"#,
    r#"{"length":[1.5]}"#,
];

/// Refused twice, as the wrong type and as too short.
const ALSO_TOO_SHORT: &[&str] = &[
    "[]",
    r#"{"length":0}"#,
    r#"{"length":0.5}"#,
    r#"{"length":-1}"#,
    r#"{"length":null}"#,
    r#"{"length":false}"#,
    r#"{"length":""}"#,
    r#"{"length":"0"}"#,
    r#"{"length":"abc"}"#,
    r#"{"length":"inf"}"#,
    r#"{"length":"nan"}"#,
    r#"{"length":"1_0"}"#,
    r#"{"length":"1e-1"}"#,
    r#"{"length":"."}"#,
    r#"{"length":"-Infinity"}"#,
    r#"{"length":"infinity"}"#,
    r#"{"length":"0x0"}"#,
    r#"{"length":"0xg"}"#,
    r#"{"length":"0o8"}"#,
    r#"{"length":"0b2"}"#,
    r#"{"length":"0x"}"#,
    r#"{"length":[]}"#,
    r#"{"length":[0,1]}"#,
    r#"{"length":[true]}"#,
    r#"{"length":[null,1]}"#,
    r#"{"length":{}}"#,
];

fn key(name: &'static str) -> PathStep {
    PathStep::Key(name)
}

/// The issues a document is refused with.
fn refused(text: &str) -> Vec<Issue> {
    let parsed = parse(text);
    assert!(matches!(parsed, Err(Failure::Schema(_))), "{text} was not refused: {parsed:?}");
    match parsed {
        Err(Failure::Schema(issues)) => issues,
        _ => Vec::new(),
    }
}

/// A refinement the wire schema states in code, with the message it states.
fn refinement(path: Vec<PathStep>, message: &str) -> Issue {
    Issue { path, code: Code::Custom, message: Some(message.to_string()) }
}

/// The refinement that edge `e` at `index` names a node that is not there.
fn dangling(index: usize, side: &'static str, node: &str) -> Issue {
    let at = vec![key("edges"), PathStep::Index(index), key(side)];
    refinement(at, &format!(r#"edge "e" references nonexistent {side} "{node}""#))
}

/// The codes raised at an edge's `fromNode` when its value is `value`.
fn codes(value: &str) -> Vec<Code> {
    let doc = format!(
        r#"{{"nodes":[{{"id":"a",{BOX},"type":"group"}}],"edges":[{{"id":"e","fromNode":{value},"toNode":"a"}}]}}"#
    );
    let Err(Failure::Schema(issues)) = parse(&doc) else { return Vec::new() };
    let at = [PathStep::Key("edges"), PathStep::Index(0), PathStep::Key("fromNode")];
    issues.iter().filter(|i| i.path == at).map(|i| i.code).collect()
}

#[test]
fn a_value_with_a_length_reaching_one_is_refused_once() {
    for value in WRONG_TYPE_ONLY {
        assert_eq!(codes(value), [Code::InvalidType], "{value}");
    }
}

#[test]
fn a_value_with_a_length_below_one_is_refused_again_as_too_short() {
    for value in ALSO_TOO_SHORT {
        assert_eq!(codes(value), [Code::InvalidType, Code::TooSmall], "{value}");
    }
    assert!(WRONG_TYPE_ONLY.len() > 15 && ALSO_TOO_SHORT.len() > 20);
}

#[test]
fn the_documents_own_refinements_run_only_when_nothing_else_aborted() {
    let node = |id: &str| format!(r#"{{"id":"{id}",{BOX},"type":"group"}}"#);
    let doc = format!(
        r#"{{"nodes":[{},{}],"edges":[{{"id":"e","fromNode":"a","toNode":"zz"}},{{"id":"e","fromNode":"yy","toNode":"a"}}]}}"#,
        node("a"),
        node("a")
    );
    assert_eq!(
        refused(&doc),
        vec![
            refinement(vec![key("nodes")], r#"duplicate node id "a""#),
            refinement(vec![key("edges")], r#"duplicate edge id "e""#),
            dangling(0, "toNode", "zz"),
            dangling(1, "fromNode", "yy"),
        ]
    );
    // A continuing issue (a pattern) lets the refinements run beside it; an
    // aborting one (a type) stops them.
    let pattern = format!(
        r##"{{"nodes":[{{"id":"a",{BOX},"type":"group","color":"#12"}},{}],"edges":[]}}"##,
        node("a")
    );
    assert_eq!(
        refused(&pattern).iter().map(|i| i.code).collect::<Vec<_>>(),
        [Code::InvalidFormat, Code::Custom]
    );
    let typed =
        format!(r#"{{"nodes":[{{"id":"a",{BOX},"type":"group","color":5}},{}]}}"#, node("a"));
    assert_eq!(refused(&typed).iter().map(|i| i.code).collect::<Vec<_>>(), [Code::InvalidUnion]);
}
