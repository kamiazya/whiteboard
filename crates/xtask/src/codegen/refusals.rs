//! The refusals of `contracts/api/refusals.json`, generated into each language
//! that answers or reads them, so the TypeScript and the Rust refuse a request
//! with the same code, status and sentence because they read the same file.
//!
//! An entry is one sentence: a code, the status it travels with, a message
//! template and an example that pins one rendering of it. Several entries may
//! share a code (one condition said in more than one way), and a family names
//! the codes a surface's own contract lists. The template language is small on
//! purpose, since both languages must interpret it identically: `{name}`
//! fills a param, `{name|filter}` a filtered one, `{{` and `}}` are braces.
//! The TypeScript half interprets the template at run time; the Rust half
//! compiles it into a `format!`, and the example is rendered here by a third
//! reader so a template a language reads differently from the others is
//! caught at generation rather than in a user's error text.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use serde::Deserialize;
use serde_json::Value;

use super::caps::rust_int;
use super::emit::{header, within_width};
use super::refusal_template::{Filter, Piece, Ty, is_camel, parse_template, render, strings};

pub(super) const SOURCE: &str = "contracts/api/refusals.json";
const TS_TARGET: &str = "packages/model/src/generated/refusals.ts";
const RUST_TARGET: &str = "crates/ops/api-contracts/src/generated/refusals.rs";

const STATUSES: &[u16] = &[400, 404, 409, 413, 500, 503];
const FAMILIES: &[&str] = &["sync-write", "version"];
/// The widest a doc comment is wrapped, under biome's and rustfmt's 100.
const COMMENT_WIDTH: usize = 92;
/// biome.json's `lineWidth`, which decides where a property's string moves to its own line.
const TS_LINE_WIDTH: usize = 100;
/// The largest integer a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const RUST_KEYWORDS: &[&str] = &[
    "abstract", "as", "async", "await", "become", "box", "break", "const", "continue", "crate",
    "do", "dyn", "else", "enum", "extern", "false", "final", "fn", "for", "gen", "if", "impl",
    "in", "let", "loop", "macro", "match", "mod", "move", "mut", "override", "priv", "pub", "ref",
    "return", "self", "static", "struct", "super", "trait", "true", "try", "type", "typeof",
    "unsafe", "unsized", "use", "virtual", "where", "while", "yield",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Contract {
    #[serde(rename = "$comment")]
    _comment: String,
    surfaces: BTreeMap<String, String>,
    refusals: Vec<Entry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Entry {
    name: String,
    code: String,
    status: u16,
    family: Option<String>,
    description: String,
    message: String,
    #[serde(default)]
    params: BTreeMap<String, String>,
    #[serde(default)]
    example: BTreeMap<String, Value>,
    example_text: String,
    surfaces: Vec<String>,
    source: String,
}

fn is_pascal(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_uppercase())
        && name.chars().all(|c| c.is_ascii_alphanumeric())
}

fn is_code(code: &str) -> bool {
    code.starts_with(|c: char| c.is_ascii_lowercase())
        && !code.ends_with('_')
        && !code.contains("__")
        && code.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

struct Checked<'a> {
    entry: &'a Entry,
    tys: BTreeMap<&'a str, Ty>,
    pieces: Vec<Piece>,
}

fn check_example(entry: &Entry, tys: &BTreeMap<&str, Ty>) -> Result<(), String> {
    if entry.example.keys().map(String::as_str).ne(tys.keys().copied()) {
        return Err("example names other params than params does".to_owned());
    }
    for (name, ty) in tys {
        let ok = match (&entry.example[*name], ty) {
            (Value::String(_), Ty::Str) => true,
            (Value::Number(n), Ty::Int) => n.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER),
            (value, Ty::List) => strings(value).is_ok(),
            _ => false,
        };
        if !ok {
            return Err(format!("example `{name}` is not a {}", ty.ts()));
        }
    }
    Ok(())
}

