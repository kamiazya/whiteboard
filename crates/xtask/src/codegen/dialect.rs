//! The restricted dialect (ADR-0054 decision 8, QR-7) as a typed parse plus
//! the rules a parse cannot state.
//!
//! Every keyword is a typed field under `deny_unknown_fields`, so a construct
//! the emitters do not implement is refused by name rather than dropped from
//! one language's output. What is accepted: numbers with an inclusive
//! `minimum`, always finite (Zod 4's `z.number()` refuses NaN and Infinity,
//! JSON cannot write them, and a Rust `f64` read from JSON cannot be one);
//! booleans and integers; strings with a UTF-16 minimum, a pattern and a named
//! check, a closed `enum` of values, or a `const`; arrays with an inclusive
//! length bound (and the sentence Zod refuses an overlong one with), `$ref`s
//! to a definition, any-values and records of them, or a record whose keys
//! are a string definition's and whose entries are one schema, bounded in
//! count;
//! `anyOf` over definitions, or `oneOf` with the `discriminator` property
//! whose constant picks the member; and objects whose unknown keys are refused,
//! stripped or kept, with optional fields. A definition may be
//! `x-wb-registered`, or `x-wb-external` when its Zod half is a hand-written
//! module's. An object may carry a named `x-wb-check` and may `x-wb-extends`
//! a plain one; a property may be `x-wb-lenient`, `default` to an empty list or record,
//! or carry the text a model reads as `x-wb-describe`, as may a union definition. It grows when a contract
//! needs a construct, with that construct's emission in both languages in the
//! same change.
//!
//! Field order is `x-wb-order`, which must list every property once: a JSON
//! object carries no order a map keeps.

use std::collections::{BTreeMap, BTreeSet};

pub(super) use super::parse::Unknown;
use super::parse::{Additional, Kind, Node};
pub(crate) use super::parse::{Contract, parse};

mod header;
mod objects;
mod records;
mod shapes;
use header::check_header;
use objects::{check_extensions, check_unions, lower_object};
use records::{check_map_keys, lower_record};
pub(super) use shapes::variant_name;
use shapes::{lower_array, lower_const, lower_discriminated, lower_enum, lower_union};

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
    Number {
        min: Option<f64>,
    },
    Bool,
    /// A whole number; the safe-integer bounds are not published.
    Integer,
    /// A string that is always this one value.
    Literal(&'a str),
    Str {
        min_utf16: Option<u32>,
        pattern: Option<Pattern<'a>>,
        check: Option<&'a str>,
    },
    /// A list of one element schema, its length bounded inclusively.
    Array {
        item: Box<Ty<'a>>,
        min: Option<u32>,
        max: Option<u32>,
        /// What Zod refuses a list past `max` with, where the default is not
        /// the sentence a reader needs.
        max_message: Option<&'a str>,
    },
    /// A closed set of string values.
    Enum(Vec<&'a str>),
    /// One of several definitions, named by reference; chosen by the constant
    /// value of the `discriminator` property when it has one.
    Union {
        members: Vec<&'a str>,
        discriminator: Option<&'a str>,
    },
    Ref(&'a str),
    Any,
    Record {
        check: Option<&'a str>,
    },
    /// A record whose keys are a string definition's and whose entries are
    /// one schema.
    Map {
        key: &'a str,
        value: Box<Ty<'a>>,
        cap: Option<Cap<'a>>,
    },
    Object(Object<'a>),
}

/// How many entries a record may hold, and the sentence Zod refuses one with
/// that holds more, where `{count}` stands for how many it holds.
#[derive(Clone, Copy)]
pub(super) struct Cap<'a> {
    pub(super) max: u32,
    pub(super) message: &'a str,
}

/// A string's `pattern`, the message Zod answers with and the Rust matcher
/// that stands for it (the Rust half has no regex engine).
pub(super) struct Pattern<'a> {
    pub(super) source: &'a str,
    pub(super) message: &'a str,
    pub(super) matcher: &'a str,
}

pub(super) struct Object<'a> {
    /// The object's own properties; those of `extends` come before them.
    pub(super) fields: Vec<Field<'a>>,
    pub(super) unknown: Unknown,
    /// A named check of the whole object.
    pub(super) check: Option<&'a str>,
    pub(super) extends: Option<&'a str>,
}

