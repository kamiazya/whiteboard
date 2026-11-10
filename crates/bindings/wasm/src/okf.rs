//! `parseOkf` and `serializeOkf` over the OKF document wire (ADR-0054 step 6).
//!
//! Both answer one JSON text whose first element names the outcome, so a
//! refusal and a result travel the same way and a host never reads a half.
//! The body of a document never crosses on the way out: a read answers the
//! UTF-16 offset the body starts at and the host slices its own string, a
//! write answers everything before the body and the host appends it, so the
//! body is verbatim by construction. The frontmatter crosses as the wire of
//! [`crate::okf_wire`].
//!
//! A host passes a read the head of its document, the fences and the
//! frontmatter between them, and keeps the body. A lone surrogate cannot
//! survive the crossing into a Rust `&str`, so the host puts a `mark` of its
//! choosing where it held one (a character the head holds nowhere else), and
//! the read refuses a frontmatter whose string or key holds the mark.

use crate::input_caps::{OKF_PARSE, OKF_SERIALIZE};
use crate::okf_wire::{frontmatter_from, frontmatter_value, json_value, value_json};
use serde_json::{Value as Json, json};
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_codec::frontmatter::{Fault, Refusal, Unwritable, Value};
use whiteboard_codec::okf::{Code, Detail, Failure, Step, parse_marked, serialize_in_order};

fn refused(code: &str) -> Json {
    json!(["refused", code])
}

/// A text past the entry's cap, or one the entry does not read, answers a
/// refusal and the shim answers from the TypeScript.
const TOO_LARGE: &str = "input-too-large";
const MALFORMED: &str = "malformed";

/// `parseOkf` of a document's head, with `mark` (a code point, or 0 for none)
/// standing where the host held a lone surrogate.
///
/// Out: `["ok", bodyOffset, frontmatter]` with the offset in UTF-16 units and
/// the frontmatter as the object `parseOkf` hands over; `["err", stage, class,
/// issues]` with `issues` a list of `[path, code, ...detail]` (empty unless
/// the class is `schema`), the detail being what Zod's message names: the type
/// expected and the one received for `invalid_type`, what was measured for
/// `too_small`, the refinement for `custom`, and nothing for `invalid_format`; or `["refused", code]` for a text past `maxBytes`.
#[wasm_bindgen]
#[must_use]
pub fn okf_parse(text: &str, mark: u32) -> String {
    parsed(text, mark).to_string()
}

fn parsed(text: &str, mark: u32) -> Json {
    if text.len() > OKF_PARSE.max_bytes {
        return refused(TOO_LARGE);
    }
    // A code point that is no character is no mark either.
    let mark = char::from_u32(mark).filter(|mark| *mark != '\0');
    match parse_marked(text, mark) {
        Ok(doc) => {
            let before = text.len().saturating_sub(doc.body.len());
            let offset = text.get(..before).map_or(0, whiteboard_det::utf16::len);
            json!(["ok", offset, value_json(&frontmatter_value(&doc.frontmatter))])
        }
        Err(why) => failure(&why),
    }
}

fn failure(why: &Failure) -> Json {
    let schema = |class: &str| json!(["err", "frontmatter-schema", class, []]);
    match why {
        Failure::Yaml(refusal) => {
            let class = match refusal {
                Refusal::Syntax(_) | Refusal::TooLarge => "syntax",
                Refusal::Anchor => "anchor",
                Refusal::Depth => "depth",
                Refusal::Subset(_) => "subset",
            };
            json!(["err", "yaml", class, []])
        }
        Failure::NoFence => schema("nofence"),
        Failure::ReservedKey => schema("reserved"),
        Failure::Schema(issues) => {
            let issues: Vec<Json> = issues
                .iter()
                .map(|issue| {
                    let path: Vec<Json> = issue.path.iter().map(step).collect();
                    let mut wire = vec![json!(path), json!(code(issue.code))];
                    wire.extend(detail(issue.detail));
                    Json::Array(wire)
                })
                .collect();
            json!(["err", "frontmatter-schema", "schema", issues])
        }
    }
}

/// What follows an issue's code on the wire: the words a message needs.
fn detail(detail: Detail) -> Vec<Json> {
    match detail {
        Detail::Nothing => vec![],
        Detail::Type { expected, received } => vec![json!(expected), json!(received)],
        Detail::Measured(what) | Detail::Rule(what) => vec![json!(what)],
    }
}

fn code(code: Code) -> &'static str {
    match code {
        Code::InvalidType => "invalid_type",
        Code::TooSmall => "too_small",
        Code::InvalidFormat => "invalid_format",
        Code::Custom => "custom",
    }
}

