use std::collections::BTreeMap;
use std::future::{Future, ready};

use whiteboard_ports::{MaybeSend, PortError, WorkspaceRecordStore};

/// Workspace records held in memory, each read back as the bytes it was given;
/// or a store that answers every read with one failure.
#[derive(Debug, Default, Clone)]
pub struct MemoryRecordStore {
    records: BTreeMap<String, Vec<u8>>,
    failure: Option<PortError>,
}

impl MemoryRecordStore {
    /// A store holding no workspace.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The same store, also holding `bytes` as the record of `workspace_id`.
    #[must_use]
    pub fn holding(mut self, workspace_id: &str, bytes: Vec<u8>) -> Self {
        self.records.insert(workspace_id.to_owned(), bytes);
        self
    }

    /// A store whose every read fails with `failure`, as a keeper whose
    /// database another process holds does.
    #[must_use]
    pub fn failing(failure: PortError) -> Self {
        Self { records: BTreeMap::new(), failure: Some(failure) }
    }
}

impl WorkspaceRecordStore for MemoryRecordStore {
    fn load(
        &self,
        workspace_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<u8>>, PortError>> + MaybeSend {
        ready(match &self.failure {
            Some(failure) => Err(failure.clone()),
            None => Ok(self.records.get(workspace_id).cloned()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_on;

    #[test]
    fn a_held_record_reads_back_and_another_id_reads_as_none() {
        let store = MemoryRecordStore::new().holding("w", vec![1, 2]).holding("v", vec![3]);
        assert_eq!(block_on(store.load("w")), Ok(Some(vec![1, 2])));
        assert_eq!(block_on(store.load("v")), Ok(Some(vec![3])));
        assert_eq!(block_on(store.load("x")), Ok(None));
    }

    #[test]
    fn a_failing_store_answers_its_failure_for_every_id() {
        let store = MemoryRecordStore::failing(PortError::DatabaseBusy);
        assert_eq!(block_on(store.load("w")), Err(PortError::DatabaseBusy));
        assert_eq!(block_on(store.load("x")), Err(PortError::DatabaseBusy));
    }
}
