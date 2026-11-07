//! `cargo xtask codegen [--check]`: Zod source and serde types from the
//! JSON Schema contracts under `contracts/` (ADR-0054 decision 8).
//!
//! Both halves come from this one emitter. typify, spiked for the Rust half,
//! enforced no numeric bound, counted `maxLength` in code points, ignored the
//! `x-wb-*` keywords and emitted fields alphabetically, so it could not hold
//! the dialect (ADR-0054, "The generator spike").
//!
//! The dialect is what the parse below accepts and nothing more: every
//! keyword is a typed field under `deny_unknown_fields`, so a construct the
//! emitter does not implement is refused by name instead of being dropped
//! from one language's output. It grows when a contract needs a construct,
//! with the construct's emission in both languages in the same change.
//!
//! Field order is the `required` array's, which is why every property must be
//! required: `serde_json`'s map is sorted, so `properties` carries no order.
//!
//! `--check` regenerates in memory and fails on any difference from the
//! checked-in output, and on a file under a `generated` directory that no
//! contract produces — so a hand edit to generated code fails either way.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::metadata;

const CONTRACTS_DIR: &str = "contracts";
const SCHEMA_SUFFIX: &str = ".schema.json";
const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";
/// The directories generated code lives in, as `<root>/*/<middle>/generated`
/// globs: `packages/<pkg>/src/generated` and `crates/<layer>/<crate>/src/generated`.
const GENERATED_ROOTS: &[(&str, usize)] = &[("packages", 1), ("crates", 2)];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Mode {
    Write,
    Check,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Contract {
    #[serde(rename = "$schema")]
    schema: String,
    title: String,
    description: String,
    #[serde(rename = "x-wb-emit")]
    pub(crate) emit: Emit,
    #[serde(rename = "$defs")]
    defs: BTreeMap<String, Def>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Emit {
    pub(crate) zod: String,
    pub(crate) rust: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Def {
    description: String,
    #[serde(rename = "type")]
    _type: ObjectType,
    properties: BTreeMap<String, Property>,
    required: Vec<String>,
    #[serde(rename = "additionalProperties")]
    additional_properties: bool,
    #[serde(rename = "x-wb-unknownKeys")]
    _unknown_keys: UnknownKeys,
}

#[derive(Debug, Deserialize)]
enum ObjectType {
    #[serde(rename = "object")]
    Object,
}

/// `strip` joins when a tolerant answer type needs it.
#[derive(Debug, Deserialize)]
enum UnknownKeys {
    #[serde(rename = "refuse")]
    Refuse,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Property {
    #[serde(rename = "type")]
    _type: NumberType,
    description: String,
    minimum: Option<f64>,
}

#[derive(Debug, Deserialize)]
enum NumberType {
    #[serde(rename = "number")]
    Number,
}

/// A contract as the emitters read it: definitions with their fields in
/// `required` order, every rule of the dialect already checked.
struct Checked<'a> {
    contract: &'a Contract,
    defs: Vec<CheckedDef<'a>>,
}

type CheckedDef<'a> = (&'a str, &'a Def, Vec<(&'a str, &'a Property)>);

pub(crate) fn parse(text: &str) -> Result<Contract, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

fn check(contract: &Contract) -> Result<Checked<'_>, Vec<String>> {
    let mut v = Vec::new();
    if contract.schema != DIALECT {
        v.push(format!("$schema: {} is not {DIALECT}", contract.schema));
    }
    for (what, text) in [("title", &contract.title), ("description", &contract.description)] {
        if let Err(e) = prose(text) {
            v.push(format!("{what}: {e}"));
        }
    }
    let mut defs = Vec::new();
    for (name, def) in &contract.defs {
        if !is_pascal(name) {
            v.push(format!("$defs.{name}: not a PascalCase name"));
        }
        if let Err(e) = prose(&def.description) {
            v.push(format!("$defs.{name}.description: {e}"));
        }
        if def.additional_properties {
            v.push(format!("$defs.{name}: additionalProperties must be false"));
        }
        let declared: BTreeSet<&str> = def.properties.keys().map(String::as_str).collect();
        let required: BTreeSet<&str> = def.required.iter().map(String::as_str).collect();
        if required.len() != def.required.len() {
            v.push(format!("$defs.{name}.required: lists a property twice"));
        }
        if declared != required {
            v.push(format!(
                "$defs.{name}: every property must be required (the dialect has no optional field yet)"
            ));
        }
        let mut fields = Vec::new();
        for field in &def.required {
            let Some(property) = def.properties.get(field) else { continue };
            if !is_field(field) {
                v.push(format!("$defs.{name}.{field}: not a lowercase identifier"));
            }
            if let Err(e) = prose(&property.description) {
                v.push(format!("$defs.{name}.{field}.description: {e}"));
            }
            if property.minimum.is_some_and(|m| !m.is_finite()) {
                v.push(format!("$defs.{name}.{field}.minimum: not finite"));
            }
            fields.push((field.as_str(), property));
        }
        defs.push((name.as_str(), def, fields));
    }
    if v.is_empty() { Ok(Checked { contract, defs }) } else { Err(v) }
}

/// Text that lands in a doc comment and a string literal in both languages.
fn prose(text: &str) -> Result<(), &'static str> {
    if text.trim().is_empty() {
        Err("empty")
    } else if text.contains(['\n', '\r', '\\', '\'', '"', '`']) || text.contains("*/") {
        Err("must be one line without quotes, backslashes, backticks or `*/`")
    } else {
        Ok(())
    }
}

fn is_pascal(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_uppercase())
        && name.chars().all(|c| c.is_ascii_alphanumeric())
}

