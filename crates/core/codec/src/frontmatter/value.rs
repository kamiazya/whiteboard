//! What the frontmatter reader produces and the writer takes.

pub use whiteboard_model::Value;

/// Why a frontmatter text was not read. The class is the TypeScript reader's
/// own: it is what `oracle` records beside every refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The YAML is malformed, or breaks a rule the `yaml` package enforces
    /// (a duplicate key, an implicit key past 1024 units).
    Syntax(&'static str),
    /// An anchor or an alias: OKF gives them no meaning.
    Anchor,
    /// Collections nested past [`MAX_DEPTH`].
    Depth,
    /// Well-formed YAML outside the restricted subset the reader accepts.
    Subset(&'static str),
    /// The text is longer than [`MAX_BYTES`].
    TooLarge,
}

/// The most UTF-8 bytes `parse` reads; a longer text is refused. Frontmatter
/// is a document's metadata, and a facet payload is a handful of kilobytes.
pub const MAX_BYTES: usize = 262_144;

/// The most collections one value may sit inside, the root mapping included.
pub const MAX_DEPTH: usize = 32;

/// How deep the parse recurses before it refuses a document outright.
/// Between [`MAX_DEPTH`] and this the parse goes on, so that a document
/// malformed further down is named malformed, as the TypeScript names it.
pub const MAX_PARSE_DEPTH: usize = 64;

/// The most bytes of faults [`stringify`](super::stringify) collects (each
/// path's keys, a few bytes a step and the reason) before it stops and reports
/// [`Unwritable::Overflow`]. Every fault repeats its path, so a value of nested
/// long keys with many leaves that have no spelling would otherwise answer
/// hundreds of megabytes for a wire of a few hundred kilobytes. The answer is
/// then a little over a megabyte at most.
pub const MAX_FAULT_BYTES: usize = 1_048_576;

/// A step of a path into a value: a key or a list index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Key(String),
    Index(usize),
}

/// Why a value has no spelling in the frontmatter subset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unwritable {
    /// `NaN`: YAML core schema has no tag this repository emits for it.
    Nan,
    /// `Infinity`.
    Infinity,
    /// `-Infinity`.
    NegativeInfinity,
    /// A byte-order mark in a key or a string, which `parse` refuses wherever it sits.
    ByteOrderMark,
    /// A key named `__proto__`, which `parseOkf` refuses.
    ReservedKey,
    /// An integer past 2^53, which the TypeScript holds as a `bigint`.
    BigInt,
    /// Collections nested past [`MAX_PARSE_DEPTH`]: the reader would refuse
    /// the text, and the stack would not hold the writer's recursion.
    TooDeep,
    /// Not a place: more faults than [`MAX_FAULT_BYTES`] hold, so the list ends here.
    Overflow,
}

/// One place a value has no spelling: where, and why. A key that has none is
/// reported at the mapping holding it, since the key may be the unprintable
/// part, and a `__proto__` key at the root, once, wherever it sits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    pub path: Vec<Step>,
    pub why: Unwritable,
}
