//! The restricted dialect (ADR-0054 decision 8, QR-7) as a typed parse plus
//! the rules a parse cannot state.
//!
//! Every keyword is a typed field under `deny_unknown_fields`, so a construct
//! the emitters do not implement is refused by name rather than dropped from
//! one language's output. What is accepted: numbers with an inclusive
//! `minimum`; strings with a UTF-16 minimum, a pattern and a named check;
//! arrays, `$ref`s to a definition, any-values and records of them; and
//! objects whose unknown keys are refused, stripped or kept, with optional
//! fields. It grows when a contract needs a construct, with that construct's
//! emission in both languages in the same change.
//!
//! Field order is `x-wb-order`, which must list every property once: a JSON
//! object carries no order a map keeps.

use std::collections::{BTreeMap, BTreeSet};

pub(super) use super::parse::Unknown;
use super::parse::{Additional, Kind, Node};
pub(crate) use super::parse::{Contract, parse};

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
    "Map",
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
    "Value",
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

/// A schema once its form is known and its keywords checked.
pub(super) enum Ty<'a> {
    Number { min: Option<f64> },
    Str { min_utf16: Option<u32>, pattern: Option<Pattern<'a>>, check: Option<&'a str> },
    Array(Box<Ty<'a>>),
    Ref(&'a str),
    Any,
    Record { check: Option<&'a str> },
    Object(Object<'a>),
}

/// A string's `pattern`, the message Zod answers with and the Rust matcher
/// that stands for it (the Rust half has no regex engine).
pub(super) struct Pattern<'a> {
    pub(super) source: &'a str,
    pub(super) message: &'a str,
    pub(super) matcher: &'a str,
}

pub(super) struct Object<'a> {
    pub(super) fields: Vec<Field<'a>>,
    pub(super) unknown: Unknown,
}

pub(super) struct Field<'a> {
    /// The JSON key, which is also the Zod key.
    pub(super) name: &'a str,
    /// The Rust field: `snake_case`, a raw identifier where a keyword.
    pub(super) rust: String,
    pub(super) description: &'a str,
    pub(super) ty: Ty<'a>,
    pub(super) optional: bool,
}

/// A contract as the emitters read it: definitions in dependency order, every
/// rule of the dialect already checked.
pub(super) struct Checked<'a> {
    pub(super) contract: &'a Contract,
    pub(super) defs: Vec<CheckedDef<'a>>,
    /// Named checks the Zod half imports, sorted, in the contract's `snake_case`.
    pub(super) zod_checks: Vec<&'a str>,
    /// Named checks and matchers the Rust half leans on, sorted.
    pub(super) rust_names: Vec<&'a str>,
}

pub(super) struct CheckedDef<'a> {
    pub(super) name: &'a str,
    pub(super) description: &'a str,
    pub(super) ty: Ty<'a>,
}

impl<'a> Ty<'a> {
    fn refs(&self, out: &mut Vec<&'a str>) {
        match self {
            Ty::Ref(name) => out.push(name),
            Ty::Array(item) => item.refs(out),
            Ty::Object(object) => object.fields.iter().for_each(|f| f.ty.refs(out)),
            _ => {}
        }
    }

    fn names(&self, zod: &mut Vec<&'a str>, rust: &mut Vec<&'a str>) {
        match self {
            Ty::Str { pattern, check, .. } => {
                zod.extend(check);
                rust.extend(check);
                rust.extend(pattern.as_ref().map(|p| p.matcher));
            }
            Ty::Record { check } => {
                zod.extend(check);
                rust.extend(check);
            }
            Ty::Array(item) => item.names(zod, rust),
            Ty::Object(object) => object.fields.iter().for_each(|f| f.ty.names(zod, rust)),
            _ => {}
        }
    }

