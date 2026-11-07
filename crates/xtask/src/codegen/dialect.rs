//! The restricted dialect (ADR-0054 decision 8, QR-7) as a typed parse plus
//! the rules a parse cannot state.
//!
//! Every keyword is a typed field under `deny_unknown_fields`, so a construct
//! the emitters do not implement is refused by name rather than dropped from
//! one language's output. What is accepted today: closed objects of required
//! numbers, each with an optional inclusive `minimum`. It grows when a
//! contract needs a construct, with that construct's emission in both
//! languages in the same change.
//!
//! Field order is the `required` array's, which is why every property must be
//! required: a JSON object carries no order a map keeps.

use std::collections::{BTreeMap, BTreeSet};
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, Visitor};

const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";

/// Identifiers the generated Rust or TypeScript already uses, so a definition
/// named one of them would shadow it.
const RESERVED_TYPES: &[&str] = &[
    "Box",
    "Clone",
    "Copy",
    "Debug",
    "Deserialize",
    "Deserializer",
    "Err",
    "MapAccess",
    "MapAccessDeserializer",
    "MapOnly",
    "None",
    "Ok",
    "Option",
    "PartialEq",
    "PhantomData",
    "Readonly",
    "Result",
    "Self",
    "Serialize",
    "Some",
    "String",
    "Vec",
    "Visitor",
];

/// Rust's strict and reserved keywords: a field so named does not compile.
const RUST_KEYWORDS: &[&str] = &[
    "abstract", "as", "async", "await", "become", "box", "break", "const", "continue", "crate",
    "do", "dyn", "else", "enum", "extern", "false", "final", "fn", "for", "gen", "if", "impl",
    "in", "let", "loop", "macro", "match", "mod", "move", "mut", "override", "priv", "pub", "ref",
    "return", "self", "static", "struct", "super", "trait", "true", "try", "type", "typeof",
    "unsafe", "unsized", "use", "virtual", "where", "while", "yield",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Contract {
    #[serde(rename = "$schema")]
    schema: String,
    title: String,
    pub(super) description: String,
    #[serde(rename = "x-wb-emit")]
    pub(super) emit: Emit,
    #[serde(rename = "$defs")]
    defs: UniqueMap<Def>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Emit {
    pub(super) zod: String,
    pub(super) rust: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Def {
    pub(super) description: String,
    #[serde(rename = "type")]
    _type: ObjectType,
    properties: UniqueMap<Property>,
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
pub(super) struct Property {
    #[serde(rename = "type")]
    _type: NumberType,
    pub(super) description: String,
    /// Absent is no bound; `null` is refused rather than read as absent.
    #[serde(default, deserialize_with = "some_number")]
    pub(super) minimum: Option<f64>,
}

#[derive(Debug, Deserialize)]
enum NumberType {
    #[serde(rename = "number")]
    Number,
}

fn some_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    f64::deserialize(deserializer).map(Some)
}

/// A JSON object read into a map that refuses a repeated key, where a plain
/// map keeps the last one silently.
#[derive(Debug)]
struct UniqueMap<V>(BTreeMap<String, V>);

impl<'de, V: Deserialize<'de>> Deserialize<'de> for UniqueMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(UniqueVisitor(PhantomData))
    }
}

struct UniqueVisitor<V>(PhantomData<V>);

impl<'de, V: Deserialize<'de>> Visitor<'de> for UniqueVisitor<V> {
    type Value = UniqueMap<V>;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("an object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut out = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, V>()? {
            if out.contains_key(&key) {
                return Err(serde::de::Error::custom(format!("duplicate key `{key}`")));
            }
            out.insert(key, value);
        }
        Ok(UniqueMap(out))
    }
}

/// A contract as the emitters read it: definitions with their fields in
/// `required` order, every rule of the dialect already checked.
pub(super) struct Checked<'a> {
    pub(super) contract: &'a Contract,
    pub(super) defs: Vec<CheckedDef<'a>>,
}

pub(super) struct CheckedDef<'a> {
    pub(super) name: &'a str,
    pub(super) def: &'a Def,
    pub(super) fields: Vec<(&'a str, &'a Property)>,
}

pub(crate) fn parse(text: &str) -> Result<Contract, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

