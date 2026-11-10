//! A union chosen by a discriminator property, and a definition whose Zod half
//! is hand-written: what each becomes in both languages, and every rule that
//! refuses one.

use super::plain::{IN_MODEL, plain};
use super::shapes::{emitted, refused, swapped};
use super::*;

const ARM_A: &str = r#""ArmA": {
      "description": "The a arm.",
      "type": "object",
      "properties": {
        "kind": { "type": "string", "const": "a", "description": "Always a." },
        "id": { "type": "string", "description": "An id." }
      },
      "required": ["kind", "id"],
      "x-wb-order": ["kind", "id"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }"#;

const ARM_B: &str = r#""ArmB": {
      "description": "The b arm.",
      "type": "object",
      "properties": {
        "kind": { "type": "string", "const": "b", "description": "Always b." },
        "at": { "type": "number", "description": "Where." }
      },
      "required": ["kind", "at"],
      "x-wb-order": ["kind", "at"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }"#;

const EITHER: &str = r##""Either": {
      "description": "An a or a b.",
      "oneOf": [{ "$ref": "#/$defs/ArmA" }, { "$ref": "#/$defs/ArmB" }],
      "discriminator": { "propertyName": "kind" },
      "x-wb-registered": true
    }"##;

fn defs(either: &str) -> String {
    format!("{either}, {ARM_A}, {ARM_B}")
}

#[test]
fn a_discriminated_union_is_zods_after_its_arms_and_rusts_union_enum() {
    let (zod, rust) = emitted(&defs(EITHER));
    assert!(
        zod.contains(
            "export const eitherSchema = z.discriminatedUnion('kind', [armASchema, armBSchema])\n"
        ),
        "{zod}"
    );
    let at = |name: &str| zod.find(&format!("export const {name}Schema")).unwrap();
    assert!(at("armA") < at("either") && at("armB") < at("either"), "{zod}");
    assert!(zod.contains("z.globalRegistry.add(eitherSchema, { id: 'Either' })"), "{zod}");
    assert!(rust.contains("pub enum Either {"), "{rust}");
    assert!(rust.contains("    ArmA(ArmA),") && rust.contains("    ArmB(ArmB),"), "{rust}");
    assert!(rust.contains("Self::ArmA(ArmA::default())"), "{rust}");
}

