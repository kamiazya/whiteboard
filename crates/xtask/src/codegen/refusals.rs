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

mod rust_emit;

use super::caps::rust_int;
use super::emit::{header, within_width};
use super::refusal_template::{Filter, Piece, Ty, is_camel, parse_template, render, strings};
use rust_emit::rust;

pub(super) const SOURCE: &str = "contracts/api/refusals.json";
const TS_TARGET: &str = "packages/model/src/generated/refusals.ts";
/// A refusal with a `module` goes to that package's own `src/generated/refusals.ts`.
const RUST_TARGET: &str = "crates/ops/api-contracts/src/generated/refusals.rs";

const STATUSES: &[u16] = &[400, 404, 409, 413, 500, 503];
const FAMILIES: &[&str] = &["sync-write", "version"];
/// The breach tables the TypeScript half emits, with the constant each is.
const BREACH_TABLES: &[(&str, &str)] =
    &[("text", "SYNC_TEXT_BREACH_CODES"), ("workspace", "SYNC_WORKSPACE_BREACH_CODES")];
/// The widest a doc comment is wrapped, under biome's and rustfmt's 100.
const COMMENT_WIDTH: usize = 92;
/// biome.json's `lineWidth`, which decides where a property's string moves to its own line.
const TS_LINE_WIDTH: usize = 100;
/// The largest integer a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Words a TypeScript parameter cannot be named, and `i`, the name the list
/// filters use for an item.
const JS_RESERVED: &[&str] = &[
    "arguments",
    "case",
    "catch",
    "class",
    "default",
    "delete",
    "eval",
    "export",
    "finally",
    "function",
    "i",
    "implements",
    "import",
    "interface",
    "let",
    "new",
    "null",
    "of",
    "package",
    "private",
    "protected",
    "public",
    "switch",
    "this",
    "throw",
    "var",
    "void",
    "with",
];

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