pub(super) struct Field<'a> {
    /// The JSON key, which is also the Zod key.
    pub(super) name: &'a str,
    /// The Rust field: `snake_case`, a raw identifier where a keyword.
    pub(super) rust: String,
    pub(super) description: &'a str,
    pub(super) ty: Ty<'a>,
    pub(super) optional: bool,
    /// An absent value reads as an empty list, so the field is never absent.
    pub(super) default_empty: bool,
    /// A malformed value reads as absent.
    pub(super) lenient: bool,
    /// The text a model reads, published as the property's `.describe()`.
    pub(super) published: Option<&'a str>,
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
    /// Whether the Zod half registers it in Zod's global registry under `name`.
    pub(super) registered: bool,
    /// The module whose hand-written Zod schema stands for it, if any.
    pub(super) external: Option<&'a str>,
    /// The text a model reads for a union, published as its `.describe()`.
    pub(super) published: Option<&'a str>,
    pub(super) ty: Ty<'a>,
}

impl<'a> Ty<'a> {
    fn refs(&self, out: &mut Vec<&'a str>) {
        match self {
            Ty::Ref(name) => out.push(name),
            Ty::Array { item, .. } => item.refs(out),
            Ty::Map { key, value, .. } => {
                out.push(key);
                value.refs(out);
            }
            Ty::Union { members, .. } => out.extend(members),
            Ty::Object(object) => {
                out.extend(object.extends);
                object.fields.iter().for_each(|f| f.ty.refs(out));
            }
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
            Ty::Array { item, .. } => item.names(zod, rust),
            Ty::Map { value, .. } => value.names(zod, rust),
            Ty::Object(object) => {
                zod.extend(object.check);
                rust.extend(object.check);
                object.fields.iter().for_each(|f| f.ty.names(zod, rust));
            }
            _ => {}
        }
    }

