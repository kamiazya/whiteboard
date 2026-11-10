use super::*;

mod plain;
mod shapes;

const RECT: &str = r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "T",
  "description": "D.",
  "x-wb-emit": {
    "zod": "packages/p/src/generated/t.zod.ts",
    "rust": "crates/core/c/src/generated/t.rs"
  },
  "$defs": {
    "Rect": {
      "description": "A rect.",
      "type": "object",
      "properties": {
        "w": { "type": "number", "minimum": 0, "description": "Width." },
        "x": { "type": "number", "description": "Left." }
      },
      "required": ["x", "w"],
      "x-wb-order": ["x", "w"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }
  }
}"#;

fn outputs(text: &str) -> Result<Vec<(String, String)>, Vec<String>> {
    let files = generate(&dialect::parse(text).map_err(|e| vec![e])?, "c.schema.json")?;
    Ok(files.into_iter().map(|(target, content, _)| (target, content)).collect())
}

/// The contract with `from` replaced by `to`, asserting the replacement hit.
fn mutated(from: &str, to: &str) -> String {
    let text = RECT.replacen(from, to, 1);
    assert_ne!(text, RECT, "{from} did not match");
    text
}

#[test]
fn fields_follow_required_order_and_bounds_reach_both_languages() {
    let files = outputs(RECT).unwrap();
    let (zod, rust) = (&files[0].1, &files[1].1);
    assert!(zod.find("    x: z.number()").unwrap() < zod.find("    w: z.number().min(0)").unwrap());
    assert!(rust.contains("if wire.w.is_nan() || wire.w < 0.0 {"));
    assert!(!rust.contains("wire.x.is_nan()"));
}

#[test]
fn the_public_rust_type_reads_only_an_object() {
    let rust = &outputs(RECT).unwrap()[1].1;
    assert!(rust.contains("#[derive(Debug, Clone, Copy, PartialEq, Serialize)]\npub struct Rect"));
    assert!(rust.contains("deserializer.deserialize_map(MapOnly(PhantomData))"));
}

