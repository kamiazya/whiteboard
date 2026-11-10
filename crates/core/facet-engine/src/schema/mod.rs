//! The contract dialect (`contracts/`, ADR-0054 decision 8) read at run time:
//! a contract's `$defs` compile into an arena of nodes, and [`Contracts::validate`]
//! judges a [`Value`] against one the way the generated Zod does, issue for
//! issue in path and code and in order. A plugin's payload schemas are the
//! contract files it ships, so a plugin not built into the binary is judged by
//! the same walk as one that is (owner decision q41).
//!
//! What a pattern, a named check or an externally written definition means is
//! the host's: it supplies them by name in a [`Host`], and compiling a
//! contract that names one the host does not supply is refused. The model-only
//! constructs (integers, lenient and kept properties, extension, object and
//! record checks) belong to the model's own port and are refused by name.

mod compile;
pub mod issue;
mod run;

use whiteboard_model::Value;

pub use compile::{CompileError, Refusal};
pub use issue::{Code, Detail, Issue, PathStep};

/// A matcher or a check: the named predicate a string is judged by.
pub type Predicate = fn(&str) -> bool;

/// What validates a definition the contract leaves to the host.
pub type Validator = fn(&Value) -> Result<Value, Vec<Issue>>;

/// How the host stands for an `x-wb-external` definition.
#[derive(Clone, Copy)]
pub enum External {
    /// The contract's own shape for it is the whole of what the external is.
    AsWritten,
    /// The host's validator replaces the shape.
    Validator(Validator),
}

/// What a contract leaves to the host, each by the name the contract gives it.
#[derive(Clone, Copy)]
pub struct Host<'a> {
    pub matchers: &'a [(&'a str, Predicate)],
    pub checks: &'a [(&'a str, Predicate)],
    pub externals: &'a [(&'a str, External)],
}

/// A compiled definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefId(usize);

struct Pattern {
    matcher: Predicate,
    message: Option<String>,
}

struct Field {
    name: String,
    node: usize,
    optional: bool,
    default: Option<Value>,
}

enum Node {
    Str { min: Option<f64>, pattern: Option<Pattern>, check: Option<Predicate> },
    Num { min: Option<f64>, above: Option<f64> },
    Bool,
    Literal(String),
    Enum(Vec<String>),
    Array { item: usize, min: Option<f64>, max: Option<(f64, Option<String>)> },
    Union(Vec<usize>),
    Tagged { property: String, arms: Vec<(String, usize)> },
    Any,
    Ref(DefId),
    Map { key: Option<usize>, value: usize, cap: Option<(f64, String)> },
    Object { fields: Vec<Field>, refuse: bool },
    External(Validator),
}

struct Def {
    contract: String,
    name: String,
    root: usize,
}

/// Contracts compiled and ready to judge values.
pub struct Contracts {
    nodes: Vec<Node>,
    defs: Vec<Def>,
}

impl Contracts {
    /// Compiles each `(path, contract)`, the path being how a manifest points
    /// at it (`facets/visual/visual.schema.json`).
    ///
    /// # Errors
    ///
    /// The first construct that cannot be compiled, by name and where.
    pub fn load(contracts: &[(&str, &Value)], host: &Host<'_>) -> Result<Self, CompileError> {
        compile::load(contracts, host)
    }

    /// The definition a pointer such as `facets/visual/visual.schema.json#/$defs/VisualShapeFacet`
    /// names, if a loaded contract holds it.
    #[must_use]
    pub fn resolve(&self, pointer: &str) -> Option<DefId> {
        let (path, name) = pointer.split_once("#/$defs/")?;
        self.defs.iter().position(|def| def.contract == path && def.name == name).map(DefId)
    }

    /// The name of a compiled definition, or `None` for an id from another set.
    #[must_use]
    pub fn name(&self, def: DefId) -> Option<&str> {
        self.defs.get(def.0).map(|d| d.name.as_str())
    }

    /// Whether the definition is an object that declares `field`: what an
    /// `assetRefs` entry of a manifest names must be one.
    #[must_use]
    pub fn declares(&self, def: DefId, field: &str) -> bool {
        let mut at = self.defs.get(def.0).map(|d| d.root);
        while let Some(Node::Ref(next)) = at.map(|index| self.node(index)) {
            at = self.defs.get(next.0).map(|d| d.root);
        }
        matches!(at.map(|index| self.node(index)), Some(Node::Object { fields, .. }) if fields.iter().any(|f| f.name == field))
    }

    /// What `value` becomes under the definition: the value as the schema
    /// parses it (unknown keys stripped, defaults filled, keys in the
    /// schema's order), or every issue that refuses it.
    ///
    /// # Errors
    ///
    /// The issues, in the order Zod reports them. A `def` from another set of
    /// contracts is refused with one custom issue rather than a panic.
    pub fn validate(&self, def: DefId, value: &Value) -> Result<Value, Vec<Issue>> {
        run::validate(self, def, value)
    }
}

#[cfg(test)]
mod tests;
