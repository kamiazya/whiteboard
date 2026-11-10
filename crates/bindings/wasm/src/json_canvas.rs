//! `parseSpatial` and `serializeSpatial` over the canvas wire (ADR-0054 step 6).
//!
//! A read answers one JSON text whose first element names the outcome, so a
//! refusal and a result travel the same way. A write answers the document's
//! text itself, which always opens with `{`, or a JSON array opening with `[`
//! for anything else: the text of a board is the one answer large enough that
//! quoting it into an array would cost more than the write, and the first
//! character tells the two apart. The canvas crosses as the wire of
//! [`crate::json_canvas_wire`].
//!
//! Where the core does not answer it refuses with a code and the class of the
//! input that earned it, and the host's TypeScript answers: a text or wire past
//! the entry's cap, a lone surrogate, nesting past the reader's or writer's
//! depth, a link whose validity as a URL needs tables the core does not carry,
//! and a value JSON has no spelling for.

use crate::input_caps::{JSON_CANVAS_PARSE, JSON_CANVAS_SERIALIZE};
use crate::json_canvas_wire::{canvas_from, canvas_json};
use serde_json::{Value as Json, json};
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_codec::json_canvas::{
    Code, Decline, Failure, Issue, Mode, PathStep, WriteFailure, parse, serialize,
};

fn refused(code: &str, class: &str) -> Json {
    json!(["refused", code, class])
}

/// A decline is a refusal: the code says whether the input was past a cap, the
/// class what the core cannot answer.
fn declined(why: Decline) -> Json {
    match why {
        Decline::TooLarge => refused("input-too-large", "too-large"),
        Decline::TooDeep => refused("malformed", "too-deep"),
        Decline::LoneSurrogate => refused("malformed", "lone-surrogate"),
        Decline::Unwritable => refused("malformed", "unwritable"),
    }
}

fn code(code: Code) -> &'static str {
    match code {
        Code::InvalidType => "invalid_type",
        Code::TooSmall => "too_small",
        Code::TooBig => "too_big",
        Code::InvalidFormat => "invalid_format",
        Code::InvalidValue => "invalid_value",
        Code::InvalidUnion => "invalid_union",
        Code::Custom => "custom",
    }
}

fn issues(issues: &[Issue]) -> Json {
    Json::Array(
        issues
            .iter()
            .map(|issue| {
                let path: Vec<Json> = issue
                    .path
                    .iter()
                    .map(|step| match step {
                        PathStep::Key(name) => json!(name),
                        PathStep::Index(at) => json!(at),
                    })
                    .collect();
                match &issue.message {
                    Some(message) => json!([path, code(issue.code), message]),
                    None => json!([path, code(issue.code)]),
                }
            })
            .collect(),
    )
}

/// `parseSpatial` of a text.
///
/// Out: `["ok", canvas]` with the canvas in the wire of
/// [`crate::json_canvas_wire`]; `["err", stage, class, issues]` with `issues` a
/// list of `[path, code]`, or `[path, code, message]` for a refinement the
/// schema words itself (empty unless the class is `schema`), the stage
/// `json-syntax` or `json-canvas-schema` and the class `syntax`, `conversation`
/// or `schema`; or `["refused", code, class]`.
#[wasm_bindgen]
#[must_use]
pub fn json_canvas_parse(text: &str) -> String {
    parsed(text).to_string()
}

fn parsed(text: &str) -> Json {
    if text.len() > JSON_CANVAS_PARSE.max_bytes {
        return declined(Decline::TooLarge);
    }
    match parse(text) {
        Ok(canvas) => json!(["ok", canvas_json(&canvas)]),
        Err(Failure::Syntax) => json!(["err", "json-syntax", "syntax", []]),
        Err(Failure::Conversation) => json!(["err", "json-canvas-schema", "conversation", []]),
        Err(Failure::Schema(found)) => {
            json!(["err", "json-canvas-schema", "schema", issues(&found)])
        }
        Err(Failure::Declined(why)) => declined(why),
    }
}

/// `serializeSpatial` of a canvas, strictly (JSON Canvas 1.0 alone, validated)
/// or extended.
///
/// In: the canvas in the wire of [`crate::json_canvas_wire`]. Out: the
/// document's text; `["schema", issues]` when the strict mode's validation
/// refuses what it wrote, each issue as in a read; or `["refused", code,
/// class]` for a wire past the cap or one that is no canvas.
#[wasm_bindgen]
#[must_use]
pub fn json_canvas_serialize(canvas: &str, strict: bool) -> String {
    written(canvas, strict)
}

