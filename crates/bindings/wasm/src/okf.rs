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
//! A host must hold the text it passes to be well-formed UTF-16: a lone
//! surrogate cannot survive the crossing into a Rust `&str`, so the shim
//! refuses one before calling.

use crate::input_caps::{OKF_PARSE, OKF_SERIALIZE};
use crate::okf_wire::{frontmatter_from, frontmatter_value, json_value, value_json};
use serde_json::{Value as Json, json};
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_codec::frontmatter::{Refusal, Unwritable};
use whiteboard_codec::okf::{Code, Document, Failure, Step, parse, serialize};

fn refused(code: &str) -> Json {
    json!(["refused", code])
}

/// A text past the entry's cap, or one the entry does not read, answers a
/// refusal and the shim answers from the TypeScript.
const TOO_LARGE: &str = "input-too-large";
const MALFORMED: &str = "malformed";

/// `parseOkf` of a whole document.
///
/// Out: `["ok", bodyOffset, frontmatter]` with the offset in UTF-16 units and
/// the frontmatter as the object `parseOkf` hands over; `["err", stage, class,
/// issues]` with `issues` a list of `[path, code]` (empty unless the class is
/// `schema`); or `["refused", code]` for a text past `maxBytes`.
#[wasm_bindgen]
#[must_use]
pub fn okf_parse(text: &str) -> String {
    parsed(text).to_string()
}

fn parsed(text: &str) -> Json {
    if text.len() > OKF_PARSE.max_bytes {
        return refused(TOO_LARGE);
    }
    match parse(text) {
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
                    let path: Vec<Json> = issue
                        .path
                        .iter()
                        .map(|step| match step {
                            Step::Key(name) => json!(name),
                            Step::Index(at) => json!(at),
                        })
                        .collect();
                    json!([path, code(issue.code)])
                })
                .collect();
            json!(["err", "frontmatter-schema", "schema", issues])
        }
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
/// before the body; `["unwritable", reason]` when a value has no YAML
/// spelling; or `["refused", code]` for a wire past `maxBytes` or one that is
/// no frontmatter in the order the schema writes it.
#[wasm_bindgen]
#[must_use]
pub fn okf_serialize(frontmatter: &str) -> String {
    written(frontmatter).to_string()
}

fn written(wire: &str) -> Json {
    if wire.len() > OKF_SERIALIZE.max_bytes {
        return refused(TOO_LARGE);
    }
    let Some(frontmatter) = serde_json::from_str::<Json>(wire)
        .ok()
        .as_ref()
        .and_then(json_value)
        .and_then(frontmatter_from)
    else {
        return refused(MALFORMED);
    };
    match serialize(&Document { frontmatter, body: String::new() }) {
        Ok(head) => json!(["ok", head]),
        Err(why) => json!(["unwritable", unwritable(why)]),
    }
}

fn unwritable(why: Unwritable) -> &'static str {
    match why {
        Unwritable::NonFiniteNumber => "non-finite-number",
        Unwritable::ByteOrderMark => "byte-order-mark",
        Unwritable::ReservedKey => "reserved-key",
        Unwritable::BigInt => "big-int",
        Unwritable::TooDeep => "too-deep",
    }
}

#[cfg(test)]
mod tests {
    use super::{okf_parse, okf_serialize};
    use crate::input_caps::{OKF_PARSE, OKF_SERIALIZE};
    use serde_json::{Value as Json, json};

    fn parsed(text: &str) -> Json {
        serde_json::from_str(&okf_parse(text)).unwrap_or(Json::Null)
    }

    fn written(wire: &Json) -> Json {
        serde_json::from_str(&okf_serialize(&wire.to_string())).unwrap_or(Json::Null)
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
                [[["type"], "invalid_type"], [["tags", 1], "invalid_type"]]
            ])
        );
        let at = |what: &str| parsed(&format!("---\ntype: x\n{what}\n---\n"))[3].clone();
        assert_eq!(at("title: 1"), json!([[["title"], "invalid_type"]]));
        assert_eq!(
            at("generated: {by: '', at: x}"),
            json!([[["generated", "by"], "too_small"], [["generated", "at"], "invalid_format"]])
        );
        assert_eq!(
            at("generated: {by: ' a', at: '2025-01-01T00:00:00Z'}"),
            json!([[["generated", "by"], "custom"]])
        );
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
    fn a_write_names_why_a_value_has_no_spelling() {
        let with =
            |value: Json| written(&json!(["m", "type", "x", "facets", ["m", "a.b/v1", value]]));
        assert_eq!(
            with(json!(["f", "7ff8000000000000"])),
            json!(["unwritable", "non-finite-number"])
        );
        assert_eq!(with(json!(["b", "9007199254740993"])), json!(["unwritable", "big-int"]));
        assert_eq!(with(json!("\u{feff}")), json!(["unwritable", "byte-order-mark"]));
        assert_eq!(with(json!(["m", "__proto__", null])), json!(["unwritable", "reserved-key"]));
        let mut deep = json!(null);
        for _ in 0..70 {
            deep = json!(["s", deep]);
        }
        assert_eq!(with(deep), json!(["unwritable", "too-deep"]));
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
