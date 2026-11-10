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

pub use document::{Code, Document, Failure, Issue, Map, Step};
pub use js::{array_index, enumeration_order};
pub use whiteboard_model::okf::{OkfMarkdownFrontmatter, OkfTrustEvent};

use crate::frontmatter::{self, Unwritable, Value};

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
    let (yaml, body) = fence::split(text).ok_or(Failure::NoFence)?;
    let read = frontmatter::parse(yaml).map_err(Failure::Yaml)?;
    let read = js::enumeration_order(read);
    if holds_reserved_key(&read) {
        return Err(Failure::ReservedKey);
    }
    let frontmatter = schema::frontmatter(read).map_err(Failure::Schema)?;
    Ok(Document { frontmatter, body: body.to_string() })
}

/// Writes a document as `serializeOkf` does, or says why its frontmatter has
/// no spelling.
pub fn serialize(document: &Document) -> Result<String, Unwritable> {
    write::document(document)
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
