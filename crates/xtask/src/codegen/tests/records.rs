//! Records whose keys are a string definition's and whose entries are one
//! schema: what each becomes in both languages, and every rule that refuses one.

use super::*;

/// A contract holding `defs`, emitted into a core crate that is not the model's.
fn contract(defs: &str, rust: &str) -> String {
    format!(
        r#"{{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "R",
  "description": "D.",
  "x-wb-emit": {{ "zod": "packages/p/src/generated/r.zod.ts", "rust": "{rust}" }},
  "x-wb-checks": {{ "rust": "crates/core/c/src/checks.rs" }},
  "x-wb-describe": false,
  "x-wb-rustSerde": false,
  "x-wb-readonlyTypes": false,
  "$defs": {{ {defs} }}
}}"#
    )
}

const CORE: &str = "crates/core/c/src/generated/r.rs";

const NAME: &str = r#""Name": {
      "description": "A lowercase name.",
      "type": "string",
      "pattern": "^[a-z]+$",
      "x-wb-matcher": "lower_name",
      "x-wb-message": "must be a lowercase name"
    }"#;

const ITEM: &str = r#""Item": {
      "description": "One entry.",
      "type": "object",
      "properties": { "label": { "type": "string", "description": "What it is called." } },
      "required": ["label"],
      "x-wb-order": ["label"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }"#;

const ITEMS: &str = r##""Items": {
      "description": "Entries by name, at most four.",
      "type": "object",
      "propertyNames": { "$ref": "#/$defs/Name" },
      "additionalProperties": { "$ref": "#/$defs/Item" },
      "maxProperties": 4,
      "x-wb-maxPropertiesMessage": "at most 4 entries; this has {count}"
    }"##;

const HOLDER: &str = r##""Holder": {
      "description": "A holder.",
      "type": "object",
      "properties": {
        "items": { "$ref": "#/$defs/Items", "description": "The entries." },
        "open": {
          "type": "object",
          "propertyNames": { "$ref": "#/$defs/Name" },
          "additionalProperties": { "x-wb-any": true },
          "default": {},
          "description": "Anything by name."
        }
      },
      "required": ["items"],
      "x-wb-order": ["items", "open"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }"##;

fn defs() -> String {
    [NAME, ITEM, ITEMS, HOLDER].join(",\n")
}

fn emitted() -> (String, String) {
    let mut files = outputs(&contract(&defs(), CORE)).unwrap();
    let rust = files.remove(1).1;
    (files.remove(0).1, rust)
}

fn refused_with(defs: &str, rust: &str, expect: &str) {
    let errors = outputs(&contract(defs, rust)).unwrap_err();
    assert!(errors.iter().any(|e| e.contains(expect)), "{expect}: {errors:?}");
}

fn mutated_defs(from: &str, to: &str) -> String {
    let text = defs().replacen(from, to, 1);
    assert_ne!(text, defs(), "{from} did not match");
    text
}

#[test]
fn a_bounded_record_counts_its_entries_before_it_judges_one() {
    let (zod, _) = emitted();
    let want = "export const itemsSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).length <= 4, {
    error: (issue) => `at most 4 entries; this has ${Object.keys(issue.input as object).length}`,
  })
  .pipe(z.record(nameSchema, itemSchema))
export type Items = z.infer<typeof itemsSchema>
";
    assert!(zod.contains(want), "{zod}");
}

#[test]
fn a_bounded_records_long_sentence_breaks_after_the_arrow_the_way_biome_does() {
    let long = "a library holds at most four entries; this one has {count} of them";
    let (zod, _) = emitted_with(&mutated_defs("at most 4 entries; this has {count}", long));
    assert!(
        zod.contains(
            "    error: (issue) =>\n      `a library holds at most four entries; this one has ${Object.keys(issue.input as object).length} of them`,\n"
        ),
        "{zod}"
    );
}

