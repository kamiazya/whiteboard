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
