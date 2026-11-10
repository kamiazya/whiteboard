//! Booleans, integers, an empty-list default and a constant: what each
//! becomes in both languages, and every rule that refuses one.

use super::plain::{IN_MODEL, plain};
use super::shapes::{emitted, refused, swapped};
use super::*;

const HOLDER: &str = r#""Holder": {
      "description": "A holder.",
      "type": "object",
      "properties": {
        "flag": { "type": "boolean", "description": "A flag." },
        "count": { "type": "integer", "description": "A count." },
        "items": { "type": "array", "items": { "type": "string" }, "default": [], "description": "Items." }
      },
      "required": ["flag", "count"],
      "x-wb-order": ["flag", "count", "items"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }"#;

#[test]
fn a_boolean_and_an_integer_reach_both_languages() {
    let (zod, rust) = emitted(HOLDER);
    assert!(zod.contains("\n  flag: z.boolean(),\n"), "{zod}");
    assert!(
        zod.contains(
            "\n  count: z.number().int().meta({ minimum: undefined, maximum: undefined }),\n"
        ),
        "{zod}"
    );
    assert!(rust.contains("    pub flag: bool,\n"), "{rust}");
    assert!(rust.contains("    pub count: i64,\n"), "{rust}");
}

#[test]
fn a_list_that_defaults_to_empty_is_a_default_in_zod_and_not_an_option_in_rust() {
    let (zod, rust) = emitted(HOLDER);
    assert!(zod.contains("\n  items: z.array(z.string()).default([]),\n"), "{zod}");
    assert!(!zod.contains(".optional()"), "{zod}");
    assert!(rust.contains("    pub items: Vec<String>,\n"), "{rust}");
    assert!(!rust.contains("Option<"), "{rust}");
}

#[test]
fn a_list_without_a_default_that_is_not_required_stays_optional() {
    let (zod, rust) = emitted(&swapped(HOLDER, r#""default": [], "#, ""));
    assert!(zod.contains("\n  items: z.array(z.string()).optional(),\n"), "{zod}");
    assert!(rust.contains("    pub items: Option<Vec<String>>,\n"), "{rust}");
}

#[test]
fn a_scalar_rule_the_dialect_states_is_refused_by_name() {
    for (from, to, expect) in [
        (
            r#""type": "boolean""#,
            r#""type": "boolean", "minimum": 0"#,
            "does not apply to a boolean",
        ),
        (
            r#""type": "integer""#,
            r#""type": "integer", "minimum": 0"#,
            "does not apply to an integer",
        ),
        (
            r#""type": "integer""#,
            r#""type": "integer", "pattern": "^a$""#,
            "does not apply to an integer",
        ),
        (
            r#""required": ["flag", "count"]"#,
            r#""required": ["flag", "count", "items"]"#,
            "a defaulted property is not required",
        ),
        (
            r#""type": "boolean""#,
            r#""type": "boolean", "default": []"#,
            "`default` does not apply to a boolean",
        ),
        (
            r#""type": "integer""#,
            r#""type": "integer", "default": []"#,
            "`default` does not apply to an integer",
        ),
    ] {
        refused(&swapped(HOLDER, from, to), expect);
    }
}

#[test]
fn a_default_belongs_on_a_property_and_holds_only_an_empty_list() {
    let top = r#""List": { "description": "A list.", "type": "array", "items": { "type": "string" }, "default": [] }"#;
    refused(top, "a default belongs on a property");
    let non_empty = swapped(HOLDER, r#""default": []"#, r#""default": ["a"]"#);
    let contract = plain(&non_empty, IN_MODEL, false);
    assert!(dialect::parse(&contract).is_err(), "a non-empty default was accepted");
}

const KINDED: &str = r#""Kinded": {
      "description": "A kinded value.",
      "type": "object",
      "properties": {
        "kind": { "type": "string", "const": "node", "description": "Always node." },
        "id": { "type": "string", "description": "An id." }
      },
      "required": ["kind", "id"],
      "x-wb-order": ["kind", "id"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }"#;

#[test]
fn a_constant_is_a_zod_literal_and_a_rust_constant_that_is_not_a_field() {
    let (zod, rust) = emitted(KINDED);
    assert!(zod.contains("\n  kind: z.literal('node'),\n  id: z.string(),\n"), "{zod}");
    assert!(!rust.contains("pub kind"), "{rust}");
    assert!(rust.contains("pub struct Kinded {\n    /// An id.\n    pub id: String,\n}"), "{rust}");
    assert!(rust.contains("impl Kinded {"), "{rust}");
    assert!(rust.contains("/// What `kind` is always written as."), "{rust}");
    assert!(rust.contains("pub const KIND: &str = \"node\";"), "{rust}");
}

#[test]
fn a_constant_rule_the_dialect_states_is_refused_by_name() {
    for (from, to, expect) in [
        (r#""const": "node""#, r#""const": "Node""#, "`Node` is not lowercase letters and digits"),
        (r#""const": "node""#, r#""const": """#, "`` is not lowercase letters and digits"),
        (
            r#""const": "node""#,
            r#""const": "node", "pattern": "^a$""#,
            "`pattern` does not apply to a constant",
        ),
        (
            r#""required": ["kind", "id"]"#,
            r#""required": ["id"]"#,
            "a constant property is required",
        ),
    ] {
        refused(&swapped(KINDED, from, to), expect);
    }
    let top = r#""Tag": { "description": "A tag.", "type": "string", "const": "node" }"#;
    refused(top, "a constant belongs on a property");
}
