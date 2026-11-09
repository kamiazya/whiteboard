//! The OKF document the envelope reads and writes, and why it was refused.

use crate::frontmatter::Refusal;

/// A mapping in the order JavaScript enumerates its keys: integer-like keys
/// ascending, then the rest as written.
pub use whiteboard_model::Map;

/// An OKF Markdown document: the frontmatter and the body after its fences.
///
/// The types here are this crate's own because `whiteboard-model`, which
/// will own the document model, is not ported yet; they follow the Zod
/// schemas of `packages/model` (`coreFacetsSchema`, `okfTrustEventSchema`)
/// and `packages/codec` (`okfMarkdownFrontmatterSchema`) field for field.
#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub frontmatter: Frontmatter,
    pub body: String,
}

/// The frontmatter, with the keys the schema models as fields and every other
/// root key under [`Frontmatter::facets_raw`].
///
/// The writer emits the fields in the order written here, which is the order
/// `parseOkf` hands them over in; a TypeScript caller who built the object
/// in another order gets this one.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Frontmatter {
    pub r#type: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub resource: Option<String>,
    pub tags: Option<Vec<String>>,
    pub view: Option<String>,
    pub generated: Option<TrustEvent>,
    pub verified: Option<Vec<TrustEvent>>,
    /// Extension facets, keyed `{namespace}.{name}/v{n}`.
    pub facets: Option<Map>,
    /// Root keys the document does not model, kept as written (OKF §4.1).
    pub facets_raw: Option<Map>,
}

/// One entry of OKF's trust family (§5.2): who, when, and whatever else the
/// producer wrote, which the schema keeps. It is written `by`, `at`, then the
/// rest, which is the order `parseOkf` hands it over in.
#[derive(Debug, Clone, PartialEq)]
pub struct TrustEvent {
    pub by: String,
    pub at: String,
    pub extra: Map,
}

/// A step of a path into the frontmatter: a key or a list index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Key(String),
    Index(usize),
}

/// The Zod issue codes the schema can raise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    /// The value is not the type the schema names, or is missing.
    InvalidType,
    /// A string is shorter than the schema allows.
    TooSmall,
    /// A string is not in the format the schema names.
    InvalidFormat,
    /// A refinement the schema states in code failed.
    Custom,
}

/// One place the schema refused, as Zod reports it: where and why, without
/// the message text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub path: Vec<Step>,
    pub code: Code,
}

/// Why a text was not read as an OKF document, by the stage the TypeScript
/// names it at.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// Stage `yaml`: the frontmatter is not read by the YAML reader.
    Yaml(Refusal),
    /// Stage `frontmatter-schema`: the text does not open with a fenced block.
    NoFence,
    /// Stage `frontmatter-schema`: some mapping holds the key `__proto__`.
    ReservedKey,
    /// Stage `frontmatter-schema`: the schema refused, at each of these.
    Schema(Vec<Issue>),
}
