//! What an asset contract (a theme, an icon, a stencil) needed beyond the
//! rest: a strict lower bound, a constant that is a definition, a default
//! object and keys that are numbers.

use super::plain::{IN_MODEL, plain};
use super::shapes::{emitted, refused, swapped};
use super::*;

const WIDTH: &str = r#""Width": {
      "description": "A width.",
      "type": "object",
      "properties": {
        "px": { "type": "number", "exclusiveMinimum": 0, "description": "Pixels." },
        "half": { "type": "number", "exclusiveMinimum": 1.5, "description": "Half." },
        "floor": { "type": "number", "minimum": 2, "description": "Floor." },
        "any": { "type": "number", "description": "Any." }
      },
      "required": ["px", "half", "floor", "any"],
      "x-wb-order": ["px", "half", "floor", "any"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }"#;

#[test]
fn a_number_is_held_strictly_above_a_bound_or_at_it_and_each_reads_as_f64() {
    let (zod, rust) = emitted(WIDTH);
    assert!(zod.contains("\n  px: z.number().gt(0),\n"), "{zod}");
    assert!(zod.contains("\n  half: z.number().gt(1.5),\n"), "{zod}");
    assert!(zod.contains("\n  floor: z.number().min(2),\n"), "{zod}");
    assert!(zod.contains("\n  any: z.number(),\n"), "{zod}");
    for field in ["px", "half", "floor", "any"] {
        assert!(rust.contains(&format!("    pub {field}: f64,\n")), "{rust}");
    }
}