    /// Whether the Rust type reaches for the model crate's `Value` or `Map`.
    pub(super) fn uses(&self, wanted: Uses) -> bool {
        match self {
            Ty::Any => wanted == Uses::Value,
            Ty::Record { .. } => wanted == Uses::Map,
            Ty::Array(item) => item.uses(wanted),
            Ty::Object(object) => {
                (wanted == Uses::Map && object.unknown == Unknown::Keep)
                    || object.fields.iter().any(|f| f.ty.uses(wanted))
            }
            _ => false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Uses {
    Value,
    Map,
}

pub(super) fn check(contract: &Contract) -> Result<Checked<'_>, Vec<String>> {
    let mut v = Vec::new();
    check_header(contract, &mut v);
    if contract.defs.0.is_empty() {
        v.push("$defs: declares no type".to_owned());
    }
    let mut lowered = BTreeMap::new();
    for (name, node) in &contract.defs.0 {
        if let Some(def) = check_def(contract, name, node, &mut v) {
            lowered.insert(name.as_str(), def);
        }
    }
    let known: BTreeSet<&str> = contract.defs.0.keys().map(String::as_str).collect();
    let defs = in_dependency_order(lowered, &known, &mut v);
    let (mut zod_checks, mut rust_names) = (Vec::new(), Vec::new());
    for def in &defs {
        def.ty.names(&mut zod_checks, &mut rust_names);
    }
    for name in zod_checks.iter().chain(&rust_names) {
        if !is_snake(name) {
            v.push(format!("check `{name}`: must be snake_case"));
        }
    }
    if (!zod_checks.is_empty() || !rust_names.is_empty()) && contract.checks.is_none() {
        v.push("x-wb-checks: a named check or matcher needs the modules that hold it".to_owned());
    }
    if !contract.rust_serde
        && defs.iter().any(|d| d.ty.uses(Uses::Value) || d.ty.uses(Uses::Map))
        && !contract.emit.rust.starts_with("crates/core/model/src/")
    {
        v.push(
            "x-wb-emit.rust: `Value` and `Map` are whiteboard-model's, so it must emit there"
                .to_owned(),
        );
    }
    for set in [&mut zod_checks, &mut rust_names] {
        set.sort_unstable();
        set.dedup();
    }
    if v.is_empty() { Ok(Checked { contract, defs, zod_checks, rust_names }) } else { Err(v) }
}

/// The contract's own keywords: dialect, prose, output targets and check modules.
fn check_header(contract: &Contract, v: &mut Vec<String>) {
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
    if let Some(modules) = &contract.checks {
        if let Err(e) = sibling(&modules.zod, &contract.emit.zod, TargetKind::Zod) {
            v.push(format!("x-wb-checks.zod: {e}"));
        }
        if let Err(e) = sibling(&modules.rust, &contract.emit.rust, TargetKind::Rust) {
            v.push(format!("x-wb-checks.rust: {e}"));
        }
    }
}

fn check_def<'a>(
    contract: &Contract,
    name: &'a str,
    node: &'a Node,
    v: &mut Vec<String>,
) -> Option<CheckedDef<'a>> {
    if !is_pascal(name) {
        v.push(format!("$defs.{name}: not a PascalCase name"));
    }
    if RESERVED_TYPES.contains(&name) || name.ends_with("Wire") {
        v.push(format!("$defs.{name}: a name the generated code already uses"));
    }
    let at = format!("$defs.{name}");
    let description = described(node, &at, v);
    let ty = lower(node, &at, true, v)?;
    if contract.rust_serde && !serde_shape(&ty) {
        v.push(format!(
            "{at}: x-wb-rustSerde emits closed objects of required numbers only; \
             set it to false for this construct"
        ));
    }
    if contract.describe
        && let Ty::Object(object) = &ty
        && object.fields.iter().any(|f| f.optional)
    {
        v.push(format!("{at}: an optional field is not implemented with x-wb-describe"));
    }
    Some(CheckedDef { name, description: description?, ty })
}

fn serde_shape(ty: &Ty<'_>) -> bool {
    matches!(
        ty,
        Ty::Object(object) if object.unknown == Unknown::Refuse
            && object.fields.iter().all(|f| {
                !f.optional && matches!(f.ty, Ty::Number { .. }) && f.rust == f.name
            })
    )
}

/// The node's description, which every definition and property carries: it is
/// the doc comment in Rust and, where the contract asks, the `.describe()`.
fn described<'a>(node: &'a Node, at: &str, v: &mut Vec<String>) -> Option<&'a str> {
    let Some(text) = &node.description else {
        v.push(format!("{at}.description: missing"));
        return None;
    };
    if let Err(e) = prose(text) {
        v.push(format!("{at}.description: {e}"));
    }
    Some(text)
}