#[test]
fn a_discriminated_union_rule_the_dialect_states_is_refused_by_name() {
    let one = r##""oneOf": [{ "$ref": "#/$defs/ArmA" }, { "$ref": "#/$defs/ArmB" }]"##;
    for (to, expect) in [
        (r##""oneOf": [{ "$ref": "#/$defs/ArmA" }]"##, "at least two members"),
        (r##""oneOf": [{ "$ref": "#/$defs/ArmA" }, { "type": "string" }]"##, "a union member is"),
        (
            r##""oneOf": [{ "$ref": "#/$defs/ArmA" }, { "$ref": "#/$defs/ArmA" }]"##,
            "`ArmA` is already a member",
        ),
        (
            r##""oneOf": [{ "$ref": "#/$defs/ArmA" }, { "$ref": "#/$defs/Nowhere" }]"##,
            "unknown definition `Nowhere`",
        ),
        (r##""type": "string", "oneOf": [{ "$ref": "#/$defs/ArmA" }]"##, "carries no `type`"),
    ] {
        refused(&defs(&swapped(EITHER, one, to)), expect);
    }
    refused(
        &defs(&swapped(EITHER, r#""discriminator": { "propertyName": "kind" },"#, "")),
        "a oneOf needs its discriminator",
    );
    refused(
        &defs(&swapped(EITHER, r#""oneOf""#, r#""anyOf""#)),
        "`discriminator` does not apply to a union",
    );
    refused(
        &defs(&swapped(
            EITHER,
            r#""discriminator": { "propertyName": "kind" },"#,
            r#""discriminator": { "propertyName": "kind" }, "anyOf": [],"#,
        )),
        "`anyOf` does not apply to a discriminated union",
    );
    let bare = r#""N": { "description": "N.", "type": "number", "discriminator": { "propertyName": "kind" } }"#;
    refused(bare, "`discriminator` does not apply to a number");
}

#[test]
fn every_arm_names_the_discriminator_as_its_own_distinct_constant() {
    let other = swapped(&defs(EITHER), r#""propertyName": "kind""#, r#""propertyName": "type""#);
    refused(&other, "`ArmA` has no constant property `type`");
    let no_const = swapped(
        ARM_B,
        r#""kind": { "type": "string", "const": "b", "description": "Always b." }"#,
        r#""kind": { "type": "string", "description": "Kind." }"#,
    );
    refused(&format!("{EITHER}, {ARM_A}, {no_const}"), "`ArmB` has no constant property `kind`");
    let same = swapped(ARM_B, r#""const": "b""#, r#""const": "a""#);
    refused(&format!("{EITHER}, {ARM_A}, {same}"), "`ArmB` and `ArmA` both write `kind` as `a`");
    let string = r#""ArmB": { "description": "B.", "type": "string" }"#;
    refused(&format!("{EITHER}, {ARM_A}, {string}"), "`ArmB` is not an object");
}

const EXTERNAL_ID: &str = r#""Id": {
      "description": "An id.",
      "type": "string",
      "x-wb-minUtf16": 1,
      "x-wb-external": "../ids.js"
    }"#;

const USER: &str = r##""User": {
      "description": "A user.",
      "type": "object",
      "properties": { "id": { "$ref": "#/$defs/Id", "description": "Who." } },
      "required": ["id"],
      "x-wb-order": ["id"],
      "additionalProperties": false,
      "x-wb-unknownKeys": "refuse"
    }"##;

fn external(defs: &str) -> (String, String) {
    let mut files = outputs(&plain(defs, IN_MODEL, true)).unwrap();
    let rust = files.remove(1).1;
    (files.remove(0).1, rust)
}

#[test]
fn an_external_definition_is_imported_by_zod_and_still_a_rust_type() {
    let (zod, rust) = external(&format!("{EXTERNAL_ID}, {USER}"));
    assert!(zod.contains("import { idSchema } from '../ids.js'\n"), "{zod}");
    assert!(!zod.contains("export const idSchema"), "{zod}");
    assert!(!zod.contains("export type Id"), "{zod}");
    assert!(zod.contains("\n  id: idSchema,\n"), "{zod}");
    assert!(rust.contains("pub type Id = String;"), "{rust}");
}

#[test]
fn imports_are_grouped_by_module_and_ordered_the_way_biome_orders_them() {
    let second = swapped(EXTERNAL_ID, r#""Id""#, r#""Name""#);
    let third = swapped(&swapped(EXTERNAL_ID, r#""Id""#, r#""Zed""#), "../ids.js", "./facets.js");
    let elsewhere =
        swapped(&swapped(EXTERNAL_ID, r#""Id""#, r#""Alpha""#), "../ids.js", "../alpha.js");
    let checked =
        r#""Bad": { "description": "B.", "type": "string", "x-wb-check": "single_line" }"#;
    let (zod, _) =
        external(&format!("{EXTERNAL_ID}, {second}, {third}, {elsewhere}, {checked}, {USER}"));
    let head: Vec<&str> = zod.lines().filter(|l| l.starts_with("import")).collect();
    assert_eq!(
        head,
        [
            "import { z } from 'zod'",
            "import { alphaSchema } from '../alpha.js'",
            "import { singleLine } from '../contract-checks.js'",
            "import { idSchema, nameSchema } from '../ids.js'",
            "import { zedSchema } from './facets.js'",
        ]
    );
}

#[test]
fn an_external_definitions_check_is_the_rust_halfs_alone() {
    let checked = r#""Actor": { "description": "A.", "type": "string", "x-wb-check": "single_line", "x-wb-external": "../trust.js" }"#;
    let parsed = dialect::parse(&plain(checked, IN_MODEL, true)).unwrap();
    let c = dialect::check(&parsed).unwrap();
    assert!(c.zod_checks.is_empty(), "{:?}", c.zod_checks);
    assert_eq!(c.rust_names, ["single_line"]);
    let (zod, rust) = external(checked);
    assert!(!zod.contains("singleLine"), "{zod}");
    assert!(rust.contains("Checked by `crate::checks::single_line`."), "{rust}");
}

#[test]
fn an_external_rule_the_dialect_states_is_refused_by_name() {
    for (to, expect) in [
        ("ids.js", "must be a relative `.js` import"),
        ("../ids.ts", "must be a relative `.js` import"),
        ("../Ids.js", "must be a relative `.js` import"),
        ("../ids/../x.js", "must be a relative `.js` import"),
        ("/ids.js", "must be a relative `.js` import"),
    ] {
        refused(&swapped(EXTERNAL_ID, "../ids.js", to), expect);
    }
    refused(
        &swapped(EXTERNAL_ID, r#""x-wb-external""#, r#""x-wb-registered": true, "x-wb-external""#),
        "is not implemented with x-wb-external",
    );
    let property = swapped(USER, r#"{ "$ref": "#, r#"{ "x-wb-external": "../ids.js", "$ref": "#);
    refused(&format!("{EXTERNAL_ID}, {property}"), "x-wb-external belongs on a definition");
    let described = plain(EXTERNAL_ID, IN_MODEL, false)
        .replace(r#""x-wb-describe": false"#, r#""x-wb-describe": true"#);
    let errors = outputs(&described).unwrap_err();
    assert!(
        errors.iter().any(|e| e.contains("x-wb-external is not implemented with x-wb-describe")),
        "{errors:?}"
    );
}

#[test]
fn an_import_line_wider_than_biomes_width_breaks_one_name_to_a_line() {
    let external = |letter: char, letters: usize| {
        let name = format!("{letter}{}", "a".repeat(letters - 1));
        format!(
            r#""{name}": {{ "description": "N.", "type": "string", "x-wb-external": "../x.js" }}"#
        )
    };
    let imports = |second: usize| {
        let defs = format!("{}, {}", external('A', 30), external('B', second));
        let zod = outputs(&plain(&defs, IN_MODEL, false)).unwrap().remove(0).1;
        zod.lines()
            .skip_while(|l| !l.starts_with("import {"))
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
    };
    let flat = imports(30);
    assert!(flat.starts_with("import { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaSchema, b"), "{flat}");
    assert!(flat.lines().next().is_some_and(|l| l.chars().count() == 100), "{flat}");
    let broken = imports(31);
    let mut lines = broken.lines();
    assert_eq!(lines.next(), Some("import {"), "{broken}");
    assert_eq!(lines.next(), Some(format!("  a{}Schema,", "a".repeat(29)).as_str()), "{broken}");
    assert_eq!(lines.next(), Some(format!("  b{}Schema,", "a".repeat(30)).as_str()), "{broken}");
    assert_eq!(lines.next(), Some("} from '../x.js'"), "{broken}");
}