fn emitted_with(defs: &str) -> (String, String) {
    let mut files = outputs(&contract(defs, CORE)).unwrap();
    let rust = files.remove(1).1;
    (files.remove(0).1, rust)
}

#[test]
fn a_keyed_record_property_is_a_zod_record_and_a_default_is_an_empty_one() {
    let (zod, _) = emitted();
    assert!(zod.contains("\n  items: itemsSchema,\n"), "{zod}");
    assert!(zod.contains("\n  open: z.record(nameSchema, z.unknown()).default({}),\n"), "{zod}");
}

#[test]
fn a_keyed_record_is_a_vec_of_pairs_in_rust_and_a_default_is_no_option() {
    let (_, rust) = emitted();
    assert!(rust.contains("\nuse whiteboard_model::Value;\n"), "{rust}");
    assert!(rust.contains("pub type Items = Vec<(Name, Item)>;"), "{rust}");
    assert!(rust.contains("/// Holds at most 4 entries.\npub type Items"), "{rust}");
    assert!(rust.contains("    pub items: Items,\n"), "{rust}");
    assert!(rust.contains("    pub open: Vec<(Name, Value)>,\n"), "{rust}");
    assert!(!rust.contains("Option<"), "{rust}");
}

#[test]
fn the_model_crate_names_its_own_value_without_a_dependency_on_itself() {
    let defs = defs().replace("crates/core/c/", "crates/core/model/");
    let text = contract(&defs, "crates/core/model/src/generated/r.rs")
        .replace("crates/core/c/src/checks.rs", "crates/core/model/src/checks.rs");
    let rust = outputs(&text).unwrap().remove(1).1;
    assert!(rust.contains("\nuse crate::Value;\n"), "{rust}");
}

#[test]
fn a_crate_outside_core_cannot_name_the_models_value() {
    let text = contract(&defs(), "crates/bindings/c/src/generated/r.rs")
        .replace("crates/core/c/", "crates/bindings/c/");
    let errors = outputs(&text).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("so it must emit in a core crate")), "{errors:?}");
}

