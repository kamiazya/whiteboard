//! The enum, union, array-bound and registration constructs: what each
//! becomes in both languages, and every rule that refuses one.

use super::plain::{IN_MODEL, plain};
use super::*;

const SIDE: &str = r#""Side": {
      "description": "A side.",
      "type": "string",
      "enum": ["top", "right", "1"]
    }"#;

const POINT: &str = r#""Point": {
      "description": "A point.",
      "type": "object",
      "properties": { "x": { "type": "number", "description": "Along x." } },
      "required": ["x"],
      "x-wb-order": ["x"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }"#;

fn emitted(defs: &str) -> (String, String) {
    let mut files = outputs(&plain(defs, IN_MODEL, false)).unwrap();
    let rust = files.remove(1).1;
    (files.remove(0).1, rust)
}

fn refused(defs: &str, expect: &str) {
    let errors = outputs(&plain(defs, IN_MODEL, false)).unwrap_err();
    assert!(errors.iter().any(|e| e.contains(expect)), "{expect}: {errors:?}");
}

/// `defs` with `from` replaced by `to`, asserting the replacement hit.
fn swapped(defs: &str, from: &str, to: &str) -> String {
    let text = defs.replacen(from, to, 1);
    assert_ne!(text, defs, "{from} did not match");
    text
}

#[test]
fn an_enum_is_a_zod_enum_and_a_rust_enum_that_names_its_wire_values() {
    let (zod, rust) = emitted(SIDE);
    assert!(zod.contains("export const sideSchema = z.enum(['top', 'right', '1'])"), "{zod}");
    assert!(zod.contains("export type Side = z.infer<typeof sideSchema>"), "{zod}");
    assert!(rust.contains("pub enum Side {"), "{rust}");
    for variant in ["Top", "Right", "V1"] {
        assert!(rust.contains(&format!("    {variant},")), "{variant}: {rust}");
    }
    assert!(rust.contains("Self::Right => \"right\","), "{rust}");
    assert!(rust.contains("\"right\" => Some(Self::Right),"), "{rust}");
    assert!(rust.contains("_ => None,"), "{rust}");
    assert!(rust.contains("Self::V1 => \"1\","), "{rust}");
}

#[test]
fn the_first_value_of_an_enum_is_its_default_and_no_other_is() {
    let (_, rust) = emitted(SIDE);
    assert_eq!(rust.matches("#[default]").count(), 1, "{rust}");
    let at = rust.find("#[default]").unwrap();
    assert!(rust[at..].trim_start_matches("#[default]").trim_start().starts_with("Top,"), "{rust}");
}

#[test]
fn a_variant_is_the_value_capitalised_and_digit_led_ones_take_a_v() {
    assert_eq!(dialect::variant_name("top"), "Top");
    assert_eq!(dialect::variant_name("a1"), "A1");
    assert_eq!(dialect::variant_name("1"), "V1");
    assert_eq!(dialect::variant_name("90deg"), "V90deg");
}

