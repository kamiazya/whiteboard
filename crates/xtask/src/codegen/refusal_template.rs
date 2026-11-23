//! The template language of `contracts/api/refusals.json`: `{name}` fills a
//! param, `{name|filter}` a filtered one, `{{` and `}}` are braces. This is the
//! generator's own reader, which renders each entry's example so the pinned
//! text is checked against the template before either language is emitted.

use std::collections::BTreeMap;

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Ty {
    Str,
    Int,
    List,
}

impl Ty {
    pub(super) fn parse(text: &str) -> Option<Self> {
        match text {
            "string" => Some(Self::Str),
            "integer" => Some(Self::Int),
            "string[]" => Some(Self::List),
            _ => None,
        }
    }

    pub(super) fn rust(self) -> &'static str {
        match self {
            Self::Str => "String",
            Self::Int => "u64",
            Self::List => "Vec<String>",
        }
    }

    pub(super) fn ts(self) -> &'static str {
        match self {
            Self::Str => "string",
            Self::Int => "number",
            Self::List => "readonly string[]",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Filter {
    Json,
    Trim,
    S,
    List,
    AndList,
    JsonList,
    QuotedList,
}

impl Filter {
    pub(super) const ALL: &'static [(&'static str, Self)] = &[
        ("json", Self::Json),
        ("trim", Self::Trim),
        ("s", Self::S),
        ("list", Self::List),
        ("and_list", Self::AndList),
        ("json_list", Self::JsonList),
        ("quoted_list", Self::QuotedList),
    ];

    pub(super) fn parse(text: &str) -> Result<Self, String> {
        Self::ALL
            .iter()
            .find(|(name, _)| *name == text)
            .map(|(_, filter)| *filter)
            .ok_or_else(|| format!("`{text}` is not a filter"))
    }

    pub(super) fn name(self) -> &'static str {
        Self::ALL.iter().find(|(_, filter)| *filter == self).map_or("", |(name, _)| name)
    }

    pub(super) fn takes(self) -> Ty {
        match self {
            Self::Json | Self::Trim => Ty::Str,
            Self::S => Ty::Int,
            Self::List | Self::AndList | Self::JsonList | Self::QuotedList => Ty::List,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Piece {
    Text(String),
    Param { name: String, filter: Option<Filter> },
}

pub(super) fn is_camel(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_alphanumeric())
}

pub(super) fn parse_template(message: &str) -> Result<Vec<Piece>, String> {
    let mut pieces = Vec::new();
    let mut text = String::new();
    let mut chars = message.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' if chars.peek() == Some(&'{') => {
                chars.next();
                text.push('{');
            }
            '}' if chars.peek() == Some(&'}') => {
                chars.next();
                text.push('}');
            }
            '}' => return Err("a `}` closes nothing; write `}}` for a brace".to_owned()),
            '{' => {
                let mut inner = String::new();
                loop {
                    match chars.next() {
                        Some('}') => break,
                        Some(c) => inner.push(c),
                        None => return Err("a `{` is never closed".to_owned()),
                    }
                }
                let (name, filter) = match inner.split_once('|') {
                    Some((name, filter)) => (name, Some(Filter::parse(filter)?)),
                    None => (inner.as_str(), None),
                };
                if !is_camel(name) {
                    return Err(format!("`{name}` is not a param name"));
                }
                if !text.is_empty() {
                    pieces.push(Piece::Text(std::mem::take(&mut text)));
                }
                pieces.push(Piece::Param { name: name.to_owned(), filter });
            }
            other => text.push(other),
        }
    }
    if !text.is_empty() {
        pieces.push(Piece::Text(text));
    }
    Ok(pieces)
}

/// `String.prototype.trim`'s whitespace: not Rust's, which trims U+0085 and
/// keeps U+FEFF.
pub(super) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub(super) fn strings(value: &Value) -> Result<Vec<&str>, String> {
    let items = value.as_array().ok_or("not a list of strings")?;
    items.iter().map(|item| item.as_str().ok_or("not a list of strings".to_owned())).collect()
}

pub(super) fn apply(filter: Filter, value: &Value) -> Result<String, String> {
    let text = || value.as_str().ok_or_else(|| "not a string".to_owned());
    Ok(match filter {
        Filter::Json => serde_json::to_string(text()?).map_err(|e| e.to_string())?,
        Filter::Trim => text()?.trim_matches(is_js_space).to_owned(),
        Filter::S => {
            if value.as_u64() == Some(1) {
                String::new()
            } else {
                "s".to_owned()
            }
        }
        Filter::List => strings(value)?.join(", "),
        Filter::AndList => strings(value)?.join(" and "),
        Filter::JsonList => strings(value)?
            .into_iter()
            .map(|s| serde_json::to_string(s).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?
            .join(", "),
        Filter::QuotedList => {
            strings(value)?.into_iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(", ")
        }
    })
}

pub(super) fn render(
    pieces: &[Piece],
    example: &BTreeMap<String, Value>,
) -> Result<String, String> {
    let mut out = String::new();
    for piece in pieces {
        match piece {
            Piece::Text(text) => out.push_str(text),
            Piece::Param { name, filter } => {
                let value = example.get(name).ok_or_else(|| format!("no example for `{name}`"))?;
                match filter {
                    Some(filter) => out.push_str(&apply(*filter, value)?),
                    None => match value {
                        Value::String(text) => out.push_str(text),
                        other => out.push_str(&other.to_string()),
                    },
                }
            }
        }
    }
    Ok(out)
}