/// `serializeOkf` of a frontmatter, without its body.
///
/// In: the frontmatter as the object `parseOkf` hands over, in the wire of
/// [`crate::okf_wire`]. Out: `["ok", head]`, everything `serializeOkf` writes
/// before the body; `["unwritable", faults]` when a value has no YAML
/// spelling, each fault a `[path, reason]` in the order the TypeScript's
/// `yamlSafeValueSchema` reports them (a path step is a key or a list index);
/// or `["refused", code]` for a wire past `maxBytes` or one that is no
/// frontmatter the schema allows. Root keys are written in the wire's order.
#[wasm_bindgen]
#[must_use]
pub fn okf_serialize(frontmatter: &str) -> String {
    written(frontmatter).to_string()
}

fn written(wire: &str) -> Json {
    if wire.len() > OKF_SERIALIZE.max_bytes {
        return refused(TOO_LARGE);
    }
    // The schema is checked on the typed frontmatter, and the mapping itself
    // is written, so its root keys keep the order the host built them in.
    let Some(Value::Map(root)) = serde_json::from_str::<Json>(wire)
        .ok()
        .as_ref()
        .and_then(json_value)
        .filter(|value| frontmatter_from(value.clone()).is_some())
    else {
        return refused(MALFORMED);
    };
    match serialize_in_order(root, "") {
        Ok(head) => json!(["ok", head]),
        Err(faults) if faults.iter().any(|fault| fault.why == Unwritable::Overflow) => {
            refused(TOO_LARGE)
        }
        Err(faults) => json!(["unwritable", faults.iter().map(fault).collect::<Vec<_>>()]),
    }
}

fn fault(fault: &Fault) -> Json {
    let path: Vec<Json> = fault.path.iter().map(step).collect();
    json!([path, unwritable(fault.why)])
}

fn step(step: &Step) -> Json {
    match step {
        Step::Key(name) => json!(name),
        Step::Index(at) => json!(at),
    }
}

fn unwritable(why: Unwritable) -> &'static str {
    match why {
        Unwritable::Nan => "nan",
        Unwritable::Infinity => "infinity",
        Unwritable::NegativeInfinity => "negative-infinity",
        Unwritable::ByteOrderMark => "byte-order-mark",
        Unwritable::ReservedKey => "reserved-key",
        Unwritable::BigInt => "big-int",
        Unwritable::TooDeep => "too-deep",
        Unwritable::Overflow => "overflow",
    }
}

#[cfg(test)]
mod tests {
    use super::{okf_parse, okf_serialize};
    use crate::input_caps::{OKF_PARSE, OKF_SERIALIZE};
    use serde_json::{Value as Json, json};

    fn parsed(text: &str) -> Json {
        serde_json::from_str(&okf_parse(text, 0)).unwrap_or(Json::Null)
    }

    fn parsed_marked(text: &str, mark: u32) -> Json {
        serde_json::from_str(&okf_parse(text, mark)).unwrap_or(Json::Null)
    }

    fn written(wire: &Json) -> Json {
        serde_json::from_str(&okf_serialize(&wire.to_string())).unwrap_or(Json::Null)
    }

    #[test]
    fn a_write_keeps_the_root_keys_and_event_keys_in_the_wires_order() {
        let wire = json!([
            "m",
            "facets",
            ["m", "b", "1", "a", "2"],
            "tags",
            ["s", "x"],
            "type",
            "note",
            "title",
            "T",
            "generated",
            ["m", "at", "t", "by", "me"]
        ]);
        assert_eq!(
            written(&wire),
            json!([
                "ok",
                "---\ntags:\n  - x\ntype: note\ntitle: T\ngenerated:\n  at: t\n  by: me\nfacets:\n  a: \"2\"\n  b: \"1\"\n---\n"
            ])
        );
    }

    #[test]
    fn a_read_answers_the_offset_in_utf16_units_and_the_object() {
        // The body starts after "\u{1F600}" (two UTF-16 units, four bytes).
        let text = "---\ntype: \u{1F600}\n---\n\u{e9}body";
        assert_eq!(
            parsed(text),
            json!(["ok", 17, ["m", "type", "\u{1F600}"]]),
            "offset counts units, not bytes"
        );
        assert_eq!(parsed("---\ntype: a\n---"), json!(["ok", 15, ["m", "type", "a"]]));
    }

