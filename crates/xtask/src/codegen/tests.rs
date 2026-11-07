use super::*;

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
            r#""type": "string", "description": "Left.""#,
        ),
        (r#""x-wb-unknownKeys": "refuse""#, r#""x-wb-unknownKeys": "strip""#),
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
        (r#"["x", "w"]"#, r#"["x"]"#, "every property must be required"),
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
    let text =
        mutated(r#""x": {"#, r#""type": {"#).replacen(r#"["x", "w"]"#, r#"["type", "w"]"#, 1);
    let errors = outputs(&text).unwrap_err();
    assert!(
        errors.iter().any(|e| e.contains("$defs.Rect.type: not a lowercase identifier")),
        "{errors:?}"
    );
}

#[test]
fn a_definition_or_contract_with_nothing_in_it_is_refused() {
    let empty_def = RECT
        .replacen(r#""w": { "type": "number", "minimum": 0, "description": "Width." },"#, "", 1)
        .replacen(r#""x": { "type": "number", "description": "Left." }"#, "", 1)
        .replacen(r#"["x", "w"]"#, "[]", 1);
    let errors = outputs(&empty_def).unwrap_err();
    assert!(errors.iter().any(|e| e.contains("declares no property")), "{errors:?}");
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
