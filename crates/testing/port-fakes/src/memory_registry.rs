use std::future::{Future, ready};

use whiteboard_ports::{
    MaybeSend, PortError, SINGLE_PERSON_NAMESPACE, WorkspaceEntry, WorkspaceLookup,
    WorkspaceRegistry,
};

/// A workspace registry held in memory, each lookup answered by the first row
/// it names; or one that answers every lookup with one failure.
#[derive(Debug, Default, Clone)]
pub struct MemoryRegistry {
    rows: Vec<WorkspaceEntry>,
    failure: Option<PortError>,
}

impl MemoryRegistry {
    /// A registry holding no workspace.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The same registry, also holding `row`.
    #[must_use]
    pub fn holding(mut self, row: WorkspaceEntry) -> Self {
        self.rows.push(row);
        self
    }

    /// A registry whose every lookup fails with `failure`.
    #[must_use]
    pub fn failing(failure: PortError) -> Self {
        Self { rows: Vec::new(), failure: Some(failure) }
    }
}

/// Whether `row` is the one `lookup` names; a row without a namespace sits in
/// the single-person one.
fn names(row: &WorkspaceEntry, lookup: &WorkspaceLookup) -> bool {
    match lookup {
        WorkspaceLookup::Id(id) => row.workspace_id == *id,
        WorkspaceLookup::Segment { namespace, segment } => {
            row.namespace.as_deref().unwrap_or(SINGLE_PERSON_NAMESPACE) == namespace
                && row.segment.as_ref() == Some(segment)
        }
    }
}

impl WorkspaceRegistry for MemoryRegistry {
    fn find(
        &self,
        lookup: &WorkspaceLookup,
    ) -> impl Future<Output = Result<Option<WorkspaceEntry>, PortError>> + MaybeSend {
        ready(match &self.failure {
            Some(failure) => Err(failure.clone()),
            None => Ok(self.rows.iter().find(|row| names(row, lookup)).cloned()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_on;

    fn row(id: &str, namespace: Option<&str>, segment: Option<&str>) -> WorkspaceEntry {
        WorkspaceEntry {
            workspace_id: id.to_owned(),
            namespace: namespace.map(str::to_owned),
            segment: segment.map(str::to_owned),
        }
    }

    fn segment(namespace: &str, segment: &str) -> WorkspaceLookup {
        WorkspaceLookup::Segment { namespace: namespace.to_owned(), segment: segment.to_owned() }
    }

    #[test]
    fn a_lookup_finds_the_row_it_names_and_no_other() {
        let mine = row("W1", None, Some("plan"));
        let theirs = row("W2", Some("ann"), Some("plan"));
        let bare = row("W3", None, None);
        let registry = MemoryRegistry::new()
            .holding(mine.clone())
            .holding(theirs.clone())
            .holding(bare.clone());
        let find = |lookup: WorkspaceLookup| block_on(registry.find(&lookup));
        assert_eq!(find(WorkspaceLookup::Id("W2".into())), Ok(Some(theirs.clone())));
        assert_eq!(find(WorkspaceLookup::Id("W3".into())), Ok(Some(bare)));
        assert_eq!(find(WorkspaceLookup::Id("W4".into())), Ok(None));
        assert_eq!(find(segment("me", "plan")), Ok(Some(mine)));
        assert_eq!(find(segment("ann", "plan")), Ok(Some(theirs)));
        assert_eq!(find(segment("bob", "plan")), Ok(None));
        assert_eq!(find(segment("me", "other")), Ok(None));
    }

    #[test]
    fn a_failing_registry_answers_its_failure_for_every_lookup() {
        let registry = MemoryRegistry::failing(PortError::DatabaseBusy);
        assert_eq!(block_on(registry.find(&segment("me", "a"))), Err(PortError::DatabaseBusy));
    }
}
