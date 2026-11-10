//! The OKF Markdown envelope: a document's frontmatter between `---` fences
//! and its body after them, read as `parseOkf` reads it and written as
//! `serializeOkf` writes it.
//!
//! The frontmatter YAML itself is [`crate::frontmatter`]'s. What this module
//! adds is the part around it: the fence split, the refusal of the reserved
//! key, the routing of unknown root keys, and the schema.
//!
//! One thing differs from the TypeScript by construction, and the recorded
//! oracle declares it: a lone UTF-16 surrogate cannot be held by a Rust
//! `String`, so the caller of the wasm export must refuse one (the
//! TypeScript refuses it in the frontmatter too, at the read and the write)
//! before it reaches this module. Refusal messages are not reproduced; a
//! [`Failure`] carries the stage, the class and, for the schema, each issue's
//! path and code.

mod document;
mod fence;
mod js;
mod schema;
mod write;

pub use crate::frontmatter::{Fault, Step};
pub use document::{Code, Document, Failure, Issue, Map};
pub use js::{array_index, enumeration_order};
pub use whiteboard_model::okf::{OkfMarkdownFrontmatter, OkfTrustEvent};

use crate::frontmatter::{self, Refusal, Value};

/// Whether a text opens with an OKF frontmatter block, which `parse` would
/// then try to read. True says nothing about whether the block is well formed.
#[must_use]
pub fn has_frontmatter(text: &str) -> bool {
    fence::split(text).is_some()
}

/// Reads a whole OKF document as `parseOkf` does.
///
/// A frontmatter text over [`frontmatter::MAX_BYTES`] is refused as a YAML
/// syntax error, as `frontmatter::parse` refuses it.
pub fn parse(text: &str) -> Result<Document, Failure> {
    parse_marked(text, None)
}

/// [`parse`] of a text in which the host put `mark` where it held a lone
/// UTF-16 surrogate, which no `&str` can hold. A mark that reaches a string or
/// a key of the frontmatter is the TypeScript's refusal of one (a stage `yaml`
/// subset refusal, after any other YAML fault and before the schema); one
/// that sits in a comment or outside the frontmatter is nothing. The host
/// chooses a mark the text holds nowhere else.
pub fn parse_marked(text: &str, mark: Option<char>) -> Result<Document, Failure> {
    let (yaml, body) = fence::split(text).ok_or(Failure::NoFence)?;
    let read = frontmatter::parse(yaml).map_err(Failure::Yaml)?;
    if mark.is_some_and(|mark| holds_mark(&read, mark)) {
        return Err(Failure::Yaml(Refusal::Subset("a lone UTF-16 surrogate")));
    }
    let read = js::enumeration_order(read);
    if holds_reserved_key(&read) {
        return Err(Failure::ReservedKey);
    }
    let frontmatter = schema::frontmatter(read).map_err(Failure::Schema)?;
    Ok(Document { frontmatter, body: body.to_string() })
}

/// Writes a document as `serializeOkf` does, or says each place its
/// frontmatter has no spelling.
pub fn serialize(document: &Document) -> Result<String, Vec<Fault>> {
    write::document(document)
}

/// Whether a string or a key of `value` holds `mark`.
fn holds_mark(value: &Value, mark: char) -> bool {
    match value {
        Value::String(text) => text.contains(mark),
        Value::Seq(items) => items.iter().any(|item| holds_mark(item, mark)),
        Value::Map(entries) => {
            entries.iter().any(|(name, item)| name.contains(mark) || holds_mark(item, mark))
        }
        _ => false,
    }
}

/// `holdsReservedKey` over what the YAML reader produces: a mapping with the
/// key `__proto__` at any depth.
fn holds_reserved_key(value: &Value) -> bool {
    match value {
        Value::Seq(items) => items.iter().any(holds_reserved_key),
        Value::Map(entries) => {
            entries.iter().any(|(name, item)| name == "__proto__" || holds_reserved_key(item))
        }
        _ => false,
    }
}
