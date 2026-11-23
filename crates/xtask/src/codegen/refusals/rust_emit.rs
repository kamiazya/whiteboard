//! The Rust half of the refusals generator: the `Refusal` enum, its
//! `code`/`status`/`message` matches and its examples, written from the same
//! checked entries the TypeScript half reads.

use std::fmt::Write as _;

use serde_json::Value;

use super::*;
pub(super) fn rust_literal(text: &str) -> String {
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

pub(super) fn rust_doc(out: &mut String, indent: usize, text: &str) {
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
    // A lone string param is the message as it is; an integer takes the regular path.
    if let [Piece::Param { name, filter: None }] = e.pieces.as_slice()
        && e.tys.get(name.as_str()) == Some(&Ty::Str)
    {
        return format!("{}.clone()", snake_of_camel(name));
    }
    let mut format = String::new();
    let mut args: Vec<String> = Vec::new();
    for piece in &e.pieces {
        match piece {
            Piece::Text(text) => format.push_str(&braces(text)),
            Piece::Param { name, filter: None } => {
                let _ = write!(format, "{{{}}}", snake_of_camel(name));
            }
            Piece::Param { name, filter: Some(filter) } => {
                // Positional, so no argument name can meet a field's; the call is
                // qualified, so no field can shadow the function.
                let field = snake_of_camel(name);
                let call = match filter {
                    Filter::S => format!("crate::refusal_text::plural_s(*{field})"),
                    other => format!("crate::refusal_text::{}({field})", other.name()),
                };
                let at = args.iter().position(|arg| *arg == call).unwrap_or_else(|| {
                    args.push(call);
                    args.len() - 1
                });
                let _ = write!(format, "{{{at}}}");
            }
        }
    }
    let rest = if args.is_empty() { String::new() } else { format!(", {}", args.join(", ")) };
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

/// Match arms with the same body AND the same bindings written as one arm over
/// their patterns, in the order each first appears: clippy's lint against
/// repeated arms refuses a repeat, and an or-pattern must bind each name at
/// one type. An arm is `(pattern, body, bindings)`, the last empty when the
/// pattern binds nothing.
fn rust_arms(out: &mut String, arms: &[(String, String, String)]) {
    let mut order: Vec<(&str, &str)> = Vec::new();
    let mut by_key: BTreeMap<(&str, &str), Vec<&str>> = BTreeMap::new();
    for (pattern, body, bindings) in arms {
        let key = (body.as_str(), bindings.as_str());
        let patterns = by_key.entry(key).or_default();
        if patterns.is_empty() {
            order.push(key);
        }
        patterns.push(pattern.as_str());
    }
    for key in order {
        let _ = writeln!(out, "            {} => {},", by_key[&key].join(" | "), key.0);
    }
}

fn rust_methods(out: &mut String, entries: &[Checked<'_>]) {
    out.push_str("\nimpl Refusal {\n");
    out.push_str("    /// The stable code a caller branches on.\n");
    out.push_str(EXPECT_LONG_MATCH);
    out.push_str(
        "    #[must_use]\n    pub const fn code(&self) -> &'static str {\n        match self {\n",
    );
    let arms: Vec<(String, String, String)> = entries
        .iter()
        .map(|e| {
            let body = format!("code::{}", e.entry.code.to_ascii_uppercase());
            (rust_pattern(e, false), body, String::new())
        })
        .collect();
    rust_arms(out, &arms);
    out.push_str("        }\n    }\n\n");
    out.push_str("    /// The HTTP status the refusal travels with.\n");
    out.push_str(EXPECT_LONG_MATCH);
    out.push_str(
        "    #[must_use]\n    pub const fn status(&self) -> u16 {\n        match self {\n",
    );
    let arms: Vec<(String, String, String)> = entries
        .iter()
        .map(|e| (rust_pattern(e, false), e.entry.status.to_string(), String::new()))
        .collect();
    rust_arms(out, &arms);
    out.push_str("        }\n    }\n\n");
    out.push_str("    /// The sentence, as the TypeScript says it.\n");
    out.push_str(EXPECT_LONG_MATCH);
    out.push_str("    #[must_use]\n    pub fn message(&self) -> String {\n        match self {\n");
    let arms: Vec<(String, String, String)> = entries
        .iter()
        .map(|e| (rust_pattern(e, true), rust_message(e), format!("{:?}", e.tys)))
        .collect();
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

pub(super) fn rust(entries: &[Checked<'_>]) -> String {
    let mut out = header(SOURCE);
    out.push_str("\nuse std::fmt;\n");
    rust_variants(&mut out, entries);
    rust_codes(&mut out, entries);
    rust_methods(&mut out, entries);
    out.push_str(
        "\nimpl fmt::Display for Refusal {\n    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {\n        f.write_str(&self.message())\n    }\n}\n",
    );
    rust_examples(&mut out, entries);
    out
}
