use std::collections::BTreeMap;
use std::future::{Future, ready};

use whiteboard_ports::{MaybeSend, PortError, SavedVersion, VersionStore};

/// Version histories held in memory, each listed back in the order it was
/// given; or a store that answers every listing with one failure.
#[derive(Debug, Default, Clone)]
pub struct MemoryVersionStore {
    histories: BTreeMap<(String, String), Vec<SavedVersion>>,
    failure: Option<PortError>,
}

impl MemoryVersionStore {
    /// A store holding no version.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The same store, also holding `versions` (newest first) as the history
    /// of `document_id` in `workspace_id`.
    #[must_use]
    pub fn holding(
        mut self,
        workspace_id: &str,
        document_id: &str,
        versions: Vec<SavedVersion>,
    ) -> Self {
        self.histories.insert((workspace_id.to_owned(), document_id.to_owned()), versions);
        self
    }

    /// A store whose every listing fails with `failure`.
    #[must_use]
    pub fn failing(failure: PortError) -> Self {
        Self { histories: BTreeMap::new(), failure: Some(failure) }
    }
}

impl VersionStore for MemoryVersionStore {
    fn list(
        &self,
        workspace_id: &str,
        document_id: &str,
    ) -> impl Future<Output = Result<Vec<SavedVersion>, PortError>> + MaybeSend {
        let key = (workspace_id.to_owned(), document_id.to_owned());
        ready(match &self.failure {
            Some(failure) => Err(failure.clone()),
            None => Ok(self.histories.get(&key).cloned().unwrap_or_default()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_on;

    fn saved(id: &str) -> SavedVersion {
        SavedVersion {
            id: id.to_owned(),
            created_at: "2026-01-02T03:04:05.006Z".to_owned(),
            label: None,
            auto: false,
            operator: None,
            restored_from: None,
        }
    }

    #[test]
    fn a_held_history_lists_back_in_order_and_another_document_lists_none() {
        let store = MemoryVersionStore::new()
            .holding("w", "d", vec![saved("b"), saved("a")])
            .holding("v", "d", vec![saved("c")]);
        assert_eq!(block_on(store.list("w", "d")), Ok(vec![saved("b"), saved("a")]));
        assert_eq!(block_on(store.list("v", "d")), Ok(vec![saved("c")]));
        assert_eq!(block_on(store.list("w", "e")), Ok(Vec::new()));
        assert_eq!(block_on(store.list("x", "d")), Ok(Vec::new()));
    }

    #[test]
    fn a_failing_store_answers_its_failure_for_every_document() {
        let store = MemoryVersionStore::failing(PortError::DatabaseBusy);
        assert_eq!(block_on(store.list("w", "d")), Err(PortError::DatabaseBusy));
        assert_eq!(block_on(store.list("x", "e")), Err(PortError::DatabaseBusy));
    }
}