#[test]
fn a_construct_outside_the_dialect_is_refused_by_name() {
    for (from, to) in [
        (r#""minimum": 0,"#, r#""maxLength": 4,"#),
        (r#""minimum": 0,"#, r#""minimum": null,"#),
        (
            r#""type": "number", "description": "Left.""#,
            r#""type": "boolean", "description": "Left.""#,
        ),
        (r#""x-wb-unknownKeys": "refuse""#, r#""x-wb-unknownKeys": "ignore""#),
        (r#""minimum": 0,"#, r#""x-wb-nope": 1,"#),
        (
            r#""x": { "type": "number", "description": "Left." }"#,
            r#""x": { "type": "number", "description": "Left." }, "x": { "type": "number", "description": "Again." }"#,
        ),
    ] {
        let text = mutated(from, to);
        assert!(dialect::parse(&text).is_err(), "{to} was accepted");
    }
}

#[test]
fn dialect_rules_the_parse_cannot_see_are_checked() {
    for (from, to, expect) in [
        (r#""required": ["x", "w"]"#, r#""required": ["x"]"#, "required numbers"),
        (r#""x-wb-order": ["x", "w"]"#, r#""x-wb-order": ["x"]"#, "x-wb-order"),
        (
            r#""additionalProperties": false"#,
            r#""additionalProperties": true"#,
            "additionalProperties",
        ),
        ("\"Width.\"", "\"Wid'th.\"", "without quotes"),
        ("2020-12", "2019-09", "$schema"),
        (r#""Rect": {"#, r#""Result": {"#, "already uses"),
        (r#""Rect": {"#, r#""RectWire": {"#, "already uses"),
        ("packages/p/src/generated/t.zod.ts", "../outside.zod.ts", "x-wb-emit.zod"),
        ("packages/p/src/generated/t.zod.ts", "packages/p/src/t.zod.ts", "x-wb-emit.zod"),
        ("crates/core/c/src/generated/t.rs", "crates/xtask/src/generated/t.rs", "x-wb-emit.rust"),
        ("crates/core/c/src/generated/t.rs", "crates/core/c/src/generated/t.ts", "x-wb-emit.rust"),
        ("\"Width.\"", &format!("\"{}\"", "Wide ".repeat(20)), "biome's 100 columns"),
    ] {
        let errors = outputs(&mutated(from, to)).unwrap_err();
        assert!(errors.iter().any(|e| e.contains(expect)), "{expect}: {errors:?}");
    }
}

#[test]
fn a_field_named_by_a_rust_keyword_is_refused() {
    let text = mutated(r#""x": {"#, r#""self": {"#).replace(r#"["x", "w"]"#, r#"["self", "w"]"#);
    let errors = outputs(&text).unwrap_err();
    assert!(
        errors.iter().any(|e| e.contains("$defs.Rect.self: not a name both languages take")),
        "{errors:?}"
    );
}

#[test]
fn a_key_rust_could_not_spell_back_is_refused_and_camel_case_is_taken() {
    let renamed = |to: &str| {
        model_mutated(r#""note": {"#, &format!(r#""{to}": {{"#))
            .replace(r#""at", "note"]"#, &format!(r#""at", "{to}"]"#))
    };
    for bad in ["Left", "le-ft", "left_Edge", "left__edge", "left_", "le ft"] {
        let errors = outputs(&renamed(bad)).unwrap_err();
        let want = format!("$defs.Event.{bad}: not a lowercase identifier");
        assert!(errors.iter().any(|e| e.contains(&want)), "{bad}: {errors:?}");
    }
    for good in ["leftEdge", "left_edge", "x2"] {
        assert!(outputs(&renamed(good)).is_ok(), "{good}");
    }
}

#[test]
fn a_contract_whose_definitions_are_not_an_object_is_refused_naming_the_shape() {
    let text = RECT.replacen(r#""$defs": {"#, r#""$defs": [], "x": {"#, 1);
    let error = dialect::parse(&text).unwrap_err();
    assert!(error.contains("expected an object"), "{error}");
}

#[test]
fn a_definition_or_contract_with_nothing_in_it_is_refused() {
    let empty_def = RECT
        .replacen(r#""w": { "type": "number", "minimum": 0, "description": "Width." },"#, "", 1)
        .replacen(r#""x": { "type": "number", "description": "Left." }"#, "", 1)
        .replacen(r#""required": ["x", "w"]"#, r#""required": []"#, 1)
        .replacen(r#""x-wb-order": ["x", "w"]"#, r#""x-wb-order": []"#, 1);
    let errors = outputs(&empty_def).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("declares no property")), "{errors:?}");
}

/// A contract in the model's shape: no serde, no `.describe()`, a hand-written
/// check module beside each output, every construct the model contract uses.
const MODEL: &str = r##"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "M",
  "description": "D.",
  "x-wb-emit": {
    "zod": "packages/p/src/generated/m.zod.ts",
    "rust": "crates/core/model/src/generated/m.rs"
  },
  "x-wb-checks": {
    "zod": "packages/p/src/contract-checks.ts",
    "rust": "crates/core/model/src/checks.rs"
  },
  "x-wb-describe": false,
  "x-wb-rustSerde": false,
  "x-wb-readonlyTypes": false,
  "$defs": {
    "Event": {
      "description": "An event.",
      "type": "object",
      "properties": {
        "at": { "$ref": "#/$defs/Stamp", "description": "When." },
        "by": { "$ref": "#/$defs/Actor", "description": "Who." },
        "note": { "type": "string", "description": "Why." }
      },
      "required": ["by", "at"],
      "x-wb-order": ["by", "at", "note"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "keep"
    },
    "Actor": {
      "description": "An actor.",
      "type": "string",
      "x-wb-minUtf16": 1,
      "x-wb-check": "single_line"
    },
    "Stamp": {
      "description": "A timestamp.",
      "type": "string",
      "pattern": "^\\d{4}(Z|[+-]\\d{2})$",
      "x-wb-matcher": "stamp",
      "x-wb-message": "a stamp is a year and a zone"
    },
    "Bag": {
      "description": "Anything by name.",
      "type": "object",
      "additionalProperties": { "x-wb-any": true },
      "x-wb-check": "bag_keys"
    },
    "Doc": {
      "description": "A document.",
      "type": "object",
      "properties": {
        "type": { "type": "string", "description": "Kind." },
        "tags": { "type": "array", "items": { "type": "string" }, "description": "Labels." },
        "events": { "type": "array", "items": { "$ref": "#/$defs/Event" }, "description": "Log." },
        "bag": { "$ref": "#/$defs/Bag", "description": "Extras." },
        "anything": { "x-wb-any": true, "description": "Whatever." },
        "extraBag": { "$ref": "#/$defs/Bag", "description": "More extras." }
      },
      "required": ["type"],
      "x-wb-order": ["type", "tags", "events", "bag", "anything", "extraBag"],
      "additionalProperties": true,
      "x-wb-unknownKeys": "strip"
    }
  }
}"##;

fn model_mutated(from: &str, to: &str) -> String {
    let text = MODEL.replacen(from, to, 1);
    assert_ne!(text, MODEL, "{from} did not match");
    text
}

fn model_zod() -> String {
    outputs(MODEL).unwrap().remove(0).1
}

fn model_rust() -> String {
    outputs(MODEL).unwrap().remove(1).1
}

#[test]
fn definitions_come_out_in_dependency_order_whatever_their_names() {
    let zod = model_zod();
    let at = |name: &str| zod.find(&format!("export const {name}Schema")).unwrap();
    assert!(at("actor") < at("event") && at("stamp") < at("event"));
    assert!(at("event") < at("doc") && at("bag") < at("doc"));
    let rust = model_rust();
    assert!(rust.find("pub struct Event").unwrap() < rust.find("pub struct Doc").unwrap());
}

#[test]
fn a_string_bound_in_utf16_units_a_check_and_a_pattern_reach_zod() {
    let zod = model_zod();
    assert!(zod.starts_with(&emit::header("c.schema.json")));
    assert!(zod.contains(
        "import { z } from 'zod'\nimport { bagKeys, singleLine } from '../contract-checks.js'\n"
    ));
    assert!(zod.contains("export const actorSchema = z.string().min(1).superRefine(singleLine)\n"));
    assert!(zod.contains(
        "export const stampSchema = z.string().regex(/^\\d{4}(Z|[+-]\\d{2})$/, 'a stamp is a year and a zone')\n"
    ));
    let long = model_mutated("a stamp is a year and a zone", &"a long stamp message ".repeat(3));
    let broken = &outputs(&long).unwrap()[0].1;
    assert!(broken.contains(
        "export const stampSchema = z\n  .string()\n  .regex(/^\\d{4}(Z|[+-]\\d{2})$/, 'a long"
    ));
    assert!(zod.contains(
        "export const bagSchema = z.record(z.string(), z.unknown()).superRefine(bagKeys)\n"
    ));
    assert!(!zod.contains("describe"), "{zod}");
}

#[test]
fn optional_fields_array_ref_any_and_record_reach_zod_in_order() {
    let zod = model_zod();
    let doc = &zod[zod.find("export const docSchema").unwrap()..];
    let fields: Vec<&str> = doc.lines().skip(1).take(6).map(str::trim).collect();
    assert_eq!(
        fields,
        [
            "type: z.string(),",
            "tags: z.array(z.string()).optional(),",
            "events: z.array(eventSchema).optional(),",
            "bag: bagSchema.optional(),",
            "anything: z.unknown().optional(),",
            "extraBag: bagSchema.optional(),",
        ]
    );
    assert!(zod.contains("export type Doc = z.infer<typeof docSchema>\n"));
}

#[test]
fn unknown_keys_are_refused_stripped_or_kept_by_the_zod_object_it_picks() {
    let zod = model_zod();
    assert!(zod.contains("export const eventSchema = z.looseObject({"));
    assert!(zod.contains("export const docSchema = z.object({"));
    assert!(outputs(RECT).unwrap()[0].1.contains(".strictObject({"));
}

#[test]
fn the_plain_rust_types_carry_options_vecs_values_and_the_kept_keys() {
    let rust = model_rust();
    assert!(rust.contains("use crate::{Map, Value};"));
    assert!(!rust.contains("serde") && !rust.contains("MapOnly"), "{rust}");
    assert!(rust.contains("#[derive(Debug, Clone, PartialEq, Default)]\npub struct Event {"));
    assert!(rust.contains("    pub by: Actor,\n    /// When.\n    pub at: Stamp,"));
    assert!(rust.contains("    pub note: Option<String>,\n    /// Keys the contract does not name, in the order written.\n    pub extra: Map,\n}"));
    assert!(rust.contains("pub r#type: String,"));
    assert!(rust.contains("pub tags: Option<Vec<String>>,"));
    assert!(rust.contains("pub events: Option<Vec<Event>>,"));
    assert!(rust.contains("pub anything: Option<Value>,"));
    assert!(rust.contains("pub extra_bag: Option<Bag>,"));
    assert!(rust.contains("pub type Actor = String;"));
    assert!(rust.contains("pub type Bag = Map;"));
    let doc = &rust[rust.find("pub struct Doc").unwrap()..];
    assert!(!doc.contains("pub extra:"), "a stripped object keeps no unknown keys");
}

#[test]
fn a_named_check_and_matcher_are_pointed_at_in_the_rust_docs() {
    let rust = model_rust();
    assert!(rust.contains("/// Checked by `crate::checks::single_line`."));
    assert!(rust.contains("/// Checked by `crate::checks::bag_keys`."));
    assert!(rust.contains("/// Matched by `crate::checks::stamp`."));
}

#[test]
fn an_array_of_checked_strings_points_at_its_check_in_the_rust_docs() {
    let line = "/// Checked by `crate::checks::single_line`.";
    let before = model_rust().matches(line).count();
    let text = model_mutated(
        r#""items": { "type": "string" }, "description": "Labels.""#,
        r#""items": { "type": "string", "x-wb-check": "single_line" }, "description": "Labels.""#,
    );
    let after = outputs(&text).unwrap().remove(1).1.matches(line).count();
    assert_eq!(after, before + 1);
}

#[test]
fn the_names_a_contract_leans_on_are_listed_for_each_language() {
    let contract = dialect::parse(MODEL).unwrap();
    let checked = dialect::check(&contract).unwrap();
    assert_eq!(checked.zod_checks, ["bag_keys", "single_line"]);
    assert_eq!(checked.rust_names, ["bag_keys", "single_line", "stamp"]);
}

#[test]
fn a_name_missing_from_a_hand_written_module_is_reported() {
    let ts = "export function singleLine(v: string) {}\nexport const bagKeys = () => {}\n";
    let rs =
        "pub fn single_line(a: &str) -> bool { true }\npub fn stamp(a: &str) -> bool { true }\n";
    assert!(missing_zod_checks(ts, &["single_line", "bag_keys"]).is_empty());
    assert_eq!(missing_zod_checks(ts, &["single_line", "nope"]), ["nope"]);
    let longer = "export function singleLines() {}\nexport const bagKeys_2 = 1\n";
    assert_eq!(
        missing_zod_checks(longer, &["single_line", "bag_keys"]),
        ["single_line", "bag_keys"]
    );
    assert_eq!(missing_rust_checks(rs, &["single_line", "bag_keys"]), ["bag_keys"]);
    assert_eq!(missing_rust_checks("// pub fn stamp(", &["stamp"]), ["stamp"]);
}

#[test]
fn codegen_reads_each_declared_check_module_and_names_what_it_lacks() {
    let root = std::env::temp_dir().join(format!("wb-verify-checks-{}", std::process::id()));
    let ts = root.join("packages/p/src/contract-checks.ts");
    let rs = root.join("crates/core/model/src/checks.rs");
    let write = |path: &std::path::Path, text: &str| {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    };
    let contract = dialect::parse(MODEL).unwrap();
    let missing_file = verify_checks(&root, &contract).unwrap_err();
    assert!(missing_file[0].starts_with("cannot read packages/p/src/contract-checks.ts"));
    write(&ts, "export function singleLine() {}\nexport function bagKeys() {}\n");
    write(&rs, "pub fn single_line() {}\npub fn bag_keys() {}\n");
    assert_eq!(
        verify_checks(&root, &contract).unwrap_err(),
        ["crates/core/model/src/checks.rs: declares no `stamp`"]
    );
    write(&rs, "pub fn single_line() {}\npub fn bag_keys() {}\npub fn stamp() {}\n");
    assert_eq!(verify_checks(&root, &contract), Ok(()));
    let unchecked = dialect::parse(RECT).unwrap();
    assert_eq!(verify_checks(&root.join("nowhere"), &unchecked), Ok(()));
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_definition_named_like_a_plain_rust_import_is_refused() {
    for name in ["Map", "Value"] {
        let text = model_mutated("\"Bag\": {", &format!("\"{name}\": {{"))
            .replace("#/$defs/Bag", &format!("#/$defs/{name}"));
        let errors = outputs(&text).unwrap_err();
        assert!(
            errors.iter().any(|e| e.contains("a name the generated code already uses")),
            "{errors:?}"
        );
    }
}

fn assert_refused(cases: &[(&str, &str, &str)]) {
    for (from, to, expect) in cases {
        let text = model_mutated(from, to);
        if let Err(e) = dialect::parse(&text) {
            assert!(e.contains(expect), "{expect}: {e}");
        } else {
            let errors = outputs(&text).unwrap_err();
            assert!(errors.iter().any(|e| e.contains(expect)), "{expect}: {errors:?}");
        }
    }
}

#[test]
fn an_object_rule_the_model_dialect_states_is_refused_by_name() {
    assert_refused(&[
        (r#""x-wb-order": ["by", "at", "note"]"#, r#""x-wb-order": ["by", "at"]"#, "x-wb-order"),
        (
            r#""x-wb-order": ["by", "at", "note"]"#,
            r#""x-wb-order": ["by", "at", "note", "at"]"#,
            "x-wb-order",
        ),
        (
            r#""x-wb-order": ["by", "at", "note"]"#,
            r#""x-wb-order": ["by", "at", "zzz"]"#,
            "x-wb-order",
        ),
        (r#""required": ["by", "at"]"#, r#""required": ["by", "zzz"]"#, "required"),
        (r##""#/$defs/Actor""##, r##""#/$defs/Nowhere""##, "unknown definition"),
        (r##""#/$defs/Actor""##, r#""other.json#/Actor""#, "#/$defs/"),
        (r#""x-wb-check": "single_line""#, r#""x-wb-check": "SingleLine""#, "snake_case"),
    ]);
}

#[test]
fn a_string_array_or_record_rule_the_model_dialect_states_is_refused_by_name() {
    assert_refused(&[
        (r#""pattern": "^\\d{4}(Z|[+-]\\d{2})$""#, r#""pattern": "\\d{4}$""#, "anchored"),
        (r#""pattern": "^\\d{4}(Z|[+-]\\d{2})$""#, r#""pattern": "^a/b$""#, "pattern"),
        (r#""pattern": "^\\d{4}(Z|[+-]\\d{2})$""#, r#""pattern": "^a\\$""#, "pattern"),
        (
            r#""x-wb-message": "a stamp is a year and a zone""#,
            r#""x-wb-message": "a stamp's""#,
            "x-wb-message",
        ),
        (r#""x-wb-matcher": "stamp","#, "", "pattern needs"),
        (
            r#""x-wb-minUtf16": 1,"#,
            r#""x-wb-minUtf16": 1, "minimum": 1,"#,
            "does not apply to a string",
        ),
        (
            r#""items": { "type": "string" }"#,
            r#""items": { "type": "object", "properties": {} }"#,
            "name an object in $defs",
        ),
        (
            r#""x-wb-any": true, "description": "Whatever.""#,
            r#""x-wb-any": false, "description": "Whatever.""#,
            "x-wb-any",
        ),
        (
            r#""additionalProperties": { "x-wb-any": true }"#,
            r#""additionalProperties": { "type": "string" }"#,
            "record",
        ),
        (
            r#""additionalProperties": true,
      "x-wb-unknownKeys": "keep""#,
            r#""additionalProperties": false,
      "x-wb-unknownKeys": "keep""#,
            "additionalProperties",
        ),
        (r#""x-wb-check": "bag_keys""#, r#""x-wb-check": "bag_keys", "x-wb-nope": 1"#, "x-wb-nope"),
    ]);
}

#[test]
fn a_cycle_between_definitions_is_refused() {
    let cyclic = model_mutated(
        r#""note": { "type": "string", "description": "Why." }"#,
        r##""note": { "$ref": "#/$defs/Doc", "description": "Why." }"##,
    );
    let errors = outputs(&cyclic).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("cycle")), "{errors:?}");
}

#[test]
fn a_kept_object_cannot_name_the_field_that_holds_its_extra_keys() {
    let text = MODEL.replace("note", "extra");
    let errors = outputs(&text).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("Event.extra") && e.contains("keep")), "{errors:?}");
}

#[test]
fn two_names_that_are_one_rust_field_are_refused() {
    let text = model_mutated(
        r#""extraBag": { "$ref""#,
        r#""extra_bag": { "x-wb-any": true, "description": "X." }, "extraBag": { "$ref""#,
    )
    .replacen(r#""anything", "extraBag"]"#, r#""anything", "extra_bag", "extraBag"]"#, 1);
    let errors = outputs(&text).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("both name")), "{errors:?}");
}

#[test]
fn the_check_modules_are_declared_beside_the_outputs_when_a_check_is_used() {
    for (from, to, expect) in [
        (
            r#""x-wb-checks": {
    "zod": "packages/p/src/contract-checks.ts",
    "rust": "crates/core/model/src/checks.rs"
  },"#,
            "",
            "x-wb-checks",
        ),
        (
            "packages/p/src/contract-checks.ts",
            "packages/q/src/contract-checks.ts",
            "x-wb-checks.zod",
        ),
        (
            "packages/p/src/contract-checks.ts",
            "packages/p/src/deep/contract-checks.ts",
            "x-wb-checks.zod",
        ),
        ("crates/core/model/src/checks.rs", "crates/core/other/src/checks.rs", "x-wb-checks.rust"),
        ("crates/core/model/src/checks.rs", "crates/core/model/src/checks.ts", "x-wb-checks.rust"),
    ] {
        let errors = outputs(&model_mutated(from, to)).unwrap_err();
        assert!(errors.iter().any(|e| e.contains(expect)), "{expect}: {errors:?}");
    }
}

#[test]
fn serde_emission_stays_to_closed_objects_of_numbers() {
    let errors = outputs(&model_mutated(r#""x-wb-rustSerde": false"#, r#""x-wb-rustSerde": true"#))
        .unwrap_err();
    assert!(errors.iter().any(|e| e.contains("x-wb-rustSerde")), "{errors:?}");
    let described = model_mutated(r#""x-wb-describe": false"#, r#""x-wb-describe": true"#);
    let errors = outputs(&described).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("optional")), "{errors:?}");
}

#[test]
fn any_value_and_record_types_need_the_model_crate_to_name_them() {
    let text = model_mutated("crates/core/model/src/generated", "crates/core/other/src/generated")
        .replace("crates/core/model/src/checks.rs", "crates/core/other/src/checks.rs");
    let errors = outputs(&text).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("whiteboard-model")), "{errors:?}");
}

#[test]
fn the_readonly_wrapper_on_exported_types_is_a_contract_choice() {
    let readonly = model_mutated(r#""x-wb-readonlyTypes": false"#, r#""x-wb-readonlyTypes": true"#);
    assert!(
        outputs(&readonly).unwrap()[0]
            .1
            .contains("export type Doc = Readonly<z.infer<typeof docSchema>>\n")
    );
}

#[test]
fn a_rust_float_literal_groups_long_digit_runs() {
    assert_eq!(emit::rust_float(0.0), "0.0");
    assert_eq!(emit::rust_float(-2.5), "-2.5");
    assert_eq!(emit::rust_float(1234.0), "1234.0");
    assert_eq!(emit::rust_float(100_000.0), "100_000.0");
    assert_eq!(emit::rust_float(0.123_456), "0.123_456");
    assert_eq!(emit::rust_float(1e21), "1e21");
}

#[test]
fn the_checked_in_contracts_generate_cleanly() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for path in contract_files(&root).unwrap() {
        let text = std::fs::read_to_string(&path).unwrap();
        outputs(&text).unwrap();
    }
}

/// The whole generator over the repository, as `cargo xtask codegen --check`
/// runs it: every output is the checked-in file, the caps reach both
/// languages, and the check reports them matched.
#[test]
fn the_repository_generates_exactly_its_checked_in_files() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let outputs = generate_all(&root).unwrap();
    for target in [
        "packages/core-wasm/src/generated/input-caps.ts",
        "crates/bindings/wasm/src/generated/input_caps.rs",
    ] {
        assert!(outputs.contains_key(target), "{target} is not generated");
    }
    for (target, content) in &outputs {
        let on_disk = std::fs::read_to_string(root.join(target)).unwrap();
        assert_eq!(&on_disk, content, "{target}");
    }
    let report = run(Mode::Check).unwrap();
    assert_eq!(report, [format!("codegen: {} generated files match their sources", outputs.len())]);
}

fn caps(krate: &str) -> crate::inputs::Caps {
    crate::inputs::Caps {
        krate: Some(krate.to_owned()),
        max_bytes: Some(262_144),
        max_depth: Some(2),
        max_millis: Some(5000),
        ..Default::default()
    }
}

fn caps_outputs(
    entries: &[(&str, crate::inputs::Caps)],
) -> Result<Vec<(String, String, bool)>, Vec<String>> {
    caps::generate(&entries.iter().map(|(k, c)| ((*k).to_owned(), c.clone())).collect())
}

#[test]
fn caps_reach_both_languages_for_the_wasm_crate_only() {
    let template = crate::inputs::Caps { template: true, ..caps("whiteboard-wasm") };
    let files = caps_outputs(&[
        ("whiteboard-wasm::spatial_edges::edge_route_layout", caps("whiteboard-wasm")),
        ("whiteboard-wasm::t::template_entry", template),
        ("whiteboard-det::utf16::len", caps("whiteboard-det")),
    ])
    .unwrap();
    let targets: Vec<(&str, bool)> = files.iter().map(|(t, _, r)| (t.as_str(), *r)).collect();
    assert_eq!(
        targets,
        [
            ("packages/core-wasm/src/generated/input-caps.ts", false),
            ("crates/bindings/wasm/src/generated/input_caps.rs", true),
        ]
    );
    let (ts, rust) = (&files[0].1, &files[1].1);
    assert!(ts.starts_with(&emit::header("crates/input-caps.json")));
    assert!(ts.contains(
        "export const EDGE_ROUTE_LAYOUT_CAPS = Object.freeze({\n  maxBytes: 262144,\n  maxDepth: 2,\n  maxMillis: 5000,\n} as const)\n"
    ));
    assert!(ts.contains("export type RefusalCode = 'input-too-large' | 'malformed'\n"));
    assert!(rust.contains(
        "pub const EDGE_ROUTE_LAYOUT: InputCaps = InputCaps { max_bytes: 262_144, max_depth: 2, max_millis: 5000, max_nodes: None };"
    ));
    for skipped in ["TEMPLATE_ENTRY", "LEN"] {
        assert!(!ts.contains(skipped) && !rust.contains(skipped), "{skipped} was emitted");
    }
}

#[test]
fn a_declared_max_nodes_reaches_both_languages() {
    let entry = crate::inputs::Caps { max_nodes: Some(100_000), ..caps("whiteboard-wasm") };
    let files = caps_outputs(&[("whiteboard-wasm::m::import", entry)]).unwrap();
    assert!(files[0].1.contains("  maxMillis: 5000,\n  maxNodes: 100000,\n} as const)"));
    assert!(files[1].1.contains("max_nodes: Some(100_000) };"));
}

#[test]
fn a_caps_entry_the_generator_cannot_name_or_fill_is_refused() {
    let no_depth = crate::inputs::Caps { max_depth: None, ..caps("whiteboard-wasm") };
    for (key, entry, expect) in [
        ("whiteboard-wasm::m::Route", caps("whiteboard-wasm"), "not a lowercase identifier"),
        ("whiteboard-wasm::m::9route", caps("whiteboard-wasm"), "not a lowercase identifier"),
        ("whiteboard-wasm::m::route", no_depth, "whiteboard-wasm::m::route: declares no maxDepth"),
    ] {
        let errors = caps_outputs(&[(key, entry)]).unwrap_err();
        assert!(errors.iter().any(|e| e.contains(expect)), "{key}: {errors:?}");
    }
    let long = format!("whiteboard-wasm::m::{}", "a".repeat(90));
    let errors = caps_outputs(&[(&long, caps("whiteboard-wasm"))]).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("biome's 100 columns")), "{errors:?}");
}

#[test]
fn a_rust_int_literal_groups_five_digits_or_more() {
    assert_eq!(caps::rust_int(0), "0");
    assert_eq!(caps::rust_int(5000), "5000");
    assert_eq!(caps::rust_int(10_000), "10_000");
    assert_eq!(caps::rust_int(262_144), "262_144");
    assert_eq!(caps::rust_int(1_048_576), "1_048_576");
}

#[test]
fn every_caps_target_is_a_generated_path_and_every_code_is_kebab_case() {
    for target in caps::TARGETS {
        assert!(target.ts.starts_with("packages/") && target.ts.contains("/src/generated/"));
        assert!(target.rust.starts_with("crates/") && target.rust.contains("/src/generated/"));
        assert!(!target.krate.is_empty());
    }
    for (code, meaning) in caps::REFUSAL_CODES {
        assert!(code.chars().all(|c| c.is_ascii_lowercase() || c == '-'), "{code}");
        assert!(!meaning.is_empty());
    }
}