    #[test]
    fn a_refusal_names_the_stage_the_class_and_each_issue() {
        assert_eq!(parsed("no"), json!(["err", "frontmatter-schema", "nofence", []]));
        assert_eq!(parsed("---\n&a x\n---\n"), json!(["err", "yaml", "anchor", []]));
        assert_eq!(parsed("---\na: [\n---\n"), json!(["err", "yaml", "syntax", []]));
        assert_eq!(
            parsed("---\n{__proto__: 1}\n---\n"),
            json!(["err", "frontmatter-schema", "reserved", []])
        );
        assert_eq!(
            parsed("---\ntype: 1\ntags: [a, 2]\n---\n"),
            json!([
                "err",
                "frontmatter-schema",
                "schema",
                [
                    [["type"], "invalid_type", "string", "number"],
                    [["tags", 1], "invalid_type", "string", "number"]
                ]
            ])
        );
        let at = |what: &str| parsed(&format!("---\ntype: x\n{what}\n---\n"))[3].clone();
        assert_eq!(at("title: 1"), json!([[["title"], "invalid_type", "string", "number"]]));
        assert_eq!(
            at("generated: {by: '', at: x}"),
            json!([
                [["generated", "by"], "too_small", "string"],
                [["generated", "at"], "invalid_format"]
            ])
        );
        assert_eq!(
            at("generated: {by: ' a', at: '2025-01-01T00:00:00Z'}"),
            json!([[["generated", "by"], "custom", "actor"]])
        );
    }

    #[test]
    fn an_issue_carries_what_zods_message_names() {
        let at = |what: &str| parsed(&format!("---\ntype: x\n{what}\n---\n"))[3].clone();
        let type_issue = |what: &str, expected: &str, received: &str| {
            assert_eq!(
                at(what),
                json!([[[what.split(':').next().unwrap()], "invalid_type", expected, received]]),
                "{what}"
            );
        };
        type_issue("title: true", "string", "boolean");
        type_issue("title: ~", "string", "null");
        type_issue("title: [a]", "string", "array");
        type_issue("title: {a: b}", "string", "object");
        type_issue("title: .nan", "string", "NaN");
        type_issue("title: .inf", "string", "Infinity");
        type_issue("title: -.inf", "string", "-Infinity");
        type_issue("title: 99999999999999999999", "string", "bigint");
        type_issue("title: 1.5", "string", "number");
        type_issue("tags: a", "array", "string");
        type_issue("verified: 1", "array", "number");
        type_issue("facets: [a]", "record", "array");
        type_issue("generated: a", "object", "string");
        assert_eq!(
            at("generated: {}"),
            json!([
                [["generated", "by"], "invalid_type", "string", "undefined"],
                [["generated", "at"], "invalid_type", "string", "undefined"]
            ])
        );
        assert_eq!(
            at("generated: {by: [], at: x}")[1],
            json!([["generated", "by"], "too_small", "array"])
        );
        assert_eq!(
            at("title: x\ngenerated: {by: {length: 0}, at: 1}")[1],
            json!([["generated", "by"], "too_small", "unknown"])
        );
        assert_eq!(at("facets: {Bad: 1}"), json!([[["facets", "Bad"], "custom", "facet-key"]]));
        assert_eq!(parsed("---\n[a]\n---\n")[3], json!([[[], "invalid_type", "object", "array"]]));
        assert_eq!(parsed("---\ntype: ''\n---\n")[3], json!([[["type"], "too_small", "string"]]));
    }

    #[test]
    fn a_text_past_the_cap_is_refused_and_one_at_it_is_read() {
        let head = "---\ntype: x\n---\n";
        let at_cap = format!("{head}{}", "a".repeat(OKF_PARSE.max_bytes - head.len()));
        assert_eq!(parsed(&at_cap)[0], json!("ok"));
        assert_eq!(parsed(&format!("{at_cap}a")), json!(["refused", "input-too-large"]));
    }

    #[test]
    fn a_write_answers_the_text_before_the_body() {
        let wire = json!([
            "m",
            "type",
            "note",
            "facets",
            ["m", "a.b/v1", ["s", ["f", "3ff8000000000000"]]]
        ]);
        assert_eq!(
            written(&wire),
            json!(["ok", "---\ntype: note\nfacets:\n  a.b/v1:\n    - 1.5\n---\n"])
        );
    }