    /// Whether the Rust type reaches for the model crate's `Value` or `Map`.
    pub(super) fn uses(&self, wanted: Uses) -> bool {
        match self {
            Ty::Any => wanted == Uses::Value,
            Ty::Record { .. } => wanted == Uses::Map,
            Ty::Array { item, .. } => item.uses(wanted),
            Ty::Map { value, .. } => value.uses(wanted),
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
    check_extensions(&defs, &mut v);
    check_unions(&defs, &mut v);
    check_map_keys(&defs, &mut v);
    for def in &defs {
        let mut imported = Vec::new();
        let zod = if def.external.is_some() { &mut imported } else { &mut zod_checks };
        def.ty.names(zod, &mut rust_names);
    }
    for name in zod_checks.iter().chain(&rust_names) {
        if !is_snake(name) {
            v.push(format!("check `{name}`: must be snake_case"));
        }
    }
    if (!zod_checks.is_empty() || !rust_names.is_empty()) && contract.checks.is_none() {
        v.push("x-wb-checks: a named check or matcher needs the modules that hold it".to_owned());
    }
    if !zod_checks.is_empty() && contract.checks.as_ref().is_some_and(|m| m.zod.is_none()) {
        v.push(
            "x-wb-checks.zod: a named check needs the TypeScript module that holds it".to_owned(),
        );
    }
    check_model_types(contract, &defs, &mut v);
    for set in [&mut zod_checks, &mut rust_names] {
        set.sort_unstable();
        set.dedup();
    }
    if v.is_empty() { Ok(Checked { contract, defs, zod_checks, rust_names }) } else { Err(v) }
}

/// `Value` and `Map` are the model crate's, so a contract that reaches for one
/// emits where that crate may be named: a core crate.
fn check_model_types(contract: &Contract, defs: &[CheckedDef<'_>], v: &mut Vec<String>) {
    if !contract.rust_serde
        && defs.iter().any(|d| d.ty.uses(Uses::Value) || d.ty.uses(Uses::Map))
        && !contract.emit.rust.starts_with("crates/core/")
    {
        v.push(
            "x-wb-emit.rust: `Value` and `Map` are whiteboard-model's, so it must emit in a \
             core crate, which may depend on it"
                .to_owned(),
        );
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
    check_fit(contract, &ty, &at, v);
    let registered = node.registered.is_some();
    if node.registered == Some(false) {
        v.push(format!("{at}.x-wb-registered: is `true` or absent"));
    }
    if contract.describe && registered {
        v.push(format!("{at}: x-wb-registered is not implemented with x-wb-describe"));
    }
    let external = node.external.as_deref();
    if let Some(module) = external {
        check_external(contract, module, registered, &at, v);
    }
    let published = published_text(contract, node, &ty, &at, v);
    Some(CheckedDef { name, description: description?, registered, external, published, ty })
}

/// The text a union publishes where the contract does not publish every
/// description: only a union carries one, since an object's properties carry
/// theirs.
fn published_text<'a>(
    contract: &Contract,
    node: &'a Node,
    ty: &Ty<'_>,
    at: &str,
    v: &mut Vec<String>,
) -> Option<&'a str> {
    let text = node.published.as_deref()?;
    if contract.describe {
        v.push(format!("{at}: the contract already publishes every description"));
    }
    if !matches!(ty, Ty::Union { .. }) {
        v.push(format!("{at}: x-wb-describe belongs on a union or a property"));
    }
    if let Err(e) = refusal(text) {
        v.push(format!("{at}.x-wb-describe: {e}"));
    }
    Some(text)
}

/// What the contract's own switches allow a definition to hold.
fn check_fit(contract: &Contract, ty: &Ty<'_>, at: &str, v: &mut Vec<String>) {
    if contract.rust_serde && !serde_shape(ty) {
        v.push(format!(
            "{at}: x-wb-rustSerde emits closed objects of required numbers only; \
             set it to false for this construct"
        ));
    }
    if contract.describe && matches!(ty, Ty::Map { cap: Some(_), .. }) {
        v.push(format!("{at}: a bounded record is not implemented with x-wb-describe"));
    }
    let Ty::Object(object) = ty else { return };
    if !contract.describe {
        return;
    }
    if object.fields.iter().any(|f| f.optional) {
        v.push(format!("{at}: an optional field is not implemented with x-wb-describe"));
    }
    if object.check.is_some() || object.extends.is_some() {
        v.push(format!("{at}: an object check or extension is not implemented with x-wb-describe"));
    }
    if object.fields.iter().any(|f| f.published.is_some()) {
        v.push(format!(
            "{at}: the contract already publishes every description; \
             drop x-wb-describe from its properties"
        ));
    }
}

/// A definition whose Zod half is a module's hand-written schema: the module
/// must be a sibling import, and nothing the Zod half would emit for it applies.
fn check_external(
    contract: &Contract,
    module: &str,
    registered: bool,
    at: &str,
    v: &mut Vec<String>,
) {
    if !import_path(module) {
        v.push(format!("{at}.x-wb-external: {module} must be a relative `.js` import"));
    }
    if contract.describe {
        v.push(format!("{at}: x-wb-external is not implemented with x-wb-describe"));
    }
    if registered {
        v.push(format!("{at}: x-wb-registered is not implemented with x-wb-external"));
    }
}

/// `./name.js` or `../name.js`: one directory step and a lowercase file name,
/// so the import line is one biome sorts the way the emitter does.
fn import_path(module: &str) -> bool {
    let Some(file) = module.strip_prefix("../").or_else(|| module.strip_prefix("./")) else {
        return false;
    };
    file.strip_suffix(".js").is_some_and(|stem| {
        !stem.is_empty()
            && stem
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "-_.".contains(c))
            && !stem.starts_with('.')
    })
}

fn serde_shape(ty: &Ty<'_>) -> bool {
    matches!(
        ty,
        Ty::Object(object) if object.unknown == Unknown::Refuse
            && object.check.is_none()
            && object.extends.is_none()
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
    if node.lenient.is_some() {
        v.push(format!("{at}: x-wb-lenient belongs on a property"));
    }
    if node.published.is_some() && !top {
        v.push(format!("{at}: x-wb-describe belongs on a property or a union"));
    }
    lower_form(node, at, top, v)
}

/// The keywords that belong only where a definition, or only where a property,
/// is written.
fn check_placement(node: &Node, at: &str, top: bool, v: &mut Vec<String>) {
    if !top && node.registered.is_some() {
        v.push(format!("{at}: x-wb-registered belongs on a definition"));
    }
    if !top && node.external.is_some() {
        v.push(format!("{at}: x-wb-external belongs on a definition"));
    }
    if top && node.default.is_some() {
        v.push(format!("{at}: a default belongs on a property"));
    }
}

fn lower_reference<'a>(
    node: &Node,
    reference: &'a str,
    at: &str,
    v: &mut Vec<String>,
) -> Option<Ty<'a>> {
    only(node, &["$ref"], "a reference", at, v);
    if node.kind.is_some() {
        v.push(format!("{at}: a `$ref` carries no `type`"));
    }
    let Some(name) = reference.strip_prefix(DEFS_PREFIX) else {
        v.push(format!("{at}.$ref: {reference} is not a `{DEFS_PREFIX}<name>` reference"));
        return None;
    };
    Some(Ty::Ref(name))
}