fn written(wire: &str, strict: bool) -> String {
    if wire.len() > JSON_CANVAS_SERIALIZE.max_bytes {
        return declined(Decline::TooLarge).to_string();
    }
    let Some(canvas) = serde_json::from_str::<Json>(wire).ok().as_ref().and_then(canvas_from)
    else {
        return refused("malformed", "wire").to_string();
    };
    let mode = if strict { Mode::Strict } else { Mode::Extended };
    match serialize(&canvas, mode) {
        Ok(text) => text,
        Err(WriteFailure::Schema(found)) => json!(["schema", issues(&found)]).to_string(),
        Err(WriteFailure::Declined(why)) => declined(why).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{json_canvas_parse, json_canvas_serialize};
    use crate::input_caps::{JSON_CANVAS_PARSE, JSON_CANVAS_SERIALIZE};
    use serde_json::{Value as Json, json};
    use whiteboard_codec::json_canvas::{MAX_BYTES, MAX_DEPTH};

    fn parsed(text: &str) -> Json {
        serde_json::from_str(&json_canvas_parse(text)).unwrap_or(Json::Null)
    }

    fn node(id: &str) -> Json {
        json!(["m", "id", id, "x", 0, "y", 0, "width", 10, "height", 10])
    }

    fn canvas(nodes: &[Json]) -> Json {
        let mut list = vec![json!("s")];
        list.extend(nodes.iter().cloned());
        json!(["m", "nodes", list, "edges", ["s"]])
    }

    fn written(wire: &Json, strict: bool) -> String {
        json_canvas_serialize(&wire.to_string(), strict)
    }

    #[test]
    fn the_caps_are_the_codecs_own() {
        assert_eq!(JSON_CANVAS_PARSE.max_bytes, MAX_BYTES);
        assert_eq!(JSON_CANVAS_SERIALIZE.max_bytes, MAX_BYTES);
        assert_eq!(JSON_CANVAS_PARSE.max_depth, MAX_DEPTH);
    }

    #[test]
    fn a_read_answers_the_canvas_in_the_wire() {
        let text = r#"{"nodes":[{"id":"a","type":"text","text":"hi","x":1,"y":-2,"width":3,"height":5}],"x-whiteboard":{"tags":["t"]}}"#;
        assert_eq!(
            parsed(text),
            json!([
                "ok",
                [
                    "m",
                    "nodes",
                    [
                        "s",
                        [
                            "m",
                            "id",
                            "a",
                            "x",
                            1,
                            "y",
                            -2,
                            "width",
                            3,
                            "height",
                            5,
                            "resource",
                            ["m", "mimeType", "text/markdown", "content", "hi"]
                        ]
                    ],
                    "edges",
                    ["s"],
                    "tags",
                    ["s", "t"]
                ]
            ])
        );
    }

    #[test]
    fn a_refusal_names_the_stage_the_class_and_each_issue() {
        assert_eq!(parsed("{"), json!(["err", "json-syntax", "syntax", []]));
        assert_eq!(
            parsed(r#"{"x-whiteboard":{"comments":[1]}}"#),
            json!(["err", "json-canvas-schema", "conversation", []])
        );
        assert_eq!(
            parsed(r#"{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1}]}"#),
            json!([
                "err",
                "json-canvas-schema",
                "schema",
                [[["nodes", 0, "text"], "invalid_type"]]
            ])
        );
    }

    #[test]
    fn what_the_core_does_not_read_is_refused_with_its_class() {
        assert_eq!(
            parsed(
                r#"{"nodes":[{"id":"\ud800","type":"group","x":0,"y":0,"width":1,"height":1}]}"#
            ),
            json!(["refused", "malformed", "lone-surrogate"])
        );
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
        assert_eq!(parsed(&deep), json!(["refused", "malformed", "too-deep"]));
        let link = r#"{"nodes":[{"id":"a","type":"link","url":"https://xn--e1afmkfd.example/","x":0,"y":0,"width":1,"height":1}]}"#;
        assert_eq!(parsed(link), json!(["refused", "malformed", "url"]));
    }

    #[test]
    fn a_text_past_the_cap_is_refused_and_one_at_it_is_read() {
        let head = r#"{"nodes":[],"x":""#;
        let at_cap =
            format!("{head}{}\"}}", "a".repeat(JSON_CANVAS_PARSE.max_bytes - head.len() - 2));
        assert_eq!(at_cap.len(), JSON_CANVAS_PARSE.max_bytes);
        assert_eq!(parsed(&at_cap)[0], json!("ok"));
        assert_eq!(
            parsed(&format!("{at_cap} ")),
            json!(["refused", "input-too-large", "too-large"])
        );
    }

    #[test]
    fn a_write_answers_the_text_and_the_mode_decides_what_it_holds() {
        let wire = json!([
            "m",
            "nodes",
            ["s", ["m", "id", "a", "x", 1, "y", 2, "width", 3, "height", 4, "tags", ["s", "t"]]],
            "edges",
            ["s"]
        ]);
        let extended = written(&wire, false);
        assert!(extended.starts_with('{'), "{extended}");
        assert!(extended.contains("x-whiteboard"), "{extended}");
        let strict = written(&wire, true);
        assert!(strict.starts_with('{') && !strict.contains("x-whiteboard"), "{strict}");
    }

    #[test]
    fn the_strict_mode_names_each_place_it_refuses() {
        let wire = json!([
            "m",
            "nodes",
            ["s", node("a")],
            "edges",
            ["s", ["m", "id", "e", "from", ["m", "node", "a"], "to", ["m", "node", "b"]]]
        ]);
        assert_eq!(
            serde_json::from_str::<Json>(&written(&wire, true)).unwrap_or(Json::Null),
            json!([
                "schema",
                [[
                    ["edges", 0, "toNode"],
                    "custom",
                    "edge \"e\" references nonexistent toNode \"b\""
                ]]
            ])
        );
        assert!(written(&wire, false).starts_with('{'));
    }

    #[test]
    fn a_wire_that_is_no_canvas_or_is_past_the_cap_is_refused() {
        let refused = |wire: &str| {
            serde_json::from_str::<Json>(&json_canvas_serialize(wire, false)).unwrap_or(Json::Null)
        };
        assert_eq!(refused("not json"), json!(["refused", "malformed", "wire"]));
        assert_eq!(refused("{}"), json!(["refused", "malformed", "wire"]));
        assert_eq!(refused(r#"["m","nodes",["s"]]"#), json!(["refused", "malformed", "wire"]));
        let over = format!(
            "[\"m\",\"nodes\",[\"s\"],\"edges\",[\"s\"],\"tags\",[\"s\",\"{}\"]]",
            "a".repeat(JSON_CANVAS_SERIALIZE.max_bytes)
        );
        assert_eq!(refused(&over), json!(["refused", "input-too-large", "too-large"]));
        // One byte fewer than the cap is within it, and a wire of exactly the cap is
        // too: it is past the cap only when it is over.
        let wire = |pad: usize| {
            format!(
                "[\"m\",\"nodes\",[\"s\"],\"edges\",[\"s\"],\"tags\",[\"s\",\"{}\"]]",
                "a".repeat(pad)
            )
        };
        let frame = wire(0).len();
        let cap = JSON_CANVAS_SERIALIZE.max_bytes;
        for pad in [cap - frame - 1, cap - frame] {
            assert!(json_canvas_serialize(&wire(pad), false).starts_with('{'), "{pad}");
        }
        assert_eq!(
            refused(&wire(cap - frame + 1)),
            json!(["refused", "input-too-large", "too-large"])
        );
    }

    #[test]
    fn a_value_json_has_no_spelling_for_is_refused_with_its_class() {
        let big = json!([
            "m",
            "nodes",
            ["s", node("a")],
            "edges",
            ["s"],
            "facets",
            ["m", "a.b/v1", ["b", "9007199254740993"]]
        ]);
        let answer: Json = serde_json::from_str(&written(&big, false)).unwrap_or(Json::Null);
        assert_eq!(answer, json!(["refused", "malformed", "unwritable"]));
        let mut deep = json!(null);
        for _ in 0..130 {
            deep = json!(["s", deep]);
        }
        let facets = json!(["m", "nodes", ["s"], "edges", ["s"], "facets", ["m", "a.b/v1", deep]]);
        // Past serde_json's own recursion limit the wire is no wire.
        assert_eq!(
            serde_json::from_str::<Json>(&written(&facets, false)).unwrap_or(Json::Null),
            json!(["refused", "malformed", "wire"])
        );
        let _ = canvas(&[]);
    }
}