/// Reports every keyword of `node` outside `allowed`; false if any.
fn only(node: &Node, allowed: &[&str], form: &str, at: &str, v: &mut Vec<String>) -> bool {
    let mut ok = true;
    for keyword in node.keywords() {
        if !allowed.contains(&keyword) {
            v.push(format!("{at}: `{keyword}` does not apply to {form}"));
            ok = false;
        }
    }
    ok
}

const DEFS_PREFIX: &str = "#/$defs/";

/// `top` is a definition: only there may an object be written out, so a
/// nested one is named and referenced and its type has a name in both languages.
fn lower<'a>(node: &'a Node, at: &str, top: bool, v: &mut Vec<String>) -> Option<Ty<'a>> {
    if let Some(reference) = &node.reference {
        only(node, &["$ref"], "a reference", at, v);
        if node.kind.is_some() {
            v.push(format!("{at}: a `$ref` carries no `type`"));
        }
        let Some(name) = reference.strip_prefix(DEFS_PREFIX) else {
            v.push(format!("{at}.$ref: {reference} is not a `{DEFS_PREFIX}<name>` reference"));
            return None;
        };
        return Some(Ty::Ref(name));
    }
    if let Some(any) = node.any {
        only(node, &["x-wb-any"], "an any-value", at, v);
        if !any || node.kind.is_some() {
            v.push(format!("{at}: x-wb-any is `true` and carries no `type`"));
        }
        return Some(Ty::Any);
    }
    match node.kind {
        None => {
            v.push(format!("{at}: declares no `type`, `$ref` or `x-wb-any`"));
            None
        }
        Some(Kind::Number) => {
            only(node, &["minimum"], "a number", at, v);
            if node.minimum.is_some_and(|m| !m.is_finite()) {
                v.push(format!("{at}.minimum: not finite"));
            }
            Some(Ty::Number { min: node.minimum })
        }
        Some(Kind::String) => Some(lower_string(node, at, v)),
        Some(Kind::Array) => {
            only(node, &["items"], "an array", at, v);
            let Some(items) = &node.items else {
                v.push(format!("{at}: an array declares its `items`"));
                return None;
            };
            Some(Ty::Array(Box::new(lower(items, &format!("{at}.items"), false, v)?)))
        }
        Some(Kind::Object) if node.properties.is_some() => lower_object(node, at, top, v),
        Some(Kind::Object) => lower_record(node, at, v),
    }
}

fn lower_string<'a>(node: &'a Node, at: &str, v: &mut Vec<String>) -> Ty<'a> {
    only(
        node,
        &["x-wb-minUtf16", "pattern", "x-wb-matcher", "x-wb-message", "x-wb-check"],
        "a string",
        at,
        v,
    );
    let pattern = match (&node.pattern, &node.matcher, &node.message) {
        (None, None, None) => None,
        (Some(source), Some(matcher), Some(message)) => {
            if let Err(e) = pattern_source(source) {
                v.push(format!("{at}.pattern: {e}"));
            }
            if let Err(e) = prose(message) {
                v.push(format!("{at}.x-wb-message: {e}"));
            }
            Some(Pattern { source, message, matcher })
        }
        _ => {
            v.push(format!(
                "{at}: a pattern needs its x-wb-matcher and x-wb-message, and they need it"
            ));
            None
        }
    };
    Ty::Str { min_utf16: node.min_utf16, pattern, check: node.check.as_deref() }
}

fn lower_record<'a>(node: &'a Node, at: &str, v: &mut Vec<String>) -> Option<Ty<'a>> {
    only(node, &["additionalProperties", "x-wb-check"], "a record", at, v);
    match &node.additional {
        Some(Additional::Schema(value))
            if value.any == Some(true)
                && value.kind.is_none()
                && value.keywords() == ["x-wb-any"] =>
        {
            Some(Ty::Record { check: node.check.as_deref() })
        }
        _ => {
            v.push(format!(
                "{at}: a record is `additionalProperties: {{ \"x-wb-any\": true }}`; \
                 any other value type is not implemented"
            ));
            None
        }
    }
}

