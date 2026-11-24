use std::future::{Future, ready};

use whiteboard_ports::{Caller, MaybeSend, PortError, SINGLE_PERSON_NAMESPACE};

/// A caller whose namespace and known workspaces a test set; or one whose
/// every answer is one failure.
#[derive(Debug, Clone)]
pub struct FixedCaller {
    namespace: String,
    known: Option<Vec<String>>,
    failure: Option<PortError>,
}

impl Default for FixedCaller {
    fn default() -> Self {
        Self { namespace: SINGLE_PERSON_NAMESPACE.to_owned(), known: None, failure: None }
    }
}

impl FixedCaller {
    /// A single-person keeper's caller: namespace `me`, naming no workspace.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The same caller, in `namespace`.
    #[must_use]
    pub fn in_namespace(mut self, namespace: &str) -> Self {
        namespace.clone_into(&mut self.namespace);
        self
    }

    /// The same caller, told of `handles`.
    #[must_use]
    pub fn knowing(mut self, handles: Vec<String>) -> Self {
        self.known = Some(handles);
        self
    }

    /// A caller whose every answer fails with `failure`.
    #[must_use]
    pub fn failing(failure: PortError) -> Self {
        Self { failure: Some(failure), ..Self::default() }
    }

    fn answer<T>(&self, value: T) -> Result<T, PortError> {
        self.failure.clone().map_or(Ok(value), Err)
    }
}

impl Caller for FixedCaller {
    fn namespace(&self) -> impl Future<Output = Result<String, PortError>> + MaybeSend {
        ready(self.answer(self.namespace.clone()))
    }

    fn known_workspace_handles(
        &self,
    ) -> impl Future<Output = Result<Option<Vec<String>>, PortError>> + MaybeSend {
        ready(self.answer(self.known.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_on;

    #[test]
    fn a_caller_answers_what_was_set() {
        let caller = FixedCaller::new();
        assert_eq!(block_on(caller.namespace()).as_deref(), Ok("me"));
        assert_eq!(block_on(caller.known_workspace_handles()), Ok(None));
        let caller = caller.in_namespace("ann").knowing(vec!["a".into()]);
        assert_eq!(block_on(caller.namespace()).as_deref(), Ok("ann"));
        assert_eq!(block_on(caller.known_workspace_handles()), Ok(Some(vec!["a".into()])));
    }

    #[test]
    fn a_failing_caller_answers_its_failure_to_both() {
        let caller = FixedCaller::failing(PortError::DatabaseBusy);
        assert_eq!(block_on(caller.namespace()), Err(PortError::DatabaseBusy));
        assert_eq!(block_on(caller.known_workspace_handles()), Err(PortError::DatabaseBusy));
    }
}