/// The sync judge's breach shape this entry answers: the key of a table of
/// `SYNC_TEXT_BREACH_CODES` or `SYNC_WORKSPACE_BREACH_CODES`, which maps it to
/// the entry's code.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Breach {
    table: String,
    shape: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Entry {
    name: String,
    code: String,
    status: u16,
    family: Option<String>,
    breach: Option<Breach>,
    module: Option<String>,
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
    if let Some(breach) = &entry.breach {
        if !BREACH_TABLES.iter().any(|(table, _)| *table == breach.table) {
            return Err(format!("breach table `{}` is not one of {BREACH_TABLES:?}", breach.table));
        }
        if entry.family.as_deref() != Some("sync-write") {
            return Err("a breach shape is answered by a sync-write refusal".to_owned());
        }
        let kebab = breach.shape.starts_with(|c: char| c.is_ascii_lowercase())
            && !breach.shape.ends_with('-')
            && !breach.shape.contains("--")
            && breach.shape.chars().all(|c| c.is_ascii_lowercase() || c == '-');
        if !kebab {
            return Err(format!("breach shape `{}` is not lowercase kebab-case", breach.shape));
        }
    }
    if let Some(module) = &entry.module {
        let ok = module.starts_with(|c: char| c.is_ascii_lowercase())
            && !module.ends_with('-')
            && !module.contains("--")
            && module.chars().all(|c| c.is_ascii_lowercase() || c == '-');
        if !ok {
            return Err(format!("module `{module}` is not a package directory name"));
        }
    }
    if entry.description.contains("*/") {
        return Err("description holds `*/`, which would end its generated doc comment".to_owned());
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
        if !is_camel(name)
            || RUST_KEYWORDS.contains(&name.as_str())
            || JS_RESERVED.contains(&name.as_str())
        {
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
    let mut keys: BTreeMap<String, &str> = BTreeMap::new();
    for entry in &contract.refusals {
        let key = camel_of_code(&entry.code);
        match keys.get(&key) {
            Some(other) if *other != entry.code => errors.push(format!(
                "{SOURCE}: codes `{other}` and `{}` are both `{key}` in REFUSAL_CODES",
                entry.code
            )),
            _ => {
                keys.insert(key, &entry.code);
            }
        }
    }
    let mut shapes = BTreeSet::new();
    for entry in &contract.refusals {
        let Some(breach) = &entry.breach else { continue };
        if !shapes.insert((breach.table.as_str(), breach.shape.as_str())) {
            errors.push(format!(
                "{SOURCE}: breach shape `{}` of table `{}` is answered by two entries",
                breach.shape, breach.table
            ));
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

/// An array literal on one line where it fits, else one item to a line.
fn ts_array(out: &mut String, lead: &str, items: &[String]) {
    let literals = items;
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

/// A template literal's text: the characters it may not hold raw escaped.
fn ts_template_text(text: &str) -> String {
    text.replace('`', "\\`").replace("${", "\\${")
}

/// What a filter turns a param into, as the TypeScript expression a template
/// literal interpolates.
fn ts_filtered(filter: Option<Filter>, field: &str) -> String {
    let p = field.to_owned();
    match filter {
        None => p,
        Some(Filter::Json) => format!("JSON.stringify({p})"),
        Some(Filter::Trim) => format!("{p}.trim()"),
        Some(Filter::S) => format!("{p} === 1 ? '' : 's'"),
        Some(Filter::List) => format!("{p}.join(', ')"),
        Some(Filter::AndList) => format!("{p}.join(' and ')"),
        Some(Filter::JsonList) => format!("{p}.map((i) => JSON.stringify(i)).join(', ')"),
        Some(Filter::QuotedList) => format!("{p}.map((i) => `\"${{i}}\"`).join(', ')"),
    }
}

/// One refusal as an exported function from its params to its sentence, the
/// template compiled the way the Rust half compiles it into a `format!`.
/// The params in the order the message first names them, which is the order a
/// TypeScript function takes them.
fn param_order<'a>(e: &'a Checked<'_>) -> Vec<&'a str> {
    let mut order: Vec<&str> = Vec::new();
    for piece in &e.pieces {
        if let Piece::Param { name, .. } = piece
            && !order.contains(&name.as_str())
        {
            order.push(name);
        }
    }
    order
}

/// The signature on one line where it fits, else one param to a line.
fn ts_signature(e: &Checked<'_>, order: &[&str]) -> String {
    let name = &e.entry.name;
    let params: Vec<String> = order.iter().map(|p| format!("{p}: {}", e.tys[p].ts())).collect();
    let one = format!("export const {name} = ({}) =>", params.join(", "));
    if one.chars().count() <= TS_LINE_WIDTH {
        return one;
    }
    let many = params.iter().fold(String::new(), |mut acc, p| {
        let _ = writeln!(acc, "  {p},");
        acc
    });
    format!("export const {name} = (\n{many}) =>")
}

/// One refusal as an exported function from its params to its sentence, the
/// template compiled the way the Rust half compiles it into a `format!`.
fn ts_refusal(out: &mut String, e: &Checked<'_>) {
    let order = param_order(e);
    let signature = ts_signature(e, &order);
    let body = if order.is_empty() {
        let text: String = e
            .pieces
            .iter()
            .map(|piece| match piece {
                Piece::Text(text) => text.as_str(),
                Piece::Param { .. } => "",
            })
            .collect();
        ts_literal(&text)
    } else {
        let mut text = String::from("`");
        for piece in &e.pieces {
            match piece {
                Piece::Text(t) => text.push_str(&ts_template_text(t)),
                Piece::Param { name, filter } => {
                    let _ = write!(text, "${{{}}}", ts_filtered(*filter, name));
                }
            }
        }
        text.push('`');
        text
    };
    let last = signature.rsplit('\n').next().unwrap_or_default();
    let join = if format!("{last} {body}").chars().count() <= TS_LINE_WIDTH { " " } else { "\n  " };
    let _ = writeln!(out, "{signature}{join}{body}");
}

/// The refusals one package holds, apart from the main file: the web build
/// places each package in a chunk of its own, so a refusal only a lazily loaded
/// package raises is kept in that package and stays in that chunk.
fn ts_module(entries: &[Checked<'_>], module: &str) -> String {
    let mut out = header(SOURCE);
    out.push_str(
        "\n// One function per refusal, in a module of their own so they stay with their raiser.\n",
    );
    for e in entries.iter().filter(|e| e.entry.module.as_deref() == Some(module)) {
        out.push('\n');
        ts_doc(&mut out, 0, &e.entry.description);
        ts_refusal(&mut out, e);
    }
    out
}

fn ts(entries: &[Checked<'_>]) -> String {
    let mut out = header(SOURCE);
    out.push_str(
        "\n// One function per refusal, so a bundle carries only the sentences it raises.\n",
    );
    for e in entries.iter().filter(|e| e.entry.module.is_none()) {
        out.push('\n');
        ts_doc(&mut out, 0, &e.entry.description);
        ts_refusal(&mut out, e);
    }
    out.push_str("\n// One export per code, so a bundle carries only the codes it answers with.\n");
    for code in distinct_codes(entries) {
        let line = format!(
            "export const REFUSAL_CODE_{} = {}",
            code.to_ascii_uppercase(),
            ts_literal(code)
        );
        if line.chars().count() <= TS_LINE_WIDTH {
            let _ = writeln!(out, "{line}");
        } else {
            let _ = writeln!(
                out,
                "export const REFUSAL_CODE_{} =\n  {}",
                code.to_ascii_uppercase(),
                ts_literal(code)
            );
        }
    }
    out.push_str("\n/** Every code a refusal carries, keyed by the camelCase of the code. */\n");
    out.push_str("export const REFUSAL_CODES = {\n");
    for code in distinct_codes(entries) {
        let _ =
            writeln!(out, "  {}: REFUSAL_CODE_{},", camel_of_code(code), code.to_ascii_uppercase());
    }
    out.push_str("} as const\n");
    out.push_str("\n/** A code a refusal carries. */\n");
    out.push_str("export type RefusalCode = (typeof REFUSAL_CODES)[keyof typeof REFUSAL_CODES]\n");
    for (family, name, what) in [
        ("sync-write", "SYNC_WRITE_REFUSAL_CODES", "a keeper refuses a sync write with"),
        ("version", "VERSION_REFUSAL_CODES", "a keeper refuses a version save with"),
    ] {
        let _ = write!(out, "\n/** The codes {what}. */\n");
        let items: Vec<String> =
            family_codes(entries, family).iter().map(|code| ts_literal(code)).collect();
        ts_array(&mut out, &format!("export const {name} = "), &items);
    }
    let sync_codes = family_codes(entries, "sync-write");
    for (table, name) in BREACH_TABLES {
        let _ = write!(
            out,
            "\n/** The code each {table} breach shape of a sync write is answered with. */\nexport const {name} = {{\n"
        );
        for e in entries {
            let Some(breach) = e.entry.breach.as_ref().filter(|b| b.table == *table) else {
                continue;
            };
            let key = if breach.shape.contains('-') {
                ts_literal(&breach.shape)
            } else {
                breach.shape.clone()
            };
            // The family list holds each code once; a table names it by position.
            let at = sync_codes.iter().position(|code| *code == e.entry.code).unwrap_or_default();
            let _ = writeln!(out, "  {key}: SYNC_WRITE_REFUSAL_CODES[{at}],");
        }
        out.push_str("} as const\n");
    }
    out
}

/// The refusals' outputs, as `(repo-relative path, content, is the Rust half)`,
/// the Rust half not yet formatted.
pub(super) fn generate(text: &str) -> Result<Vec<(String, String, bool)>, Vec<String>> {
    let contract: Contract = serde_json::from_str(text)
        .map_err(|e| vec![format!("{SOURCE}: not the refusals contract: {e}")])?;
    let entries = check(&contract)?;
    let mut files = Vec::new();
    let mut modules: Vec<&str> = entries.iter().filter_map(|e| e.entry.module.as_deref()).collect();
    modules.sort_unstable();
    modules.dedup();
    let mut texts = vec![(TS_TARGET.to_owned(), ts(&entries))];
    for module in modules {
        texts.push((
            format!("packages/{module}/src/generated/refusals.ts"),
            ts_module(&entries, module),
        ));
    }
    for (target, text) in texts {
        let text = within_width(text).map_err(|long| {
            long.into_iter().map(|e| format!("{target}: {e}")).collect::<Vec<_>>()
        })?;
        files.push((target, text, false));
    }
    files.push((RUST_TARGET.to_owned(), rust(&entries), true));
    Ok(files)
}

#[cfg(test)]
#[path = "tests/refusals.rs"]
mod tests;
