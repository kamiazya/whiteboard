//! What the codec answers when it does not read or write a document.

pub use whiteboard_model::checks::PathStep;

/// The Zod issue codes the wire schema can raise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    /// The value is not the type the schema names, or is missing.
    InvalidType,
    /// A string or a number is under what the schema allows.
    TooSmall,
    /// A number is over what the schema allows.
    TooBig,
    /// A string is not in the format the schema names.
    InvalidFormat,
    /// A value is not one of an enumeration's.
    InvalidValue,
    /// No arm of a union accepts the value.
    InvalidUnion,
    /// A refinement the schema states in code failed.
    Custom,
}

/// One place the schema refused, as Zod reports it: where and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub path: Vec<PathStep>,
    pub code: Code,
    /// The text of a refinement the schema states in code (a repeated id, an
    /// edge that names no node), which names the id it is about. An issue Zod
    /// words itself has none: its text is not reproduced.
    pub message: Option<String>,
}

/// Why the core will not answer, so that the caller asks the TypeScript. Each
/// is an input the TypeScript reads or writes and this crate does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decline {
    /// A text over [`super::MAX_BYTES`].
    TooLarge,
    /// Nesting past [`super::MAX_DEPTH`] on the way in, or past the writer's cap.
    TooDeep,
    /// A string with a lone UTF-16 surrogate, which a Rust `String` cannot hold.
    LoneSurrogate,
    /// A value JSON has no spelling for.
    Unwritable,
}

/// Why a text was not read as a document, by the stage the TypeScript names it at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// Stage `json-syntax`: the text is not JSON.
    Syntax,
    /// Stage `json-canvas-schema`: the file carries `x-whiteboard.comments`,
    /// a conversation an exported file no longer holds.
    Conversation,
    /// Stage `json-canvas-schema`: the schema refused, at each of these.
    Schema(Vec<Issue>),
    /// The core does not answer.
    Declined(Decline),
}

/// Why a document was not written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteFailure {
    /// The strict mode re-validates what it wrote against the wire schema, and
    /// the schema refused it, at each of these.
    Schema(Vec<Issue>),
    /// The core does not answer.
    Declined(Decline),
}

/// How a document is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// JSON Canvas 1.0 alone: no `x-whiteboard` anywhere, re-validated.
    Strict,
    /// JSON Canvas 1.0 plus `x-whiteboard`, which holds everything the format cannot.
    Extended,
}