#[test]
fn a_record_rule_the_dialect_states_is_refused_by_name() {
    for (from, to, expect) in [
        (r#""maxProperties": 4,"#, "", "need each other"),
        (
            r#""x-wb-maxPropertiesMessage": "at most 4 entries; this has {count}""#,
            r#""x-wb-maxPropertiesMessage": "at most 4 entries""#,
            "holds `{count}`",
        ),
        ("this has {count}", "this has ${count}", "no backtick or `$`"),
        (
            r##""propertyNames": { "$ref": "#/$defs/Name" },
      "additionalProperties": { "$ref": "#/$defs/Item" },"##,
            r##""propertyNames": { "$ref": "#/$defs/Name" },
      "additionalProperties": true,"##,
            "`additionalProperties` is a schema",
        ),
        (
            r##""propertyNames": { "$ref": "#/$defs/Name" },
      "additionalProperties": { "$ref": "#/$defs/Item" },"##,
            r##""propertyNames": { "$ref": "#/$defs/Item" },
      "additionalProperties": { "$ref": "#/$defs/Item" },"##,
            "which is not a string",
        ),
        (
            r##""propertyNames": { "$ref": "#/$defs/Name" },
      "additionalProperties": { "$ref": "#/$defs/Item" },"##,
            r##""propertyNames": { "type": "string" },
      "additionalProperties": { "$ref": "#/$defs/Item" },"##,
            "is a `$ref` to a string definition",
        ),
        (
            r#""maxProperties": 4,"#,
            r#""maxProperties": 4, "x-wb-check": "item_keys","#,
            "carries no x-wb-check",
        ),
        (r#""default": {},"#, r#""default": [],"#, "a record's default is `{}`"),
        (
            r#""default": {},"#,
            r#""default": {}, "maxProperties": 2, "x-wb-maxPropertiesMessage": "{count}","#,
            "name a bounded record in $defs",
        ),
    ] {
        refused_with(&mutated_defs(from, to), CORE, expect);
    }
}

#[test]
fn a_bound_needs_a_keyed_record_and_a_list_default_is_an_empty_list() {
    let bag = r#""Bag": {
      "description": "A bag.",
      "type": "object",
      "additionalProperties": { "x-wb-any": true },
      "maxProperties": 3,
      "x-wb-maxPropertiesMessage": "at most {count}"
    }"#;
    refused_with(bag, CORE, "`maxProperties` needs `propertyNames`");
    let property = r#""Holder": {
      "description": "A holder.",
      "type": "object",
      "properties": { "list": { "type": "array", "items": { "type": "string" }, "default": {}, "description": "The list." } },
      "required": [],
      "x-wb-order": ["list"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }"#;
    refused_with(property, CORE, "an array's default is `[]`");
}

#[test]
fn a_bounded_record_in_a_property_is_named_and_referenced_instead() {
    let inline = r##""Holder": {
      "description": "A holder.",
      "type": "object",
      "properties": {
        "items": {
          "type": "object",
          "propertyNames": { "$ref": "#/$defs/Name" },
          "additionalProperties": { "x-wb-any": true },
          "maxProperties": 2,
          "x-wb-maxPropertiesMessage": "at most 2; has {count}",
          "description": "Inline."
        }
      },
      "required": ["items"],
      "x-wb-order": ["items"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }"##;
    refused_with(&[NAME, inline].join(",\n"), CORE, "name a bounded record in $defs");
}

#[test]
fn a_bounded_record_is_not_implemented_with_a_contract_that_describes_everything() {
    let defs = [NAME, ITEM, ITEMS].join(",\n");
    let text =
        contract(&defs, CORE).replace(r#""x-wb-describe": false"#, r#""x-wb-describe": true"#);
    let errors = outputs(&text).unwrap_err();
    assert!(
        errors.iter().any(|e| e.contains("a bounded record is not implemented with x-wb-describe")),
        "{errors:?}"
    );
}

#[test]
fn a_default_is_an_empty_list_or_an_empty_record_and_nothing_else() {
    for default in [r#""default": {"a": 1},"#, r#""default": ["a"],"#, r#""default": "x","#] {
        let text = contract(&mutated_defs(r#""default": {},"#, default), CORE);
        assert!(dialect::parse(&text).is_err(), "{default} was accepted");
    }
}

#[test]
fn a_bounded_record_inside_a_list_is_named_and_referenced_instead() {
    let inline = r##""Holder": {
      "description": "A holder.",
      "type": "object",
      "properties": {
        "rows": {
          "type": "array",
          "items": {
            "type": "object",
            "propertyNames": { "$ref": "#/$defs/Name" },
            "additionalProperties": { "x-wb-any": true },
            "maxProperties": 2,
            "x-wb-maxPropertiesMessage": "at most 2; has {count}"
          },
          "description": "Rows."
        }
      },
      "required": ["rows"],
      "x-wb-order": ["rows"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }"##;
    refused_with(&[NAME, inline].join(",\n"), CORE, "name a bounded record in $defs");
}

#[test]
fn a_check_on_a_records_entries_is_named_like_any_other() {
    let bag = r##""Bag": {
      "description": "A bag.",
      "type": "object",
      "propertyNames": { "$ref": "#/$defs/Name" },
      "additionalProperties": { "type": "string", "x-wb-check": "NotSnake" }
    }"##;
    refused_with(&[NAME, bag].join(",\n"), CORE, "check `NotSnake`: must be snake_case");
}

#[test]
fn an_output_path_segment_is_lowercase_words_joined_by_dashes_or_underscores() {
    assert!(outputs(&contract(&defs(), "crates/core/c/src/generated/r_s-2.rs")).is_ok());
    for path in ["crates/core/c/src/generated/R.rs", "crates/core/c/src/generated/.rs"] {
        refused_with(&defs(), path, "is not crates/<dir>/<dir>/src/generated/<name>.rs");
    }
}