#[test]
fn a_number_bound_rule_the_dialect_states_is_refused_by_name() {
    for (from, to, expect) in [
        (
            r#""exclusiveMinimum": 0,"#,
            r#""exclusiveMinimum": 0, "minimum": 0,"#,
            "a `minimum` or an `exclusiveMinimum`, not both",
        ),
        (r#""exclusiveMinimum": 0,"#, r#""exclusiveMinimum": 0, "maximum": 4,"#, ""),
    ] {
        if expect.is_empty() {
            let text = plain(&swapped(WIDTH, from, to), IN_MODEL, false);
            assert!(dialect::parse(&text).is_err(), "an unknown bound was accepted");
        } else {
            refused(&swapped(WIDTH, from, to), expect);
        }
    }
    let not_a_number = swapped(WIDTH, r#""exclusiveMinimum": 0,"#, r#""exclusiveMinimum": null,"#);
    assert!(dialect::parse(&plain(&not_a_number, IN_MODEL, false)).is_err());
    let on_string = r#""Text": { "description": "T.", "type": "string", "exclusiveMinimum": 0 }"#;
    refused(on_string, "`exclusiveMinimum` does not apply to a string");
}

#[test]
fn a_strict_bound_is_refused_where_rust_checks_the_number_itself() {
    let text = mutated(r#""minimum": 0,"#, r#""exclusiveMinimum": 0,"#);
    let errors = outputs(&text).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("x-wb-rustSerde emits closed objects")), "{errors:?}");
}

const NO_FILL: &str = r##""NoFill": { "description": "No fill.", "type": "string", "const": "none" },
    "Hex": { "description": "A hex.", "type": "string", "x-wb-minUtf16": 7 },
    "Fill": { "description": "A fill.", "anyOf": [{ "$ref": "#/$defs/Hex" }, { "$ref": "#/$defs/NoFill" }] }"##;

#[test]
fn a_constant_definition_is_a_literal_in_zod_and_a_string_a_union_may_hold_in_rust() {
    let (zod, rust) = emitted(NO_FILL);
    assert!(zod.contains("export const noFillSchema = z.literal('none')\n"), "{zod}");
    assert!(zod.contains("export type NoFill = z.infer<typeof noFillSchema>"), "{zod}");
    assert!(
        zod.contains("export const fillSchema = z.union([hexSchema, noFillSchema])\n"),
        "{zod}"
    );
    assert!(rust.contains("/// No fill.\npub type NoFill = String;\n"), "{rust}");
    assert!(rust.contains("pub enum Fill {\n    /// A `Hex`.\n    Hex(Hex),\n"), "{rust}");
    assert!(rust.contains("    /// A `NoFill`.\n    NoFill(NoFill),\n"), "{rust}");
}

#[test]
fn a_constant_definition_is_held_to_the_spelling_a_property_constant_is() {
    for (from, to, expect) in [
        (r#""const": "none""#, r#""const": "None""#, "`None` is not lowercase letters and digits"),
        (
            r#""const": "none""#,
            r#""const": "none", "pattern": "^a$""#,
            "does not apply to a constant",
        ),
    ] {
        refused(&swapped(NO_FILL, from, to), expect);
    }
}

const INNER: &str = r#""Inner": {
      "description": "An inner object.",
      "type": "object",
      "properties": {
        "a": { "type": "string", "description": "A." },
        "b": { "type": "boolean", "description": "B." }
      },
      "required": [],
      "x-wb-order": ["a", "b"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }"#;

const OUTER: &str = r##""Outer": {
      "description": "An outer object.",
      "type": "object",
      "properties": {
        "inner": { "$ref": "#/$defs/Inner", "default": {}, "description": "The inner." }
      },
      "required": [],
      "x-wb-order": ["inner"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }"##;

fn with_inner(inner: &str) -> String {
    format!("{OUTER}, {inner}")
}

#[test]
fn a_reference_that_defaults_to_an_empty_object_is_a_default_in_zod_and_no_option_in_rust() {
    let (zod, rust) = emitted(&with_inner(INNER));
    assert!(zod.contains("\n  inner: innerSchema.default({}),\n"), "{zod}");
    assert!(rust.contains("    /// The inner.\n    pub inner: Inner,\n"), "{rust}");
    assert!(!rust.contains("Option<Inner>"), "{rust}");
}

#[test]
fn a_reference_without_a_default_that_is_not_required_stays_optional() {
    let defs = swapped(&with_inner(INNER), r#""default": {}, "#, "");
    let (zod, rust) = emitted(&defs);
    assert!(zod.contains("\n  inner: innerSchema.optional(),\n"), "{zod}");
    assert!(rust.contains("    pub inner: Option<Inner>,\n"), "{rust}");
}

#[test]
fn a_default_on_a_reference_is_refused_unless_the_object_it_names_accepts_nothing_at_all() {
    let one_required = swapped(INNER, r#""required": []"#, r#""required": ["b"]"#);
    let checked = swapped(
        INNER,
        r#""x-wb-unknownKeys": "strip""#,
        r#""x-wb-unknownKeys": "strip", "x-wb-check": "inner_ok""#,
    );
    let name = r#""Name": { "description": "A name.", "type": "string" }"#;
    let extended = r#"
      "Derived": {
        "description": "Derived.", "type": "object", "x-wb-extends": "Inner",
        "properties": { "c": { "type": "string", "description": "C." } },
        "required": [], "x-wb-order": ["c"],
        "additionalProperties": false, "x-wb-unknownKeys": "refuse"
      }"#;
    let defaulted = swapped(
        INNER,
        r#""b": { "type": "boolean", "description": "B." }"#,
        r#""b": { "type": "array", "items": { "type": "string" }, "default": [], "description": "B." }"#,
    );
    let derived = with_inner(&format!("{INNER}, {extended}"))
        .replace(r##""$ref": "#/$defs/Inner""##, r##""$ref": "#/$defs/Derived""##);
    for (defs, target) in [
        (with_inner(&one_required), "Inner"),
        (with_inner(&checked), "Inner"),
        (with_inner(&defaulted), "Inner"),
        (with_inner(name).replace("Name\"", "Inner\""), "Inner"),
        (derived, "Derived"),
    ] {
        let expect = format!(
            "names an object whose properties are all optional and none defaulted; `{target}`"
        );
        let errors = outputs(&plain(&defs, IN_MODEL, true)).unwrap_err();
        assert!(errors.iter().any(|e| e.contains(&expect)), "{expect}: {errors:?}");
    }
}

#[test]
fn a_reference_default_is_an_empty_object_and_belongs_on_a_property() {
    let list = swapped(&with_inner(INNER), r#""default": {}"#, r#""default": []"#);
    refused(&list, "a `$ref`'s default is `{}`");
    let required = swapped(&with_inner(INNER), r#""required": []"#, r#""required": ["inner"]"#);
    refused(&required, "a defaulted property is not required");
    let top =
        r##""Alias": { "description": "An alias.", "$ref": "#/$defs/Inner", "default": {} }"##;
    refused(&format!("{top}, {INNER}"), "a default belongs on a property");
}

const NUMBERED: &str = r#""Numbered": {
      "description": "Numbered keys then named ones.",
      "type": "object",
      "properties": {
        "1": { "type": "string", "description": "One." },
        "10": { "type": "string", "description": "Ten." },
        "9": { "type": "string", "description": "Nine." },
        "0": { "type": "string", "description": "Zero." },
        "name": { "type": "string", "description": "A name." }
      },
      "required": ["1", "10", "9", "0", "name"],
      "x-wb-order": ["0", "1", "9", "10", "name"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }"#;

fn numbered_order(order: &str) -> String {
    swapped(NUMBERED, r#"["0", "1", "9", "10", "name"]"#, order)
}

#[test]
fn a_numeric_key_is_a_zod_key_and_a_rust_field_named_n_and_its_digits() {
    let (zod, rust) = emitted(NUMBERED);
    assert!(
        zod.contains("\n  '0': z.string(),\n  '1': z.string(),\n  '9': z.string(),\n  '10': z.string(),\n  name: z.string(),\n"),
        "{zod}"
    );
    for field in ["n0", "n1", "n9", "n10", "name"] {
        assert!(rust.contains(&format!("    pub {field}: String,\n")), "{rust}");
    }
}

#[test]
fn a_numeric_key_comes_first_and_ascending_as_javascript_enumerates_it() {
    for order in [
        r#"["1", "0", "9", "10", "name"]"#,
        r#"["0", "1", "10", "9", "name"]"#,
        r#"["0", "1", "9", "name", "10"]"#,
        r#"["name", "0", "1", "9", "10"]"#,
    ] {
        refused(&numbered_order(order), "a numeric key comes before every other, in ascending");
    }
    // Past what a machine integer holds, a key is still ordered as a number.
    let wide = NUMBERED.replace(r#""10""#, r#""99999999999999999999999""#);
    assert!(outputs(&plain(&wide, IN_MODEL, false)).is_ok());
}

#[test]
fn a_numeric_key_is_a_canonical_index_and_nothing_else() {
    for key in ["01", "00", "1a", "-1", "1.5"] {
        let defs = swapped(NUMBERED, r#""10": {"#, &format!(r#""{key}": {{"#))
            .replace(r#""10""#, &format!(r#""{key}""#));
        refused(&defs, &format!("$defs.Numbered.{key}: not a lowercase identifier"));
    }
    let empty = swapped(NUMBERED, r#""10": {"#, r#""": {"#).replace(r#""10""#, r#""""#);
    refused(&empty, "$defs.Numbered.: not a lowercase identifier");
}

#[test]
fn a_numeric_key_and_a_word_may_not_name_the_same_rust_field() {
    let defs = swapped(NUMBERED, r#""name": {"#, r#""n1": {"#).replace(r#""name""#, r#""n1""#);
    refused(&defs, "n1 and an earlier property both name `n1` in Rust");
}

#[test]
fn an_order_that_repeats_a_numeric_key_is_refused_for_it_too() {
    let repeated = numbered_order(r#"["0", "1", "1", "9", "10", "name"]"#);
    refused(&repeated, "must list every property exactly once");
    refused(&repeated, "a numeric key comes before every other, in ascending");
}
