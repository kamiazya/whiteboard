//! What a refusal says, in the shape Zod's issues have: a path, a code, and
//! what the code carries. The wording is the contract's where the contract
//! has one and otherwise absent: the oracle holds the path and the code, in
//! order, and nothing else.

/// One step of where an issue sits in the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathStep {
    Key(String),
    Index(usize),
}

/// The class of a refusal; each is the Zod issue code of the same name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    InvalidType,
    TooSmall,
    TooBig,
    InvalidFormat,
    InvalidValue,
    UnrecognizedKeys,
    InvalidUnion,
    InvalidKey,
    Custom,
}

/// What an issue carries beyond its path and code.
#[derive(Debug, Clone, PartialEq)]
pub enum Detail {
    None,
    /// The contract's own sentence for the refusal, where it wrote one.
    Message(String),
    /// The keys an object refused, in the order the input held them.
    Keys(Vec<String>),
    /// Why each arm of a union refused, in arm order. Empty for a tagged union
    /// that found no arm for its tag.
    Arms(Vec<Vec<Issue>>),
    /// Why a record's key was refused; the paths are relative to the key.
    Key(Vec<Issue>),
}

/// One refusal.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub path: Vec<PathStep>,
    pub code: Code,
    pub detail: Detail,
    /// Zod's `continue` flag: a refusal that does not stop what judges the
    /// same value next, and does not make a union arm "aborted".
    pub continues: bool,
}

impl Issue {
    /// An issue at the value itself that stops further judging of it.
    pub(crate) fn here(code: Code) -> Self {
        Self { path: Vec::new(), code, detail: Detail::None, continues: false }
    }

    /// An issue at the value itself that lets its other checks run.
    pub(crate) fn soft(code: Code) -> Self {
        Self { continues: true, ..Self::here(code) }
    }

    pub(crate) fn with(mut self, detail: Detail) -> Self {
        self.detail = detail;
        self
    }

    /// This issue one step deeper in the input. The issues an arm or a key
    /// carries are relative to that arm or key and are never prefixed.
    pub(crate) fn under(mut self, step: PathStep) -> Self {
        self.path.insert(0, step);
        self
    }
}

/// Whether any of `issues` stops what would judge the value next, which is
/// what Zod's `aborted` asks of a union arm.
pub(crate) fn aborted(issues: &[Issue]) -> bool {
    issues.iter().any(|issue| !issue.continues)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn an_issue_moves_one_step_deeper_without_touching_what_it_carries() {
        let inner = Issue::here(Code::InvalidType);
        let issue = Issue::soft(Code::InvalidUnion)
            .with(Detail::Arms(vec![vec![inner.clone()]]))
            .under(PathStep::Index(2))
            .under(PathStep::Key("a".into()));
        assert_eq!(issue.path, vec![PathStep::Key("a".into()), PathStep::Index(2)]);
        assert_eq!(issue.detail, Detail::Arms(vec![vec![inner]]));
        assert!(issue.continues);
    }

    #[test]
    fn a_value_is_aborted_unless_every_issue_lets_the_rest_run() {
        assert!(!aborted(&[]));
        assert!(!aborted(&[Issue::soft(Code::TooSmall), Issue::soft(Code::Custom)]));
        assert!(aborted(&[Issue::soft(Code::TooSmall), Issue::here(Code::InvalidType)]));
    }
}
