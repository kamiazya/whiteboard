//! What the frontmatter reader produces and the writer takes.

/// A frontmatter value: what `yaml`'s core schema makes of a document, as
/// `toJS()` hands it to the TypeScript.
///
/// The crate carries its own ordered tree because `whiteboard-model`, which
/// will own the document model, is not ported yet. A mapping keeps its keys
/// in written order; a JavaScript object enumerates integer-like keys first,
/// which is a property of that host and is applied where a host needs it
/// (the recorded-oracle test does), not here.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    /// A double. An integer written within +-2^53 lands here.
    Number(f64),
    /// An integer written past 2^53 whose digits the double cannot hold, as
    /// the signed decimal digits it was written as. The TypeScript reads it
    /// as a `bigint`, which `yamlSafeValueSchema` refuses by name.
    BigInt(String),
    String(String),
    Seq(Vec<Value>),
    Map(Vec<(String, Value)>),
}

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

/// Why a value has no spelling in the frontmatter subset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unwritable {
    /// `NaN` or an infinity: YAML core schema has no tag this repository emits for them.
    NonFiniteNumber,
    /// A byte-order mark in a key or a string, which `parse` refuses wherever it sits.
    ByteOrderMark,
    /// A key named `__proto__`, which `parseOkf` refuses.
    ReservedKey,
    /// An integer past 2^53, which the TypeScript holds as a `bigint`.
    BigInt,
    /// Collections nested past [`MAX_PARSE_DEPTH`]: the reader would refuse
    /// the text, and the stack would not hold the writer's recursion.
    TooDeep,
}