fn check_template(entry: &Entry, tys: &BTreeMap<&str, Ty>) -> Result<Vec<Piece>, String> {
    if entry.message.is_empty() || entry.message.contains(['\\', '\n', '\r', '\t']) {
        return Err("message is empty, or holds a backslash or a control character".to_owned());
    }
    let pieces = parse_template(&entry.message).map_err(|e| format!("message: {e}"))?;
    let mut used = BTreeSet::new();
    for piece in &pieces {
        let Piece::Param { name, filter } = piece else { continue };
        let ty =
            tys.get(name.as_str()).ok_or_else(|| format!("message names `{name}`, no param"))?;
        let fits = match filter {
            Some(filter) => filter.takes() == *ty,
            None => *ty != Ty::List,
        };
        if !fits {
            let said = filter.map_or("no filter", Filter::name);
            return Err(format!("`{name}` is a {}, which `{said}` does not take", ty.ts()));
        }
        used.insert(name.as_str());
    }
    if let Some(unused) = tys.keys().find(|name| !used.contains(**name)) {
        return Err(format!("param `{unused}` is never used by the message"));
    }
    Ok(pieces)
}

fn check_entry<'a>(
    entry: &'a Entry,
    surfaces: &BTreeMap<String, String>,
) -> Result<Checked<'a>, String> {
    if !is_pascal(&entry.name) {
        return Err("name is not PascalCase".to_owned());
    }
    if !is_code(&entry.code) {
        return Err(format!("code `{}` is not lowercase snake_case", entry.code));
    }
    if !STATUSES.contains(&entry.status) {
        return Err(format!("status {} is not one of {STATUSES:?}", entry.status));
    }
    if let Some(family) = &entry.family
        && !FAMILIES.contains(&family.as_str())
    {
        return Err(format!("family `{family}` is not one of {FAMILIES:?}"));
    }
    if entry.description.trim().is_empty() || entry.source.trim().is_empty() {
        return Err("description and source must say something".to_owned());
    }
    if entry.surfaces.is_empty() {
        return Err("surfaces is empty".to_owned());
    }
    let unique: BTreeSet<_> = entry.surfaces.iter().collect();
    if unique.len() != entry.surfaces.len() {
        return Err("surfaces names one twice".to_owned());
    }
    if let Some(unknown) = entry.surfaces.iter().find(|name| !surfaces.contains_key(*name)) {
        return Err(format!("surface `{unknown}` is not declared in surfaces"));
    }
    let mut tys = BTreeMap::new();
    for (name, ty) in &entry.params {
        if !is_camel(name) || RUST_KEYWORDS.contains(&name.as_str()) {
            return Err(format!("param `{name}` is not a name both languages take"));
        }
        let ty = Ty::parse(ty).ok_or_else(|| format!("param `{name}` has no type `{ty}`"))?;
        tys.insert(name.as_str(), ty);
    }
    check_example(entry, &tys)?;
    let pieces = check_template(entry, &tys)?;
    let said = render(&pieces, &entry.example)?;
    if said != entry.example_text {
        return Err(format!("exampleText is not what the example renders: {said}"));
    }
    Ok(Checked { entry, tys, pieces })
}

fn check(contract: &Contract) -> Result<Vec<Checked<'_>>, Vec<String>> {
    let mut errors = Vec::new();
    let mut checked = Vec::new();
    let mut names = BTreeSet::new();
    for entry in &contract.refusals {
        if !names.insert(entry.name.as_str()) {
            errors.push(format!("{SOURCE}: {} is declared twice", entry.name));
        }
        match check_entry(entry, &contract.surfaces) {
            Ok(entry) => checked.push(entry),
            Err(e) => errors.push(format!("{SOURCE}: {}: {e}", entry.name)),
        }
    }
    let mut families: BTreeMap<&str, Option<&str>> = BTreeMap::new();
    for entry in &contract.refusals {
        let family = entry.family.as_deref();
        if *families.entry(entry.code.as_str()).or_insert(family) != family {
            errors
                .push(format!("{SOURCE}: code `{}` is in a family in one entry only", entry.code));
        }
    }
    if errors.is_empty() { Ok(checked) } else { Err(errors) }
}

