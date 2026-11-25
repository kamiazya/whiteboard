//! The Rust half of the refusals generator: a table of one row per refusal,
//! read by a macro that writes the `Refusal` enum, its `code`/`status`/
//! `message` and its examples, from the same checked entries the TypeScript
//! half reads.

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

/// The codes' own file: every code a refusal carries, and the lists of them.
pub(super) fn rust_codes(entries: &[Checked<'_>]) -> String {
    let mut out = header(SOURCE);
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
    out
}

/// The macro the rows are written through: one row per refusal is the table,
/// and the enum, the three accessors and the examples are each written once
/// over it, so a refusal added to the contract adds a row and lengthens no
/// function.
const TABLE_MACRO: &str = r"
/// Writes the `Refusal` enum, its `code`, `status` and `message`, and the
/// test-only `examples` from one row per refusal: its doc, its variant, its
/// code, status and sentence, and the example the contract pins for it.
macro_rules! refusals {
    ($(
        $(#[$doc:meta])*
        $name:ident $({ $($field:ident: $ty:ty),* $(,)? })? => $code:expr, $status:expr, $message:expr;
        example $({ $($given:ident: $value:expr),* $(,)? })?;
    )*) => {
        /// A refusal: the code and status a request is answered with, and its sentence.
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub enum Refusal {
            $($(#[$doc])* $name $({ $($field: $ty),* })?,)*
        }

        impl Refusal {
            /// The stable code a caller branches on.
            #[must_use]
            pub const fn code(&self) -> &'static str {
                match self {
                    $(Self::$name { .. } => $code,)*
                }
            }

            /// The HTTP status the refusal travels with.
            #[must_use]
            pub const fn status(&self) -> u16 {
                match self {
                    $(Self::$name { .. } => $status,)*
                }
            }

            /// The sentence, as the TypeScript says it.
            #[must_use]
            pub fn message(&self) -> String {
                match self {
                    $(Self::$name $({ $($field),* })? => $message,)*
                }
            }
        }

        /// Each refusal built from the example the contract pins for it, by name.
        #[cfg(test)]
        pub(crate) fn examples() -> Vec<(&'static str, Refusal)> {
            vec![$((stringify!($name), Refusal::$name $({ $($given: $value),* })?),)*]
        }
    };
}
";

/// One row of the table: the variant with its fields, then its code, status
/// and sentence, then the example it is built from in the tests.
fn rust_row(out: &mut String, e: &Checked<'_>) {
    rust_doc(out, 4, &e.entry.description);
    let fields = |each: &dyn Fn(&str, Ty) -> String| -> String {
        if e.tys.is_empty() {
            return String::new();
        }
        let fields: Vec<String> = e.tys.iter().map(|(name, ty)| each(name, *ty)).collect();
        format!(" {{ {} }}", fields.join(", "))
    };
    let declared = fields(&|name, ty| format!("{}: {}", snake_of_camel(name), ty.rust()));
    let _ = writeln!(
        out,
        "    {}{declared}\n        => code::{}, {}, {};",
        e.entry.name,
        e.entry.code.to_ascii_uppercase(),
        e.entry.status,
        rust_message(e)
    );
    let given = fields(&|name, ty| {
        format!("{}: {}", snake_of_camel(name), rust_example(&e.entry.example[name], ty))
    });
    let _ = writeln!(out, "    example{given};");
}

pub(super) fn rust(entries: &[Checked<'_>]) -> String {
    let mut out = header(SOURCE);
    out.push_str("\nuse std::fmt;\n\nuse crate::refusal_codes::code;\n");
    out.push_str(TABLE_MACRO);
    out.push_str("\nrefusals! {\n");
    for e in entries {
        rust_row(&mut out, e);
    }
    out.push_str("}\n");
    out.push_str(
        "\nimpl fmt::Display for Refusal {\n    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {\n        f.write_str(&self.message())\n    }\n}\n",
    )
    ;
    out
}