pub(super) fn check(contract: &Contract) -> Result<Checked<'_>, Vec<String>> {
    let mut v = Vec::new();
    if contract.schema != DIALECT {
        v.push(format!("$schema: {} is not {DIALECT}", contract.schema));
    }
    for (what, text) in [("title", &contract.title), ("description", &contract.description)] {
        if let Err(e) = prose(text) {
            v.push(format!("{what}: {e}"));
        }
    }
    if let Err(e) = target(&contract.emit.zod, TargetKind::Zod) {
        v.push(format!("x-wb-emit.zod: {e}"));
    }
    if let Err(e) = target(&contract.emit.rust, TargetKind::Rust) {
        v.push(format!("x-wb-emit.rust: {e}"));
    }
    if contract.defs.0.is_empty() {
        v.push("$defs: declares no type".to_owned());
    }
    let defs = contract.defs.0.iter().map(|(name, def)| check_def(name, def, &mut v)).collect();
    if v.is_empty() { Ok(Checked { contract, defs }) } else { Err(v) }
}

fn check_def<'a>(name: &'a str, def: &'a Def, v: &mut Vec<String>) -> CheckedDef<'a> {
    if !is_pascal(name) {
        v.push(format!("$defs.{name}: not a PascalCase name"));
    }
    if RESERVED_TYPES.contains(&name) || name.ends_with("Wire") {
        v.push(format!("$defs.{name}: a name the generated code already uses"));
    }
    if let Err(e) = prose(&def.description) {
        v.push(format!("$defs.{name}.description: {e}"));
    }
    if def.additional_properties {
        v.push(format!("$defs.{name}: additionalProperties must be false"));
    }
    let declared: BTreeSet<&str> = def.properties.0.keys().map(String::as_str).collect();
    let required: BTreeSet<&str> = def.required.iter().map(String::as_str).collect();
    if required.len() != def.required.len() {
        v.push(format!("$defs.{name}.required: lists a property twice"));
    }
    if declared != required {
        v.push(format!(
            "$defs.{name}: every property must be required (the dialect has no optional field yet)"
        ));
    }
    if declared.is_empty() {
        v.push(format!("$defs.{name}: declares no property"));
    }
    let mut fields = Vec::new();
    for field in &def.required {
        let Some(property) = def.properties.0.get(field) else { continue };
        if !is_field(field) || RUST_KEYWORDS.contains(&field.as_str()) {
            v.push(format!("$defs.{name}.{field}: not a lowercase identifier both languages take"));
        }
        if let Err(e) = prose(&property.description) {
            v.push(format!("$defs.{name}.{field}.description: {e}"));
        }
        if property.minimum.is_some_and(|m| !m.is_finite()) {
            v.push(format!("$defs.{name}.{field}.minimum: not finite"));
        }
        fields.push((field.as_str(), property));
    }
    CheckedDef { name, def, fields }
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

#[derive(Clone, Copy)]
enum TargetKind {
    Zod,
    Rust,
}

/// A target lands only where the stray-file scan looks and the Rust job's
/// path scope reaches: `packages/<pkg>/src/generated/<stem>.zod.ts` and
/// `crates/<layer>/<crate>/src/generated/<stem>.rs`.
fn target(path: &str, kind: TargetKind) -> Result<(), String> {
    let parts: Vec<&str> = path.split('/').collect();
    let (root, dirs, suffix) = match kind {
        TargetKind::Zod => ("packages", 1, ".zod.ts"),
        TargetKind::Rust => ("crates", 2, ".rs"),
    };
    let shape_ok = parts.len() == dirs + 4
        && parts.first() == Some(&root)
        && parts.get(1..=dirs).is_some_and(|segs| segs.iter().all(|s| is_segment(s)))
        && parts.get(dirs + 1) == Some(&"src")
        && parts.get(dirs + 2) == Some(&"generated")
        && parts.last().and_then(|f| f.strip_suffix(suffix)).is_some_and(is_segment);
    if shape_ok {
        Ok(())
    } else {
        Err(format!("{path} is not {root}/{}src/generated/<name>{suffix}", "<dir>/".repeat(dirs)))
    }
}

fn is_segment(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn is_pascal(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_uppercase())
        && name.chars().all(|c| c.is_ascii_alphanumeric())
}

fn is_field(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}