    #[test]
    fn a_write_names_each_place_a_value_has_no_spelling() {
        let at = |value: Json| {
            written(&json!(["m", "type", "x", "facets", ["m", "a.b/v1", ["s", value]]]))
        };
        let place = json!(["facets", "a.b/v1", 0]);
        for (wire, reason) in [
            (json!(["f", "7ff8000000000000"]), "nan"),
            (json!(["f", "7ff0000000000000"]), "infinity"),
            (json!(["f", "fff0000000000000"]), "negative-infinity"),
            (json!(["b", "9007199254740993"]), "big-int"),
            (json!("\u{feff}"), "byte-order-mark"),
        ] {
            assert_eq!(at(wire), json!(["unwritable", [[place, reason]]]), "{reason}");
        }
        // A reserved key is reported at the root, first, and a key with a byte
        // order mark at the mapping that holds it, preserved keys being spread at
        // the root.
        let faults = written(&json!([
            "m",
            "type",
            "x",
            "facetsRaw",
            ["m", "k\u{feff}", ["f", "7ff8000000000000"], "__proto__", null]
        ]));
        assert_eq!(
            faults,
            json!([
                "unwritable",
                [[[], "reserved-key"], [[], "byte-order-mark"], [["k\u{feff}"], "nan"]]
            ])
        );
        let mut deep = json!(null);
        for _ in 0..70 {
            deep = json!(["s", deep]);
        }
        assert_eq!(at(deep)[1][0][1], json!("too-deep"));
    }

    #[test]
    fn faults_that_would_not_fit_the_budget_are_a_refusal_not_an_answer() {
        // 60 mappings nested on 1000-byte keys, a list of NaN at the bottom: every
        // fault repeats the whole path, and the answer would be megabytes.
        let mut value = json!(["s"]);
        for _ in 0..5000 {
            value.as_array_mut().expect("a list").push(json!(["f", "7ff8000000000000"]));
        }
        for at in 0..60 {
            value = json!(["m", format!("{at:0>1000}"), value]);
        }
        let wire = json!(["m", "type", "x", "facets", ["m", "a.b/v1", value]]);
        // Within the wire's own cap, so the refusal is the fault budget's.
        assert!(wire.to_string().len() < OKF_SERIALIZE.max_bytes);
        assert_eq!(written(&wire), json!(["refused", "input-too-large"]));
    }

    #[test]
    fn a_mark_that_reaches_the_frontmatter_is_a_yaml_refusal_and_one_that_does_not_is_nothing() {
        let mark = 0xE000;
        assert_eq!(
            parsed_marked("---\ntype: a\u{e000}\n---\n", mark),
            json!(["err", "yaml", "subset", []])
        );
        assert_eq!(
            parsed_marked("---\ntype: a # \u{e000}\n---\n", mark),
            json!(["ok", 20, ["m", "type", "a"]])
        );
        // No mark: the same character is text. A zero or a surrogate value names none.
        assert_eq!(parsed("---\ntype: a\u{e000}\n---\n")[0], json!("ok"));
        assert_eq!(parsed_marked("---\ntype: a\u{e000}\n---\n", 0xD800)[0], json!("ok"));
    }

    #[test]
    fn a_frontmatter_of_numbers_the_reader_takes_is_within_the_writes_cap() {
        // A number is the densest value in the wire against its YAML: 24 bytes
        // against `  - 0` and a line break. A list of zeros whose YAML fills the
        // reader's cap is what the write's cap is sized for.
        let zero = json!(["f", format!("{:016x}", 0f64.to_bits())]);
        let count = OKF_PARSE.max_bytes / 6 - 8;
        let zeros: Json =
            std::iter::once(json!("s")).chain(std::iter::repeat_n(zero, count)).collect();
        let wire = json!(["m", "type", "x", "facetsRaw", ["m", "a", zeros]]);
        assert!(wire.to_string().len() <= OKF_SERIALIZE.max_bytes);
        let answer = written(&wire);
        assert_eq!(answer[0], json!("ok"));
        let head = answer[1].as_str().unwrap_or_default();
        assert!(head.len() <= OKF_PARSE.max_bytes, "{}", head.len());
        assert!(head.len() > OKF_PARSE.max_bytes - 64, "{}", head.len());
    }

    #[test]
    fn a_wire_that_is_no_frontmatter_or_is_past_the_cap_is_refused() {
        let refused =
            |wire: &str| serde_json::from_str::<Json>(&okf_serialize(wire)).unwrap_or(Json::Null);
        assert_eq!(refused("not json"), json!(["refused", "malformed"]));
        assert_eq!(refused("{}"), json!(["refused", "malformed"]));
        assert_eq!(refused(r#"["m","title","x"]"#), json!(["refused", "malformed"]));
        let pad = "a".repeat(OKF_SERIALIZE.max_bytes);
        let over = json!(["m", "type", pad]).to_string();
        assert_eq!(refused(&over), json!(["refused", "input-too-large"]));
        let fits = json!(["m", "type", pad[..OKF_SERIALIZE.max_bytes - 15]]).to_string();
        assert_eq!(fits.len(), OKF_SERIALIZE.max_bytes);
        assert_eq!(refused(&fits)[0], json!("ok"));
    }
}