fn is_field(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn header(comment: &str, source: &str) -> String {
    format!(
        "{comment} @generated by `cargo xtask codegen` from {source}. Edit the contract, not this file.\n"
    )
}

fn schema_name(def: &str) -> String {
    let mut chars = def.chars();
    let first = chars.next().map(|c| c.to_ascii_lowercase()).into_iter();
    first.chain(chars).collect::<String>() + "Schema"
}

/// A JavaScript number literal for a finite f64: `0`, `1.5`, `-2`.
fn js_number(n: f64) -> String {
    format!("{n}")
}

fn emit_zod(checked: &Checked<'_>, source: &str) -> String {
    let mut out = header("//", source);
    out.push_str("\nimport { z } from 'zod'\n");
    for (name, def, fields) in &checked.defs {
        let schema = schema_name(name);
        let _ = write!(
            out,
            "\n/** {} */\nexport const {schema} = z\n  .strictObject({{\n",
            def.description
        );
        for (field, property) in fields {
            let min =
                property.minimum.map(|m| format!(".min({})", js_number(m))).unwrap_or_default();
            let _ =
                writeln!(out, "    {field}: z.number(){min}.describe('{}'),", property.description);
        }
        let _ = write!(
            out,
            "  }})\n  .describe('{}')\nexport type {name} = Readonly<z.infer<typeof {schema}>>\n",
            def.description
        );
    }
    out
}

fn emit_rust(checked: &Checked<'_>, source: &str) -> String {
    let mut out = header("//", source);
    let _ = write!(
        out,
        "\n//! {}\n\nuse serde::{{Deserialize, Serialize}};\n",
        checked.contract.description
    );
    for (name, def, fields) in &checked.defs {
        let bounded = fields.iter().any(|(_, p)| p.minimum.is_some());
        let _ = write!(out, "\n/// {}\n", def.description);
        out.push_str("#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]\n");
        if bounded {
            let _ = writeln!(out, "#[serde(try_from = \"{name}Wire\")]");
        } else {
            out.push_str("#[serde(deny_unknown_fields)]\n");
        }
        let _ = writeln!(out, "pub struct {name} {{");
        for (field, property) in fields {
            let _ = writeln!(out, "    /// {}\n    pub {field}: f64,", property.description);
        }
        out.push_str("}\n");
        if bounded {
            emit_rust_bounds(&mut out, name, fields);
        }
    }
    out
}

/// The wire struct a bounded type deserializes through, and the `TryFrom`
/// that refuses a value outside its bounds.
fn emit_rust_bounds(out: &mut String, name: &str, fields: &[(&str, &Property)]) {
    let _ = write!(
        out,
        "\n/// {name} as it arrives, before its bounds are checked.\n\
         #[derive(Deserialize)]\n#[serde(deny_unknown_fields)]\nstruct {name}Wire {{\n"
    );
    for (field, _) in fields {
        let _ = writeln!(out, "    {field}: f64,");
    }
    let _ = write!(
        out,
        "}}\n\nimpl TryFrom<{name}Wire> for {name} {{\n    type Error = &'static str;\n\n    \
         fn try_from(wire: {name}Wire) -> Result<Self, Self::Error> {{\n"
    );
    for (field, property) in fields {
        if let Some(min) = property.minimum {
            let _ = write!(
                out,
                "        if wire.{field}.is_nan() || wire.{field} < {min:?} {{\n            \
                 return Err(\"{name}.{field} is below its minimum {}\");\n        }}\n",
                js_number(min)
            );
        }
    }
    let names: Vec<String> = fields.iter().map(|(f, _)| format!("{f}: wire.{f}")).collect();
    let _ = write!(out, "        Ok(Self {{ {} }})\n    }}\n}}\n", names.join(", "));
}

/// Every output a contract produces, as `(repo-relative path, content)`.
pub(crate) fn generate(
    contract: &Contract,
    source: &str,
) -> Result<Vec<(String, String)>, Vec<String>> {
    let checked = check(contract)
        .map_err(|v| v.into_iter().map(|e| format!("{source}: {e}")).collect::<Vec<_>>())?;
    Ok(vec![
        (contract.emit.zod.clone(), emit_zod(&checked, source)),
        (contract.emit.rust.clone(), emit_rust(&checked, source)),
    ])
}

fn contract_files(root: &Path) -> Result<Vec<PathBuf>, Vec<String>> {
    let mut found = Vec::new();
    let mut stack = vec![root.join(CONTRACTS_DIR)];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| vec![format!("cannot read {}: {e}", dir.display())])?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.to_string_lossy().ends_with(SCHEMA_SUFFIX) {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

/// Every file under a `generated` directory, repo-relative.
fn generated_files(root: &Path) -> BTreeSet<String> {
    let mut files = BTreeSet::new();
    for (top, depth) in GENERATED_ROOTS {
        let mut dirs = vec![root.join(top)];
        for _ in 0..*depth {
            dirs = dirs
                .iter()
                .filter_map(|d| std::fs::read_dir(d).ok())
                .flat_map(|entries| entries.flatten().map(|e| e.path()))
                .filter(|p| p.is_dir())
                .collect();
        }
        for dir in dirs {
            let Ok(entries) = std::fs::read_dir(dir.join("src").join("generated")) else {
                continue;
            };
            for entry in entries.flatten() {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    files.insert(rel.to_string_lossy().into_owned());
                }
            }
        }
    }
    files
}

/// Every contract's outputs, keyed by repo-relative target path.
fn generate_all(root: &Path) -> Result<BTreeMap<String, String>, Vec<String>> {
    let mut outputs = BTreeMap::new();
    let mut v = Vec::new();
    for path in contract_files(root)? {
        let source = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
        let text = std::fs::read_to_string(&path)
            .map_err(|e| vec![format!("cannot read {source}: {e}")])?;
        let files = parse(&text)
            .map_err(|e| vec![format!("{source}: {e}")])
            .and_then(|contract| generate(&contract, &source));
        match files {
            Ok(files) => {
                for (target, content) in files {
                    if outputs.insert(target.clone(), content).is_some() {
                        v.push(format!("{source}: {target} is also another contract's output"));
                    }
                }
            }
            Err(errors) => v.extend(errors),
        }
    }
    if v.is_empty() { Ok(outputs) } else { Err(v) }
}

pub(crate) fn run(mode: Mode) -> Result<Vec<String>, Vec<String>> {
    let root = metadata::load()?.workspace_root;
    let outputs = generate_all(&root)?;
    let mut v = Vec::new();
    for (target, content) in &outputs {
        let path = root.join(target);
        let current = std::fs::read_to_string(&path).ok();
        if current.as_deref() == Some(content.as_str()) {
            continue;
        }
        match mode {
            Mode::Check => v.push(format!(
                "{target}: not what its contract generates; run `cargo xtask codegen`"
            )),
            Mode::Write => {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)
                        .map_err(|e| vec![format!("cannot create {}: {e}", dir.display())])?;
                }
                std::fs::write(&path, content)
                    .map_err(|e| vec![format!("cannot write {target}: {e}")])?;
            }
        }
    }
    for stray in generated_files(&root) {
        if !outputs.contains_key(&stray) {
            v.push(format!("{stray}: under a generated directory, but no contract produces it"));
        }
    }
    if v.is_empty() {
        Ok(vec![format!("codegen: {} generated files match their contracts", outputs.len())])
    } else {
        Err(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECT: &str = r#"{
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "T",
      "description": "D.",
      "x-wb-emit": { "zod": "z.ts", "rust": "r.rs" },
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
        generate(&parse(text).map_err(|e| vec![e])?, "c.schema.json")
    }

    #[test]
    fn fields_follow_required_order_and_bounds_reach_both_languages() {
        let files = outputs(RECT).unwrap();
        let (zod, rust) = (&files[0].1, &files[1].1);
        assert!(
            zod.find("    x: z.number()").unwrap() < zod.find("    w: z.number().min(0)").unwrap()
        );
        assert!(rust.contains("#[serde(try_from = \"RectWire\")]"));
        assert!(rust.contains("if wire.w.is_nan() || wire.w < 0.0 {"));
        assert!(!rust.contains("wire.x.is_nan()"));
    }

    #[test]
    fn a_construct_outside_the_dialect_is_refused_by_name() {
        for (from, to) in [
            (r#""minimum": 0,"#, r#""maxLength": 4,"#),
            (
                r#""type": "number", "description": "Left.""#,
                r#""type": "string", "description": "Left.""#,
            ),
            (r#""x-wb-unknownKeys": "refuse""#, r#""x-wb-unknownKeys": "strip""#),
        ] {
            let text = RECT.replacen(from, to, 1);
            assert_ne!(text, RECT, "{from} did not match");
            assert!(parse(&text).is_err(), "{to} was accepted");
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
        ] {
            let text = RECT.replacen(from, to, 1);
            assert_ne!(text, RECT, "{from} did not match");
            let errors = outputs(&text).unwrap_err();
            assert!(errors.iter().any(|e| e.contains(expect)), "{expect}: {errors:?}");
        }
    }

    #[test]
    fn the_checked_in_contracts_generate_cleanly() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for path in contract_files(&root).unwrap() {
            let text = std::fs::read_to_string(&path).unwrap();
            outputs(&text).unwrap();
        }
    }
}