/// Every distinct code in the order it first appears.
fn distinct_codes<'a>(entries: &[Checked<'a>]) -> Vec<&'a str> {
    let mut seen = BTreeSet::new();
    entries.iter().map(|e| e.entry.code.as_str()).filter(|code| seen.insert(*code)).collect()
}

fn family_codes<'a>(entries: &[Checked<'a>], family: &str) -> Vec<&'a str> {
    let mut seen = BTreeSet::new();
    entries
        .iter()
        .filter(|e| e.entry.family.as_deref() == Some(family))
        .map(|e| e.entry.code.as_str())
        .filter(|code| seen.insert(*code))
        .collect()
}

fn camel_of_code(code: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for c in code.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.push(c.to_ascii_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn snake_of_camel(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Words wrapped to `width` columns, one line each.
fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        match lines.last_mut() {
            Some(line) if line.chars().count() + 1 + word.chars().count() <= width => {
                line.push(' ');
                line.push_str(word);
            }
            _ => lines.push(word.to_owned()),
        }
    }
    lines
}

fn ts_doc(out: &mut String, indent: usize, text: &str) {
    let pad = " ".repeat(indent);
    let lines = wrap(text, COMMENT_WIDTH - indent);
    match lines.as_slice() {
        [one] => {
            let _ = writeln!(out, "{pad}/** {one} */");
        }
        many => {
            let _ = writeln!(out, "{pad}/**");
            for line in many {
                let _ = writeln!(out, "{pad} * {line}");
            }
            let _ = writeln!(out, "{pad} */");
        }
    }
}

/// A TypeScript string literal as biome writes it: single quotes unless the
/// text holds more of them than double quotes.
fn ts_literal(text: &str) -> String {
    let singles = text.matches('\'').count();
    let quote = if singles > text.matches('"').count() { '"' } else { '\'' };
    let mut out = String::from(quote);
    for c in text.chars() {
        if c == quote {
            out.push('\\');
        }
        out.push(c);
    }
    out.push(quote);
    out
}

/// `key: 'text',` where it fits a line, else the string under the key, which
/// is where biome puts a string too long for one.
fn ts_property(out: &mut String, indent: usize, key: &str, literal: &str) {
    let pad = " ".repeat(indent);
    if indent + key.len() + 2 + literal.chars().count() < TS_LINE_WIDTH {
        let _ = writeln!(out, "{pad}{key}: {literal},");
    } else {
        let _ = writeln!(out, "{pad}{key}:\n{pad}  {literal},");
    }
}

/// An array literal on one line where it fits, else one item to a line.
fn ts_array(out: &mut String, lead: &str, items: &[&str]) {
    let literals: Vec<String> = items.iter().map(|item| ts_literal(item)).collect();
    let line = format!("{lead}[{}] as const", literals.join(", "));
    if line.chars().count() <= TS_LINE_WIDTH {
        let _ = writeln!(out, "{line}");
        return;
    }
    let _ = writeln!(out, "{lead}[");
    for literal in literals {
        let _ = writeln!(out, "  {literal},");
    }
    out.push_str("] as const\n");
}

fn ts(entries: &[Checked<'_>]) -> String {
    let mut out = header(SOURCE);
    out.push_str("\n/** Every refusal by name: its code, HTTP status and message template. */\n");
    out.push_str("export const REFUSALS = {\n");
    for e in entries {
        ts_doc(&mut out, 2, &e.entry.description);
        let _ = writeln!(out, "  {}: {{", e.entry.name);
        let _ = writeln!(out, "    code: {},", ts_literal(&e.entry.code));
        let _ = writeln!(out, "    status: {},", e.entry.status);
        ts_property(&mut out, 4, "message", &ts_literal(&e.entry.message));
        out.push_str("  },\n");
    }
    out.push_str("} as const\n");
    out.push_str(
        "\n/** The name of a refusal. */\nexport type RefusalName = keyof typeof REFUSALS\n",
    );
    out.push_str(
        "\n/** The params each refusal's message names. */\nexport interface RefusalParams {\n",
    );
    for e in entries {
        if e.tys.is_empty() {
            let _ = writeln!(out, "  {}: Record<never, never>", e.entry.name);
            continue;
        }
        let _ = writeln!(out, "  {}: {{", e.entry.name);
        for (name, ty) in &e.tys {
            let _ = writeln!(out, "    readonly {name}: {}", ty.ts());
        }
        out.push_str("  }\n");
    }
    out.push_str("}\n");
    out.push_str("\n/** Every code a refusal carries, keyed by the camelCase of the code. */\n");
    out.push_str("export const REFUSAL_CODES = {\n");
    for code in distinct_codes(entries) {
        let _ = writeln!(out, "  {}: {},", camel_of_code(code), ts_literal(code));
    }
    out.push_str("} as const\n");
    out.push_str("\n/** A code a refusal carries. */\n");
    out.push_str("export type RefusalCode = (typeof REFUSAL_CODES)[keyof typeof REFUSAL_CODES]\n");
    for (family, name, what) in [
        ("sync-write", "SYNC_WRITE_REFUSAL_CODES", "a keeper refuses a sync write with"),
        ("version", "VERSION_REFUSAL_CODES", "a keeper refuses a version save with"),
    ] {
        let _ = write!(out, "\n/** The codes {what}. */\n");
        ts_array(&mut out, &format!("export const {name} = "), &family_codes(entries, family));
    }
    out
}

fn rust_literal(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if c.is_control() => {
                let _ = write!(out, "\\u{{{:x}}}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn rust_doc(out: &mut String, indent: usize, text: &str) {
    let pad = " ".repeat(indent);
    for line in wrap(text, COMMENT_WIDTH - indent) {
        let _ = writeln!(out, "{pad}/// {line}");
    }
}

fn rust_example(value: &Value, ty: Ty) -> String {
    match (value, ty) {
        (Value::Number(n), Ty::Int) => n.as_u64().map_or_else(String::new, rust_int),
        (Value::String(s), Ty::Str) if s.is_empty() => "String::new()".to_owned(),
        (Value::String(s), Ty::Str) => format!("{}.to_owned()", rust_literal(s)),
        (list, _) => {
            let items = strings(list).unwrap_or_default();
            let items: Vec<String> =
                items.iter().map(|s| format!("{}.to_owned()", rust_literal(s))).collect();
            format!("vec![{}]", items.join(", "))
        }
    }
}

/// `Self::Name { a, b }`, `Self::Name { .. }` for a match that reads none of
/// them, or the bare name of a refusal that has none.
fn rust_pattern(e: &Checked<'_>, bind: bool) -> String {
    if e.tys.is_empty() {
        return format!("Self::{}", e.entry.name);
    }
    if !bind {
        return format!("Self::{} {{ .. }}", e.entry.name);
    }
    let fields: Vec<String> = e.tys.keys().map(|name| snake_of_camel(name)).collect();
    format!("Self::{} {{ {} }}", e.entry.name, fields.join(", "))
}

fn rust_message(e: &Checked<'_>) -> String {
    let braces = |text: &str| text.replace('{', "{{").replace('}', "}}");
    if e.tys.is_empty() {
        let text: String = e
            .pieces
            .iter()
            .map(|piece| match piece {
                Piece::Text(text) => text.as_str(),
                Piece::Param { .. } => "",
            })
            .collect();
        return format!("{}.to_owned()", rust_literal(&text));
    }
    if let [Piece::Param { name, filter: None }] = e.pieces.as_slice() {
        return format!("{}.clone()", snake_of_camel(name));
    }
    let mut format = String::new();
    let mut named: Vec<String> = Vec::new();
    for piece in &e.pieces {
        match piece {
            Piece::Text(text) => format.push_str(&braces(text)),
            Piece::Param { name, filter: None } => {
                let _ = write!(format, "{{{}}}", snake_of_camel(name));
            }
            Piece::Param { name, filter: Some(filter) } => {
                let field = snake_of_camel(name);
                let bound = format!("{field}_{}", filter.name());
                let call = match filter {
                    Filter::S => format!("plural_s(*{field})"),
                    other => format!("{}({field})", other.name()),
                };
                let arg = format!("{bound} = {call}");
                if !named.contains(&arg) {
                    named.push(arg);
                }
                let _ = write!(format, "{{{bound}}}");
            }
        }
    }
    let rest = if named.is_empty() { String::new() } else { format!(", {}", named.join(", ")) };
    format!("format!({}{rest})", rust_literal(&format))
}

const EXPECT_LONG_MATCH: &str = "    #[expect(\n        clippy::too_many_lines,\n        reason = \"one arm per refusal the contract lists\"\n    )]\n";

fn rust_variants(out: &mut String, entries: &[Checked<'_>]) {
    out.push_str(
        "\n/// A refusal: the code and status a request is answered with, and its sentence.\n",
    );
    out.push_str("#[derive(Debug, Clone, PartialEq, Eq)]\npub enum Refusal {\n");
    for e in entries {
        rust_doc(out, 4, &e.entry.description);
        if e.tys.is_empty() {
            let _ = writeln!(out, "    {},", e.entry.name);
            continue;
        }
        let _ = writeln!(out, "    {} {{", e.entry.name);
        for (name, ty) in &e.tys {
            let _ = writeln!(out, "        {}: {},", snake_of_camel(name), ty.rust());
        }
        out.push_str("    },\n");
    }
    out.push_str("}\n");
}

fn rust_codes(out: &mut String, entries: &[Checked<'_>]) {
    out.push_str("\n/// Every code a refusal carries, as a constant.\npub mod code {\n");
    for code in distinct_codes(entries) {
        let _ = writeln!(
            out,
            "    pub const {}: &str = {};",
            code.to_ascii_uppercase(),
            rust_literal(code)
        );
    }
    out.push_str("}\n");
    let names = |codes: &[&str]| -> String {
        codes
            .iter()
            .map(|c| format!("code::{}", c.to_ascii_uppercase()))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let _ = write!(
        out,
        "\n/// Every code, once, in the order the contract first names it.\npub const CODES: &[&str] = &[{}];\n",
        names(&distinct_codes(entries))
    );
    for (family, name, what) in [
        ("sync-write", "SYNC_WRITE_CODES", "a keeper refuses a sync write with"),
        ("version", "VERSION_CODES", "a keeper refuses a version save with"),
    ] {
        let _ = write!(
            out,
            "\n/// The codes {what}.\npub const {name}: &[&str] = &[{}];\n",
            names(&family_codes(entries, family))
        );
    }
}

/// Match arms with the same body written as one arm over their patterns, in the
/// order each body first appears: clippy's the lint against repeated arms refuses a repeat.
fn rust_arms(out: &mut String, arms: &[(String, String)]) {
    let mut order: Vec<&str> = Vec::new();
    let mut by_body: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (pattern, body) in arms {
        let patterns = by_body.entry(body.as_str()).or_default();
        if patterns.is_empty() {
            order.push(body.as_str());
        }
        patterns.push(pattern.as_str());
    }
    for body in order {
        let _ = writeln!(out, "            {} => {body},", by_body[body].join(" | "));
    }
}

fn rust_methods(out: &mut String, entries: &[Checked<'_>]) {
    out.push_str("\nimpl Refusal {\n");
    out.push_str("    /// The stable code a caller branches on.\n");
    out.push_str(EXPECT_LONG_MATCH);
    out.push_str(
        "    #[must_use]\n    pub const fn code(&self) -> &'static str {\n        match self {\n",
    );
    let arms: Vec<(String, String)> = entries
        .iter()
        .map(|e| (rust_pattern(e, false), format!("code::{}", e.entry.code.to_ascii_uppercase())))
        .collect();
    rust_arms(out, &arms);
    out.push_str("        }\n    }\n\n");
    out.push_str("    /// The HTTP status the refusal travels with.\n");
    out.push_str(EXPECT_LONG_MATCH);
    out.push_str(
        "    #[must_use]\n    pub const fn status(&self) -> u16 {\n        match self {\n",
    );
    let arms: Vec<(String, String)> =
        entries.iter().map(|e| (rust_pattern(e, false), e.entry.status.to_string())).collect();
    rust_arms(out, &arms);
    out.push_str("        }\n    }\n\n");
    out.push_str("    /// The sentence, as the TypeScript says it.\n");
    out.push_str(EXPECT_LONG_MATCH);
    out.push_str("    #[must_use]\n    pub fn message(&self) -> String {\n        match self {\n");
    let arms: Vec<(String, String)> =
        entries.iter().map(|e| (rust_pattern(e, true), rust_message(e))).collect();
    rust_arms(out, &arms);
    out.push_str("        }\n    }\n}\n");
}

fn rust_examples(out: &mut String, entries: &[Checked<'_>]) {
    out.push_str("\n/// Each refusal built from the example the contract pins for it, by name.\n");
    out.push_str("#[cfg(test)]\n");
    out.push_str(EXPECT_LONG_MATCH.trim_start_matches("    "));
    out.push_str("pub(crate) fn examples() -> Vec<(&'static str, Refusal)> {\n    vec![\n");
    for e in entries {
        let fields: Vec<String> = e
            .tys
            .iter()
            .map(|(name, ty)| {
                format!("{}: {}", snake_of_camel(name), rust_example(&e.entry.example[*name], *ty))
            })
            .collect();
        let build = if fields.is_empty() {
            format!("Refusal::{}", e.entry.name)
        } else {
            format!("Refusal::{} {{ {} }}", e.entry.name, fields.join(", "))
        };
        let _ = writeln!(out, "        ({}, {build}),", rust_literal(&e.entry.name));
    }
    out.push_str("    ]\n}\n");
}

fn rust(entries: &[Checked<'_>]) -> String {
    let mut out = header(SOURCE);
    out.push_str("\nuse std::fmt;\n\nuse crate::refusal_text::{\n");
    out.push_str("    and_list, json, json_list, list, plural_s, quoted_list, trim,\n};\n");
    rust_variants(&mut out, entries);
    rust_codes(&mut out, entries);
    rust_methods(&mut out, entries);
    out.push_str(
        "\nimpl fmt::Display for Refusal {\n    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {\n        f.write_str(&self.message())\n    }\n}\n",
    );
    rust_examples(&mut out, entries);
    out
}

/// The refusals' outputs, as `(repo-relative path, content, is the Rust half)`,
/// the Rust half not yet formatted.
pub(super) fn generate(text: &str) -> Result<Vec<(String, String, bool)>, Vec<String>> {
    let contract: Contract = serde_json::from_str(text)
        .map_err(|e| vec![format!("{SOURCE}: not the refusals contract: {e}")])?;
    let entries = check(&contract)?;
    let ts_text = within_width(ts(&entries)).map_err(|long| {
        long.into_iter().map(|e| format!("{TS_TARGET}: {e}")).collect::<Vec<_>>()
    })?;
    Ok(vec![(TS_TARGET.to_owned(), ts_text, false), (RUST_TARGET.to_owned(), rust(&entries), true)])
}

#[cfg(test)]
#[path = "tests/refusals.rs"]
mod tests;