fn lower_object<'a>(node: &'a Node, at: &str, top: bool, v: &mut Vec<String>) -> Option<Ty<'a>> {
    only(
        node,
        &["properties", "required", "x-wb-order", "additionalProperties", "x-wb-unknownKeys"],
        "an object",
        at,
        v,
    );
    if !top {
        v.push(format!("{at}: name an object in $defs and `$ref` it"));
        return None;
    }
    let properties = &node.properties.as_ref()?.0;
    if properties.is_empty() {
        v.push(format!("{at}: declares no property"));
    }
    let Some(unknown) = node.unknown_keys else {
        v.push(format!("{at}: x-wb-unknownKeys is missing (refuse, strip or keep)"));
        return None;
    };
    let wants = unknown == Unknown::Refuse;
    if !matches!(node.additional, Some(Additional::Flag(flag)) if flag != wants) {
        v.push(format!(
            "{at}: additionalProperties must be {} for x-wb-unknownKeys {}",
            !wants,
            if wants { "refuse" } else { "strip or keep" }
        ));
    }
    let declared: BTreeSet<&str> = properties.keys().map(String::as_str).collect();
    let required = names_of(node.required.as_deref(), &declared, "required", at, v);
    let order = node.order.as_deref().unwrap_or_default();
    let ordered: BTreeSet<&str> = order.iter().map(String::as_str).collect();
    if ordered.len() != order.len() || ordered != declared {
        v.push(format!("{at}.x-wb-order: must list every property exactly once"));
    }
    let fields = lower_fields(node, properties, &required, at, v);
    Some(Ty::Object(Object { fields, unknown }))
}

/// The fields of an object in `x-wb-order`, each checked as a name both
/// languages take and lowered.
fn lower_fields<'a>(
    node: &'a Node,
    properties: &'a BTreeMap<String, Node>,
    required: &BTreeSet<&str>,
    at: &str,
    v: &mut Vec<String>,
) -> Vec<Field<'a>> {
    let unknown = node.unknown_keys;
    let order = node.order.as_deref().unwrap_or_default();
    let mut fields: Vec<Field<'a>> = Vec::new();
    for key in order {
        let Some((name, property)) = properties.get_key_value(key) else { continue };
        let field_at = format!("{at}.{name}");
        if !is_field(name) {
            v.push(format!("{field_at}: not a lowercase identifier (snake_case or camelCase)"));
        }
        let rust = rust_field(name);
        if rust.as_deref().is_none_or(|r| matches!(r, "r#crate" | "r#self" | "r#super")) {
            v.push(format!("{field_at}: not a name both languages take"));
        }
        let rust = rust.unwrap_or_default();
        if fields.iter().any(|f| f.rust == rust) {
            v.push(format!(
                "{field_at}: {name} and an earlier property both name `{rust}` in Rust"
            ));
        }
        if unknown == Some(Unknown::Keep) && rust == "extra" {
            v.push(format!("{field_at}: `extra` holds a keep object's unknown keys"));
        }
        let description = described(property, &field_at, v);
        if let (Some(description), Some(ty)) = (description, lower(property, &field_at, false, v)) {
            fields.push(Field {
                name,
                rust,
                description,
                ty,
                optional: !required.contains(name.as_str()),
            });
        }
    }
    fields
}

/// `required` as a set of declared names; a name repeated or not declared is
/// reported.
fn names_of<'a>(
    list: Option<&'a [String]>,
    declared: &BTreeSet<&str>,
    what: &str,
    at: &str,
    v: &mut Vec<String>,
) -> BTreeSet<&'a str> {
    let set: BTreeSet<&str> = list.unwrap_or_default().iter().map(String::as_str).collect();
    if set.len() != list.map_or(0, <[String]>::len) {
        v.push(format!("{at}.{what}: lists a property twice"));
    }
    for name in &set {
        if !declared.contains(name) {
            v.push(format!("{at}.{what}: `{name}` is not a property"));
        }
    }
    set
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

