//! The OKF document the envelope reads and writes, and why it was refused.

use crate::frontmatter::{Refusal, Step};
use whiteboard_model::okf::OkfMarkdownFrontmatter;

/// A mapping in the order JavaScript enumerates its keys: integer-like keys
/// ascending, then the rest as written.
pub use whiteboard_model::Map;

/// An OKF Markdown document: the frontmatter and the body after its fences.
///
/// The frontmatter's shape is `whiteboard-model`'s, generated from
/// `contracts/model/okf.schema.json`; the writer emits its fields in the
/// contract's `x-wb-order`, which is the order `parseOkf` hands them over in.
#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub frontmatter: OkfMarkdownFrontmatter,
    pub body: String,
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

/// What Zod's message for an issue names beyond its code, in Zod's own words
/// for it, so a host can say what was wrong without this crate holding prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detail {
    /// The code needs nothing more: `invalid_format` has one pattern, whose
    /// words the schema carries.
    Nothing,
    /// `invalid_type`: the type the schema names (`string`, `array`,
    /// `object`, `record`) and what the value was (`number`, `null`,
    /// `undefined`, ...).
    Type { expected: &'static str, received: &'static str },
    /// `too_small`: what was measured, `string`, `array`, or `unknown` for
    /// anything else that has a `length`.
    Measured(&'static str),
    /// `custom`: which refinement refused, `actor` or `facet-key`.
    Rule(&'static str),
}

/// One place the schema refused, as Zod reports it: where and why, with the
/// [`Detail`] its message needs and none of the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub path: Vec<Step>,
    pub code: Code,
    pub detail: Detail,
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
