//! Contracts emitting plain Rust: what they list, import and refuse.

use super::*;

/// A plain-Rust contract holding `defs`, its Rust half emitted at `rust`.
pub(super) fn plain(defs: &str, rust: &str, checks: bool) -> String {
    let checks = if checks {
        r#""x-wb-checks": { "zod": "packages/p/src/contract-checks.ts", "rust": "crates/core/model/src/checks.rs" },"#
    } else {
        ""
    };
    format!(
        r#"{{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "P",
  "description": "D.",
  "x-wb-emit": {{ "zod": "packages/p/src/generated/p.zod.ts", "rust": "{rust}" }},
  {checks}
  "x-wb-describe": false,
  "x-wb-rustSerde": false,
  "x-wb-readonlyTypes": false,
  "$defs": {{ {defs} }}
}}"#
    )
}

pub(super) const IN_MODEL: &str = "crates/core/model/src/generated/p.rs";
const ELSEWHERE: &str = "crates/core/c/src/generated/p.rs";

#[test]
fn a_check_nested_in_an_array_inside_an_object_is_listed() {
    let defs = r#""Doc": {
      "description": "A document.",
      "type": "object",
      "properties": {
        "tags": { "type": "array", "items": { "type": "string", "x-wb-check": "tag_label" }, "description": "Labels." }
      },
      "required": [],
      "x-wb-order": ["tags"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }"#;
    let contract = dialect::parse(&plain(defs, IN_MODEL, true)).unwrap();
    let checked = dialect::check(&contract).unwrap();
    assert_eq!(checked.zod_checks, ["tag_label"]);
    assert_eq!(checked.rust_names, ["tag_label"]);
}

#[test]
fn a_matcher_alone_still_needs_the_modules_that_hold_it() {
    let defs = r#""Stamp": {
      "description": "A stamp.",
      "type": "string",
      "pattern": "^\\d{4}$",
      "x-wb-matcher": "stamp",
      "x-wb-message": "a stamp is a year"
    }"#;
    let errors = outputs(&plain(defs, IN_MODEL, false)).unwrap_err();
    assert!(
        errors.iter().any(|e| e.contains("x-wb-checks: a named check or matcher")),
        "{errors:?}"
    );
    assert!(outputs(&plain(defs, IN_MODEL, true)).is_ok());
}

#[test]
fn only_the_model_crate_imports_what_each_plain_type_reaches_for() {
    let record = r#""Bag": { "description": "A bag.", "type": "object", "additionalProperties": { "x-wb-any": true } }"#;
    let list =
        r#""List": { "description": "A list.", "type": "array", "items": { "x-wb-any": true } }"#;
    let kept = r#""Kept": {
      "description": "Kept keys.",
      "type": "object",
      "properties": { "name": { "type": "string", "description": "A name." } },
      "required": ["name"],
      "x-wb-order": ["name"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "keep"
    }"#;
    for (defs, map, value) in [(record, true, false), (list, false, true), (kept, true, false)] {
        let errors = outputs(&plain(defs, ELSEWHERE, false)).unwrap_err();
        assert!(errors.iter().any(|e| e.contains("must emit there")), "{defs}: {errors:?}");
        let rust = outputs(&plain(defs, IN_MODEL, false)).unwrap().remove(1).1;
        assert_eq!(rust.contains("use crate::Map;"), map, "{defs}: {rust}");
        assert_eq!(rust.contains("use crate::Value;"), value, "{defs}: {rust}");
    }
}

#[test]
fn a_record_is_any_value_and_nothing_else() {
    let record = |values: &str| {
        format!(
            r#""Bag": {{ "description": "A bag.", "type": "object", "additionalProperties": {values} }}"#
        )
    };
    assert!(outputs(&plain(&record(r#"{ "x-wb-any": true }"#), IN_MODEL, false)).is_ok());
    for values in [
        r#"{ "x-wb-any": true, "type": "string" }"#,
        r#"{ "x-wb-any": false }"#,
        r#"{ "x-wb-any": true, "x-wb-minUtf16": 1 }"#,
        r#"{ "type": "string" }"#,
    ] {
        let errors = outputs(&plain(&record(values), IN_MODEL, false)).unwrap_err();
        assert!(
            errors.iter().any(|e| e.contains("a record is `additionalProperties")),
            "{values}: {errors:?}"
        );
    }
}

#[test]
fn a_ref_cycle_names_only_the_definitions_caught_in_it() {
    let object = |name: &str, target: &str| {
        format!(
            r##""{name}": {{
      "description": "A node.",
      "type": "object",
      "properties": {{ "next": {{ "$ref": "#/$defs/{target}", "description": "Next." }} }},
      "required": [],
      "x-wb-order": ["next"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }}"##
        )
    };
    let leaf = r#""Leaf": { "description": "A leaf.", "type": "string" }"#;
    let defs =
        [leaf.to_owned(), object("Ring", "Loop"), object("Loop", "Ring"), object("Twig", "Leaf")]
            .join(",\n    ");
    let errors = outputs(&plain(&defs, IN_MODEL, false)).unwrap_err();
    assert!(
        errors.iter().any(|e| e.ends_with("$defs: a `$ref` cycle among Loop, Ring")),
        "{errors:?}"
    );
}

#[test]
fn a_pattern_whose_closing_anchor_is_escaped_is_refused() {
    let stamp = |pattern: &str| {
        plain(
            &format!(
                r#""Stamp": {{ "description": "A stamp.", "type": "string", "pattern": "{pattern}", "x-wb-matcher": "stamp", "x-wb-message": "m" }}"#
            ),
            IN_MODEL,
            true,
        )
    };
    let refused = |pattern: &str| {
        outputs(&stamp(pattern))
            .err()
            .is_some_and(|errors| errors.iter().any(|e| e.contains("the final `$` is escaped")))
    };
    assert!(refused(r"^a\\$"));
    assert!(refused(r"^a\\\\\\$"));
    assert!(!refused(r"^a\\\\$"));
    assert!(outputs(&stamp(r"^a\\\\$")).is_ok());
}
