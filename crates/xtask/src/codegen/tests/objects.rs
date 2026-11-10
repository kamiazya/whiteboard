//! Object-level checks, extension, lenient and published properties: what each
//! becomes in both languages, and every rule that refuses one.

use super::plain::{IN_MODEL, plain};
use super::shapes::{refused, swapped};
use super::*;

const BASE: &str = r#""Base": {
      "description": "A base.",
      "type": "object",
      "properties": {
        "id": { "type": "string", "x-wb-minUtf16": 1, "description": "An id." },
        "tags": { "type": "array", "items": { "type": "string" }, "x-wb-lenient": true, "description": "Labels." }
      },
      "required": ["id"],
      "x-wb-order": ["id", "tags"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }"#;

const DERIVED: &str = r#""Derived": {
      "description": "A derived value.",
      "type": "object",
      "x-wb-extends": "Base",
      "properties": {
        "label": { "type": "string", "description": "A label." }
      },
      "required": [],
      "x-wb-order": ["label"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse",
      "x-wb-check": "label_is_short"
    }"#;

fn contract(defs: &str) -> String {
    plain(defs, IN_MODEL, true)
}

fn generated(defs: &str) -> (String, String) {
    let mut files = outputs(&contract(defs)).unwrap();
    let rust = files.remove(1).1;
    (files.remove(0).1, rust)
}

fn both() -> String {
    format!("{DERIVED}, {BASE}")
}

#[test]
fn an_extension_is_its_bases_extend_made_strict_and_refined_by_its_check() {
    let (zod, _) = generated(&both());
    let want = "export const derivedSchema = baseSchema\n  .extend({\n    label: z.string().optional(),\n  })\n  .strict()\n  .superRefine(labelIsShort)\n";
    assert!(zod.contains(want), "{zod}");
    assert!(
        zod.find("export const baseSchema").unwrap()
            < zod.find("export const derivedSchema").unwrap()
    );
    assert!(zod.contains("import { labelIsShort } from '../contract-checks.js'"), "{zod}");
}

#[test]
fn an_extension_is_a_flat_rust_struct_of_its_bases_fields_then_its_own() {
    let (_, rust) = generated(&both());
    let body = &rust[rust.find("pub struct Derived {").unwrap()..];
    let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("{needle}: {body}"));
    assert!(at("pub id: String,") < at("pub tags: Option<Vec<String>>,"), "{body}");
    assert!(at("pub tags:") < at("pub label: Option<String>,"), "{body}");
    assert_eq!(rust.matches("pub struct Base {").count(), 1, "{rust}");
}

#[test]
fn an_object_check_is_pointed_at_in_the_struct_docs_and_listed_for_both_languages() {
    let (_, rust) = generated(&both());
    assert!(
        rust.contains(
            "/// A derived value.\n///\n/// Checked by `crate::checks::label_is_short`.\n#[derive("
        ),
        "{rust}"
    );
    let parsed = dialect::parse(&contract(&both())).unwrap();
    let checked = dialect::check(&parsed).unwrap();
    assert_eq!(checked.zod_checks, ["label_is_short"]);
    assert_eq!(checked.rust_names, ["label_is_short"]);
}