#[test]
fn an_enum_rule_the_dialect_states_is_refused_by_name() {
    for (from, to, expect) in [
        (r#"["top", "right", "1"]"#, "[]", "declares no value"),
        (r#"["top", "right", "1"]"#, r#"["top", ""]"#, "is not lowercase"),
        (r#"["top", "right", "1"]"#, r#"["top", "Right"]"#, "is not lowercase"),
        (r#"["top", "right", "1"]"#, r#"["top", "a-b"]"#, "is not lowercase"),
        (r#"["top", "right", "1"]"#, r#"["top", "top"]"#, "name the Rust variant `Top`"),
        (r#"["top", "right", "1"]"#, r#"["top", "self"]"#, "not a name a Rust variant takes"),
        (r#""enum": ["top""#, r#""pattern": "^a$", "enum": ["top""#, "does not apply to an enum"),
    ] {
        refused(&swapped(SIDE, from, to), expect);
    }
}

#[test]
fn the_edges_of_an_enum_value_are_accepted() {
    let defs = swapped(SIDE, r#"["top", "right", "1"]"#, r#"["a", "z", "0", "9"]"#);
    let (_, rust) = emitted(&defs);
    assert!(rust.contains("    A,") && rust.contains("    Z,"), "{rust}");
    assert!(rust.contains("    V0,") && rust.contains("    V9,"), "{rust}");
}

#[test]
fn an_enum_or_union_must_be_a_definition_to_have_a_name() {
    let holder = |field: &str| {
        format!(
            r#"{SIDE}, "Holder": {{
      "description": "A holder.",
      "type": "object",
      "properties": {{ "side": {field} }},
      "required": [],
      "x-wb-order": ["side"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }}"#
        )
    };
    refused(
        &holder(r#"{ "type": "string", "enum": ["a"], "description": "S." }"#),
        "name an enum in $defs",
    );
    refused(
        &holder(
            r##"{ "anyOf": [{ "$ref": "#/$defs/Side" }, { "$ref": "#/$defs/Side" }], "description": "S." }"##,
        ),
        "name a union in $defs",
    );
}

const COLOUR: &str = r##""Colour": {
      "description": "A colour.",
      "anyOf": [{ "$ref": "#/$defs/Side" }, { "$ref": "#/$defs/Point" }]
    }"##;

fn with_members(union: &str) -> String {
    format!("{COLOUR}, {SIDE}, {POINT}").replace(COLOUR, union)
}

#[test]
fn a_union_is_a_zod_union_after_its_members_and_a_rust_enum_of_their_types() {
    let (zod, rust) = emitted(&format!("{COLOUR}, {SIDE}, {POINT}"));
    assert!(
        zod.contains("export const colourSchema = z.union([sideSchema, pointSchema])"),
        "{zod}"
    );
    let at = |name: &str| zod.find(&format!("export const {name}Schema")).unwrap();
    assert!(at("side") < at("colour") && at("point") < at("colour"), "{zod}");
    assert!(rust.contains("pub enum Colour {"), "{rust}");
    assert!(rust.contains("    Side(Side),") && rust.contains("    Point(Point),"), "{rust}");
    assert!(rust.contains("impl Default for Colour {"), "{rust}");
    assert!(rust.contains("Self::Side(Side::default())"), "{rust}");
}

#[test]
fn a_union_rule_the_dialect_states_is_refused_by_name() {
    let single = r##""anyOf": [{ "$ref": "#/$defs/Side" }]"##;
    let two = r##""anyOf": [{ "$ref": "#/$defs/Side" }, { "$ref": "#/$defs/Point" }]"##;
    for (to, expect) in [
        (single, "at least two members"),
        (r##""anyOf": [{ "$ref": "#/$defs/Side" }, { "type": "string" }]"##, "a union member is"),
        (
            r##""anyOf": [{ "$ref": "#/$defs/Side" }, { "$ref": "#/$defs/Point", "minimum": 1 }]"##,
            "does not apply to a union member",
        ),
        (
            r##""anyOf": [{ "$ref": "#/$defs/Side" }, { "$ref": "#/$defs/Point", "description": "P." }]"##,
            "carries only its `$ref`",
        ),
        (
            r##""anyOf": [{ "$ref": "#/$defs/Side" }, { "$ref": "#/$defs/Side" }]"##,
            "`Side` is already a member",
        ),
        (
            r##""anyOf": [{ "$ref": "#/$defs/Side" }, { "$ref": "#/$defs/Nowhere" }]"##,
            "unknown definition `Nowhere`",
        ),
        (r##""type": "string", "anyOf": [{ "$ref": "#/$defs/Side" }]"##, "carries no `type`"),
    ] {
        refused(&with_members(&swapped(COLOUR, two, to)), expect);
    }
}

#[test]
fn a_keyword_that_belongs_to_another_form_is_refused_by_its_name() {
    let number =
        |extra: &str| format!(r#""N": {{ "description": "N.", "type": "number", {extra} }}"#);
    refused(&number(r#""enum": ["a"]"#), "`enum` does not apply to a number");
    refused(&number(r#""minItems": 1"#), "`minItems` does not apply to a number");
    refused(&number(r#""maxItems": 1"#), "`maxItems` does not apply to a number");
    let reference = r##""R": { "description": "R.", "$ref": "#/$defs/N", "anyOf": [] }, "N": { "description": "N.", "type": "number" }"##;
    refused(reference, "`anyOf` does not apply to a reference");
}

const BENDS: &str = r##""Bends": {
      "description": "Bends.",
      "type": "array",
      "items": { "$ref": "#/$defs/Point" },
      "minItems": 1,
      "maxItems": 64
    }"##;

#[test]
fn an_array_length_bound_reaches_zod_as_min_then_max() {
    let (zod, rust) = emitted(&format!("{BENDS}, {POINT}"));
    assert!(zod.contains("z.array(pointSchema).min(1).max(64)"), "{zod}");
    assert!(rust.contains("pub type Bends = Vec<Point>;"), "{rust}");
    let (zod, _) = emitted(&format!("{}, {POINT}", swapped(BENDS, r#""minItems": 1,"#, "")));
    assert!(
        zod.contains("z.array(pointSchema).max(64);")
            || zod.contains("z.array(pointSchema).max(64)\n"),
        "{zod}"
    );
    assert!(!zod.contains(".min("), "{zod}");
    let (zod, _) = emitted(&format!(
        "{}, {POINT}",
        swapped(BENDS, r#""maxItems": 64"#, r#""x-wb-registered": true"#)
    ));
    assert!(zod.contains("z.array(pointSchema).min(1)\n"), "{zod}");
    assert!(!zod.contains(".max("), "{zod}");
}

#[test]
fn an_array_bound_that_cannot_hold_is_refused_and_an_equal_pair_is_not() {
    let both = |min: u32, max: u32| {
        let text = swapped(BENDS, r#""minItems": 1"#, &format!(r#""minItems": {min}"#));
        let text = swapped(&text, r#""maxItems": 64"#, &format!(r#""maxItems": {max}"#));
        format!("{text}, {POINT}")
    };
    refused(&both(3, 2), "minItems is above maxItems");
    let (zod, _) = emitted(&both(2, 2));
    assert!(zod.contains(".min(2).max(2)"), "{zod}");
    refused(
        &format!("{}, {POINT}", swapped(BENDS, r#""type": "array""#, r#""type": "string""#)),
        "does not apply to a string",
    );
}

#[test]
fn a_registered_definition_is_added_to_zods_registry_by_its_name() {
    let (zod, _) = emitted(&format!(
        "{}, {POINT}",
        swapped(BENDS, r#""maxItems": 64"#, r#""maxItems": 64, "x-wb-registered": true"#)
    ));
    let registry = "z.globalRegistry.add(bendsSchema, { id: 'Bends' })";
    assert!(zod.contains(registry), "{zod}");
    assert!(zod.find("export const bendsSchema").unwrap() < zod.find(registry).unwrap());
    assert!(zod.find(registry).unwrap() < zod.find("export type Bends").unwrap());
    let (zod, _) = emitted(&format!("{BENDS}, {POINT}"));
    assert!(!zod.contains("globalRegistry"), "{zod}");
}

#[test]
fn registration_reaches_every_form_of_definition() {
    let object = swapped(
        POINT,
        r#""x-wb-unknownKeys": "refuse""#,
        r#""x-wb-unknownKeys": "refuse", "x-wb-registered": true"#,
    );
    let (zod, _) = emitted(&object);
    assert!(zod.contains("z.globalRegistry.add(pointSchema, { id: 'Point' })"), "{zod}");
    let number = r#""N": { "description": "N.", "type": "number", "x-wb-registered": true }"#;
    let (zod, _) = emitted(number);
    assert!(zod.contains("z.globalRegistry.add(nSchema, { id: 'N' })"), "{zod}");
}

#[test]
fn a_registration_the_dialect_cannot_honour_is_refused() {
    let number =
        |extra: &str| format!(r#""N": {{ "description": "N.", "type": "number"{extra} }}"#);
    refused(&number(r#", "x-wb-registered": false"#), "is `true` or absent");
    let holder = format!(
        r##"{POINT}, "Line": {{ "description": "L.", "type": "array", "items": {{ "$ref": "#/$defs/Point", "x-wb-registered": true }} }}"##
    );
    refused(&holder, "x-wb-registered belongs on a definition");
    let property = swapped(
        POINT,
        r#""type": "number", "description""#,
        r#""type": "number", "x-wb-registered": true, "description""#,
    );
    refused(&property, "x-wb-registered belongs on a definition");
    let described = plain(&number(r#", "x-wb-registered": true"#), IN_MODEL, false)
        .replace(r#""x-wb-describe": false"#, r#""x-wb-describe": true"#);
    let errors = outputs(&described).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("not implemented with x-wb-describe")), "{errors:?}");
}

#[test]
fn a_refusal_message_may_quote_and_use_any_punctuation_but_a_single_quote_or_a_break() {
    let stamp = |message: &str| {
        format!(
            r#""Stamp": {{ "description": "S.", "type": "string", "pattern": "^a$", "x-wb-matcher": "a_only", "x-wb-message": "{message}" }}"#
        )
    };
    let contract = plain(&stamp("must be \\\"1\\\"–\\\"6\\\""), IN_MODEL, true);
    let zod = outputs(&contract).unwrap().remove(0).1;
    assert!(zod.contains("'must be \"1\"–\"6\"'"), "{zod}");
    for (message, expect) in [
        ("a stamp's", "single quotes"),
        ("one\\\\two", "backslashes"),
        ("one\\ntwo", "one line"),
        ("one\\rtwo", "one line"),
        ("   ", "empty"),
    ] {
        let errors = outputs(&plain(&stamp(message), IN_MODEL, true)).unwrap_err();
        assert!(
            errors.iter().any(|e| e.contains("x-wb-message") && e.contains(expect)),
            "{message}: {errors:?}"
        );
    }
}

#[test]
fn the_plain_rust_array_of_a_matched_string_points_at_its_matcher() {
    let defs = r##""Hex": { "description": "H.", "type": "string", "pattern": "^a$", "x-wb-matcher": "a_only", "x-wb-message": "a" },
      "Hexes": { "description": "Hs.", "type": "array", "items": { "$ref": "#/$defs/Hex" }, "minItems": 1 }"##;
    let mut files = outputs(&plain(defs, IN_MODEL, true)).unwrap();
    let (rust, zod) = (files.remove(1).1, files.remove(0).1);
    assert!(zod.contains("z.array(hexSchema).min(1)"), "{zod}");
    assert!(rust.contains("pub type Hexes = Vec<Hex>;"), "{rust}");
    assert!(rust.contains("Matched by `crate::checks::a_only`."), "{rust}");
}
