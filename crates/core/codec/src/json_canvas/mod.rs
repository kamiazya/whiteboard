//! JSON Canvas 1.0 with the `x-whiteboard` extension: `parseSpatial` and
//! `serializeSpatial`, read and written as the TypeScript reads and writes
//! them.
//!
//! A text is read as JSON ([`json`]), refused if it carries the conversation an
//! export no longer holds, validated against the wire schema as Zod validates
//! it ([`wire`], [`extension`], [`schema`]) and lifted into
//! `whiteboard_model`'s canvas. A canvas is projected onto the wire
//! ([`project`]) and written as `JSON.stringify` writes it ([`stringify`]); the
//! strict mode validates what it wrote against the same wire schema first.
//!
//! The wire schema is not the model's: it names JSON Canvas 1.0's four node
//! types and edge keys, ignores a key it does not know, and loses a malformed
//! `x-whiteboard` bucket without a word. The model's own checks (unique ids
//! across edges and lines, a line's ends naming nodes that exist) are the
//! model's, and `parseSpatial` does not run them.
//!
//! Where the core cannot answer it declines ([`Decline`]) and the caller asks
//! the TypeScript: a lone UTF-16 surrogate, nesting past [`MAX_DEPTH`], a text
//! over [`MAX_BYTES`], and a link whose validity as a URL needs tables this
//! crate does not carry. A refusal's message is not reproduced; a [`Failure`]
//! carries the stage and, for the schema, each issue's path and code.

mod extension;
mod issue;
mod json;
mod length;
mod project;
mod schema;
mod stringify;
mod url;
mod wire;

pub use issue::{Code, Decline, Failure, Issue, Mode, PathStep, WriteFailure};
pub use json::MAX_DEPTH;
pub use stringify::MAX_DEPTH as MAX_WRITE_DEPTH;
pub use whiteboard_model::spatial::SpatialCanvas;

use whiteboard_model::Value;

/// The longest text read. `JSON.parse` has no limit of its own; a core that
/// copies the text into a tree needs one, and a board past it is answered by
/// the TypeScript.
pub const MAX_BYTES: usize = 4 * 1024 * 1024;

/// Reads JSON Canvas text as `parseSpatial` does.
pub fn parse(text: &str) -> Result<SpatialCanvas, Failure> {
    if text.len() > MAX_BYTES {
        return Err(Failure::Declined(Decline::TooLarge));
    }
    let value = json::parse(text).map_err(|why| match why {
        json::Refusal::Syntax => Failure::Syntax,
        json::Refusal::LoneSurrogate => Failure::Declined(Decline::LoneSurrogate),
        json::Refusal::TooDeep => Failure::Declined(Decline::TooDeep),
    })?;
    if carries_conversation(&value) {
        return Err(Failure::Conversation);
    }
    wire::document(&value)
}

/// Writes a canvas as `serializeSpatial` does.
pub fn serialize(canvas: &SpatialCanvas, mode: Mode) -> Result<String, WriteFailure> {
    let wire = project::document(canvas, mode);
    if mode == Mode::Strict {
        // The projection builds an object and writes no conversation, so a
        // failure of the wire schema is the only one it can meet.
        match wire::document(&wire) {
            Err(Failure::Schema(issues)) => return Err(WriteFailure::Schema(issues)),
            Err(Failure::Declined(why)) => return Err(WriteFailure::Declined(why)),
            _ => {}
        }
    }
    stringify::stringify(&wire).map_err(|why| {
        WriteFailure::Declined(match why {
            stringify::Unwritable::TooDeep => Decline::TooDeep,
            stringify::Unwritable::BigInt => Decline::Unwritable,
        })
    })
}

/// Whether a file still holds the annotation layer an older export wrote into
/// the canvas-level extension: a non-empty `x-whiteboard.comments` list.
fn carries_conversation(value: &Value) -> bool {
    let Some(root) = schema::object(value) else { return false };
    let Some(extension) = schema::get(root, "x-whiteboard").and_then(schema::object) else {
        return false;
    };
    matches!(schema::get(extension, "comments"), Some(Value::Seq(comments)) if !comments.is_empty())
}