/// Definitions with every reference after what it names. A reference to
/// nothing, or a loop, is reported.
fn in_dependency_order<'a>(
    mut lowered: BTreeMap<&'a str, CheckedDef<'a>>,
    known: &BTreeSet<&str>,
    v: &mut Vec<String>,
) -> Vec<CheckedDef<'a>> {
    let mut deps: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (name, def) in &lowered {
        let mut refs = Vec::new();
        def.ty.refs(&mut refs);
        for target in &refs {
            if !known.contains(target) {
                v.push(format!("$defs.{name}: `$ref` to unknown definition `{target}`"));
            }
        }
        refs.retain(|target| known.contains(target));
        deps.insert(name, refs);
    }
    let mut order: Vec<&str> = Vec::new();
    let mut done: BTreeSet<&str> = BTreeSet::new();
    while done.len() < deps.len() {
        let ready: Vec<&str> = deps
            .iter()
            .filter(|(name, refs)| {
                !done.contains(*name) && refs.iter().all(|r| done.contains(r) && r != *name)
            })
            .map(|(name, _)| *name)
            .collect();
        if ready.is_empty() {
            let stuck: Vec<&str> = deps.keys().filter(|n| !done.contains(*n)).copied().collect();
            v.push(format!("$defs: a `$ref` cycle among {}", stuck.join(", ")));
            break;
        }
        for name in ready {
            done.insert(name);
            order.push(name);
        }
    }
    order.into_iter().filter_map(|name| lowered.remove(name)).collect()
}

/// A hand-written module beside a generated output: the same package or
/// crate, directly under its `src`.
fn sibling(path: &str, output: &str, kind: TargetKind) -> Result<(), String> {
    let (root, dirs, suffix) = match kind {
        TargetKind::Zod => ("packages", 1, ".ts"),
        TargetKind::Rust => ("crates", 2, ".rs"),
    };
    let parts: Vec<&str> = path.split('/').collect();
    let home: Vec<&str> = output.split('/').take(dirs + 1).collect();
    let shape_ok = parts.len() == dirs + 3
        && parts.get(..=dirs) == Some(home.as_slice())
        && parts.get(dirs + 1) == Some(&"src")
        && parts.last().and_then(|f| f.strip_suffix(suffix)).is_some_and(is_segment);
    if shape_ok {
        Ok(())
    } else {
        Err(format!(
            "{path} is not {}src/<name>{suffix} in the output's own {root} directory",
            home.join("/") + "/"
        ))
    }
}

/// A pattern both a JavaScript regex literal and a hand-written Rust matcher
/// can stand for: anchored, printable ASCII, no `/` to close the literal early.
/// Whether it means the same in both engines is the matcher's differential, not
/// this scan's.
fn pattern_source(source: &str) -> Result<(), &'static str> {
    let body = source.strip_suffix('$').and_then(|s| s.strip_prefix('^'));
    let Some(body) = body else {
        return Err("must be anchored: start with `^` and end with `$`");
    };
    let escaped_end = body.len() - body.trim_end_matches('\\').len();
    if escaped_end % 2 == 1 {
        Err("must be anchored: the final `$` is escaped")
    } else if body.is_empty() || !body.bytes().all(|b| (0x20..=0x7e).contains(&b) && b != b'/') {
        Err("must be non-empty printable ASCII without `/`")
    } else {
        Ok(())
    }
}

fn is_pascal(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_uppercase())
        && name.chars().all(|c| c.is_ascii_alphanumeric())
}

fn is_snake(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A JSON key both languages take: `snake_case`, or `camelCase` that Rust reads as
/// the `snake_case` it spells.
fn is_field(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !(name.contains('_') && name.contains(|c: char| c.is_ascii_uppercase()))
        && !name.contains("__")
        && !name.ends_with('_')
}

/// The Rust field for a JSON key: `camelCase` becomes `snake_case`, and a keyword
/// is a raw identifier. `None` for a key `is_field` refuses.
fn rust_field(name: &str) -> Option<String> {
    if !is_field(name) {
        return None;
    }
    let mut snake = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            snake.push('_');
        }
        snake.push(c.to_ascii_lowercase());
    }
    Some(if RUST_KEYWORDS.contains(&snake.as_str()) { format!("r#{snake}") } else { snake })
}