/// `lower` for a node that may carry a property's own decorations.
fn lower_form<'a>(node: &'a Node, at: &str, top: bool, v: &mut Vec<String>) -> Option<Ty<'a>> {
    check_placement(node, at, top, v);
    if let Some(reference) = &node.reference {
        return lower_reference(node, reference, at, v);
    }
    if node.one_of.is_some() {
        return lower_discriminated(node, at, top, v);
    }
    if node.any_of.is_some() {
        return lower_union(node, at, top, v);
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
        Some(Kind::Boolean) => {
            only(node, &[], "a boolean", at, v);
            Some(Ty::Bool)
        }
        Some(Kind::Integer) => {
            only(node, &[], "an integer", at, v);
            Some(Ty::Integer)
        }
        Some(Kind::String) if node.constant.is_some() => lower_const(node, at, top, v),
        Some(Kind::String) if node.values.is_some() => lower_enum(node, at, top, v),
        Some(Kind::String) => Some(lower_string(node, at, v)),
        Some(Kind::Array) => lower_array(node, at, v),
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
            if let Err(e) = refusal(message) {
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

/// The text Zod refuses with. It lands only in a single-quoted string literal,
/// so double quotes and non-ASCII punctuation are the author's to use.
fn refusal(text: &str) -> Result<(), &'static str> {
    if text.trim().is_empty() {
        Err("empty")
    } else if text.contains(['\n', '\r', '\\', '\'']) {
        Err("must be one line without single quotes or backslashes")
    } else {
        Ok(())
    }
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

/// A pattern both a JavaScript regex literal and a hand-written Rust matcher
/// can stand for: anchored, printable ASCII, and any `/` escaped so it cannot
/// close the literal early.
/// Whether it means the same in both engines is the matcher's differential, not
/// this scan's.
fn pattern_source(source: &str) -> Result<(), &'static str> {
    let body = source.strip_suffix('$').and_then(|s| s.strip_prefix('^'));
    let Some(body) = body else {
        return Err("must be anchored: start with `^` and end with `$`");
    };
    let escaped_end = body.bytes().rev().take_while(|&b| b == b'\\').count();
    if escaped_end % 2 == 1 {
        Err("must be anchored: the final `$` is escaped")
    } else if body.is_empty() || !printable_with_slashes_escaped(body) {
        Err("must be non-empty printable ASCII with every `/` escaped")
    } else {
        Ok(())
    }
}

fn printable_with_slashes_escaped(body: &str) -> bool {
    let mut escaped = false;
    for b in body.bytes() {
        if !(0x20..=0x7e).contains(&b) || (b == b'/' && !escaped) {
            return false;
        }
        escaped = !escaped && b == b'\\';
    }
    true
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