#[test]
fn a_strict_object_with_a_check_and_no_base_chains_it_after_the_constructor() {
    let defs = swapped(
        &swapped(DERIVED, r#""x-wb-extends": "Base","#, ""),
        r#""required": []"#,
        r#""required": ["label"]"#,
    );
    let (zod, _) = generated(&defs);
    let want = "export const derivedSchema = z\n  .strictObject({\n    label: z.string(),\n  })\n  .superRefine(labelIsShort)\n";
    assert!(zod.contains(want), "{zod}");
}

#[test]
fn a_lenient_property_reads_as_absent_when_malformed() {
    let (zod, rust) = generated(&both());
    assert!(zod.contains("\n  tags: z.array(z.string()).optional().catch(undefined),\n"), "{zod}");
    assert!(rust.contains("    /// Labels.\n    ///\n    /// A malformed value reads as absent.\n    pub tags: Option<Vec<String>>,\n"), "{rust}");
}

#[test]
fn an_extension_rule_the_dialect_states_is_refused_by_name() {
    for (defs, expect) in [
        (
            swapped(&both(), r#""x-wb-extends": "Base""#, r#""x-wb-extends": "Nowhere""#),
            "unknown definition `Nowhere`",
        ),
        (
            swapped(&both(), r#""x-wb-unknownKeys": "refuse""#, r#""x-wb-unknownKeys": "strip""#)
                .replace(r#""additionalProperties": false"#, r#""additionalProperties": true"#),
            "must refuse unknown keys",
        ),
        (
            swapped(&both(), r#""label": {"#, r#""id": {"#).replace(r#"["label"]"#, r#"["id"]"#),
            "repeats a property of `Base`",
        ),
    ] {
        refused(&defs, expect);
    }
}

#[test]
fn a_base_must_be_a_plain_object_with_nothing_of_its_own_to_refuse() {
    let refined = swapped(
        BASE,
        r#""x-wb-unknownKeys": "strip""#,
        r#""x-wb-unknownKeys": "strip", "x-wb-check": "base_check""#,
    );
    refused(&format!("{DERIVED}, {refined}"), "`Base` carries a check");
    let strict = swapped(BASE, r#""x-wb-unknownKeys": "strip""#, r#""x-wb-unknownKeys": "refuse""#)
        .replace(r#""additionalProperties": true"#, r#""additionalProperties": false"#);
    refused(&format!("{DERIVED}, {strict}"), "`Base` must strip unknown keys");
    let chained =
        swapped(BASE, r#""properties": {"#, r#""x-wb-extends": "Other", "properties": {"#);
    let other = r#""Other": { "description": "O.", "type": "object", "properties": { "z": { "type": "string", "description": "Z." } }, "required": [], "x-wb-order": ["z"], "additionalProperties": true, "x-wb-unknownKeys": "strip" }"#;
    refused(&format!("{DERIVED}, {chained}, {other}"), "`Base` extends another");
    let leaf = r#""Base": { "description": "B.", "type": "string" }"#;
    refused(&format!("{DERIVED}, {leaf}"), "`Base` is not an object");
}

#[test]
fn a_decoration_the_dialect_cannot_honour_is_refused() {
    for (from, to, expect) in [
        (
            r#""x-wb-lenient": true"#,
            r#""x-wb-lenient": false"#,
            "x-wb-lenient: is `true` or absent",
        ),
        (
            r#""x-wb-lenient": true"#,
            r#""x-wb-lenient": true, "default": []"#,
            "a lenient property is optional and has no default",
        ),
    ] {
        refused(&swapped(&both(), from, to), expect);
    }
    let required = swapped(&both(), r#""required": ["id"]"#, r#""required": ["id", "tags"]"#);
    refused(&required, "a lenient property is optional and has no default");
    let top = r#""Flag": { "description": "F.", "type": "string", "x-wb-lenient": true }"#;
    refused(top, "x-wb-lenient belongs on a property");
    let items = swapped(
        BASE,
        r#""items": { "type": "string" }"#,
        r#""items": { "type": "string", "x-wb-lenient": true }"#,
    );
    refused(&items, "x-wb-lenient belongs on a property");
}

#[test]
fn an_object_check_or_extension_needs_the_forms_that_emit_it() {
    let serde = plain(&both(), IN_MODEL, true)
        .replace(r#""x-wb-rustSerde": false"#, r#""x-wb-rustSerde": true"#);
    let errors = outputs(&serde).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("x-wb-rustSerde emits closed objects")), "{errors:?}");
    let described = plain(&both(), IN_MODEL, true)
        .replace(r#""x-wb-describe": false"#, r#""x-wb-describe": true"#);
    let errors = outputs(&described).unwrap_err();
    assert!(
        errors
            .iter()
            .any(|e| e
                .contains("an object check or extension is not implemented with x-wb-describe")),
        "{errors:?}"
    );
}

const PUBLISHED: &str = r#""Pinned": {
      "description": "A pinned value.",
      "type": "object",
      "properties": {
        "side": { "type": "string", "x-wb-describe": "Where it \"sits\": omit it.", "description": "A side." }
      },
      "required": [],
      "x-wb-order": ["side"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }"#;

#[test]
fn a_published_text_is_the_describe_of_its_property_after_its_other_calls() {
    let (zod, rust) = generated(PUBLISHED);
    assert!(
        zod.contains("\n  side: z.string().optional().describe('Where it \"sits\": omit it.'),\n"),
        "{zod}"
    );
    assert!(rust.contains("    /// A side.\n    pub side: Option<String>,\n"), "{rust}");
    assert!(!rust.contains("omit it"), "{rust}");
    let lenient =
        swapped(PUBLISHED, r#""x-wb-describe""#, r#""x-wb-lenient": true, "x-wb-describe""#);
    let (zod, _) = generated(&lenient);
    assert!(zod.contains("z.string().optional().catch(undefined).describe('Where"), "{zod}");
}

#[test]
fn a_long_published_text_sits_on_a_line_of_its_own_and_is_not_refused_for_its_width() {
    let long = "Omit it and the router picks whatever keeps the line clear of the other boxes on the board, and a side you name is kept.";
    let defs = swapped(PUBLISHED, "Where it \\\"sits\\\": omit it.", long);
    let (zod, _) = generated(&defs);
    let want = format!(
        "\n  side: z\n    .string()\n    .optional()\n    .describe(\n      '{long}',\n    ),\n"
    );
    assert!(zod.contains(&want), "{zod}");
    assert!(
        zod.lines().any(|l| l.chars().count() > 100 && l.trim_start().starts_with('\'')),
        "{zod}"
    );
}

#[test]
fn a_published_text_rule_the_dialect_states_is_refused_by_name() {
    for (text, expect) in [
        ("it's", "single quotes"),
        ("a\\\\b", "backslashes"),
        ("a\\nb", "one line"),
        ("  ", "empty"),
    ] {
        let defs = swapped(PUBLISHED, "Where it \\\"sits\\\": omit it.", text);
        refused(&defs, expect);
    }
    let top = r#""Flag": { "description": "F.", "type": "string", "x-wb-describe": "F." }"#;
    refused(top, "x-wb-describe belongs on a property");
    let described = plain(PUBLISHED, IN_MODEL, false)
        .replace(r#""x-wb-describe": false"#, r#""x-wb-describe": true"#);
    let errors = outputs(&described).unwrap_err();
    assert!(
        errors.iter().any(|e| e.contains("the contract already publishes every description")),
        "{errors:?}"
    );
}

#[test]
fn a_line_of_exactly_biomes_width_is_kept_and_one_column_more_is_refused() {
    let number = |letters: usize| {
        let description = "a".repeat(letters);
        format!(r#""N": {{ "description": "{description}", "type": "number" }}"#)
    };
    let zod = outputs(&plain(&number(93), IN_MODEL, false)).unwrap().remove(0).1;
    assert!(zod.lines().any(|l| l.starts_with("/** a") && l.chars().count() == 100), "{zod}");
    let errors = outputs(&plain(&number(94), IN_MODEL, false)).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("a line past biome's 100 columns")), "{errors:?}");
}

#[test]
fn a_lone_call_on_a_named_schema_breaks_its_argument_and_not_its_chain() {
    let size = r##""Size": { "description": "S.", "type": "number" },
      "Boxed": {
      "description": "A boxed value.",
      "type": "object",
      "properties": {
        "height": { "$ref": "#/$defs/Size", "x-wb-describe": "Box height. Omit it and a text box is made tall enough for its text; a named one too short is refused.", "description": "H." }
      },
      "required": ["height"],
      "x-wb-order": ["height"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }"##;
    let (zod, _) = generated(size);
    let want = "\n  height: sizeSchema.describe(\n    'Box height. Omit it and a text box is made tall enough for its text; a named one too short is refused.',\n  ),\n";
    assert!(zod.contains(want), "{zod}");
}
