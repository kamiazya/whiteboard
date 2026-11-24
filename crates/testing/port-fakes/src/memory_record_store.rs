use std::collections::BTreeMap;
use std::future::{Future, ready};
use std::sync::{Mutex, MutexGuard, PoisonError};

use whiteboard_ports::{MaybeSend, PortError, WorkspaceRecordStore};

/// How a store folds an appended update into the record it holds: the record
/// and the update in, the record with the update out, or why not. A CRDT's
/// merge is the test's to supply, so this crate stays std only.
pub type Merge = fn(&[u8], &[u8]) -> Result<Vec<u8>, String>;

#[derive(Debug, Default)]
struct State {
    records: BTreeMap<String, Vec<u8>>,
    /// Every update appended, by workspace, in the order appended.
    appended: BTreeMap<String, Vec<Vec<u8>>>,
}

/// Workspace records held in memory, each read back as the bytes it was given
/// with every update appended since folded in by the store's merge (none
/// given: the record reads back as it was given, the updates kept apart for a
/// test to read); or a store that answers every call with one failure.
#[derive(Debug, Default)]
pub struct MemoryRecordStore {
    state: Mutex<State>,
    merge: Option<Merge>,
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
    pub fn holding(self, workspace_id: &str, bytes: Vec<u8>) -> Self {
        self.locked().records.insert(workspace_id.to_owned(), bytes);
        self
    }

    /// The same store, folding each appended update into its record with
    /// `merge`.
    #[must_use]
    pub fn merging_with(mut self, merge: Merge) -> Self {
        self.merge = Some(merge);
        self
    }

    /// A store whose every call fails with `failure`, as a keeper whose
    /// database another process holds does.
    #[must_use]
    pub fn failing(failure: PortError) -> Self {
        Self { failure: Some(failure), ..Self::default() }
    }

    /// Every update appended to `workspace_id`'s record, in the order appended.
    #[must_use]
    pub fn appended(&self, workspace_id: &str) -> Vec<Vec<u8>> {
        self.locked().appended.get(workspace_id).cloned().unwrap_or_default()
    }

    /// A poisoned state is still a consistent one: no critical section here
    /// can panic part way through a change.
    fn locked(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn keep(&self, workspace_id: &str, update: &[u8]) -> Result<(), PortError> {
        if let Some(failure) = &self.failure {
            return Err(failure.clone());
        }
        let mut state = self.locked();
        let Some(record) = state.records.get(workspace_id) else {
            return Err(PortError::WorkspaceNotFound { workspace_id: workspace_id.to_owned() });
        };
        if let Some(merge) = self.merge {
            let merged =
                merge(record, update).map_err(|cause| PortError::StoredDocumentUnreadable {
                    code: whiteboard_ports::StoredUnreadableCode::Malformed,
                    message: format!("update to {workspace_id} could not be merged: {cause}"),
                })?;
            state.records.insert(workspace_id.to_owned(), merged);
        }
        state.appended.entry(workspace_id.to_owned()).or_default().push(update.to_vec());
        Ok(())
    }
}

impl WorkspaceRecordStore for MemoryRecordStore {
    fn load(
        &self,
        workspace_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<u8>>, PortError>> + MaybeSend {
        ready(match &self.failure {
            Some(failure) => Err(failure.clone()),
            None => Ok(self.locked().records.get(workspace_id).cloned()),
        })
    }

    fn append(
        &self,
        workspace_id: &str,
        update: &[u8],
    ) -> impl Future<Output = Result<(), PortError>> + MaybeSend {
        ready(self.keep(workspace_id, update))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_on;

    /// A merge a test can read: the update's bytes after the record's.
    fn concatenate(record: &[u8], update: &[u8]) -> Result<Vec<u8>, String> {
        if update.is_empty() {
            return Err("an empty update".to_owned());
        }
        Ok([record, update].concat())
    }

    #[test]
    fn a_held_record_reads_back_and_another_id_reads_as_none() {
        let store = MemoryRecordStore::new().holding("w", vec![1, 2]).holding("v", vec![3]);
        assert_eq!(block_on(store.load("w")), Ok(Some(vec![1, 2])));
        assert_eq!(block_on(store.load("v")), Ok(Some(vec![3])));
        assert_eq!(block_on(store.load("x")), Ok(None));
    }

    #[test]
    fn a_failing_store_answers_its_failure_for_every_call() {
        let store = MemoryRecordStore::failing(PortError::DatabaseBusy);
        assert_eq!(block_on(store.load("w")), Err(PortError::DatabaseBusy));
        assert_eq!(block_on(store.load("x")), Err(PortError::DatabaseBusy));
        assert_eq!(block_on(store.append("w", &[1])), Err(PortError::DatabaseBusy));
        assert!(store.appended("w").is_empty());
    }

    #[test]
    fn an_appended_update_is_merged_into_the_record_the_next_load_answers() {
        let store = MemoryRecordStore::new()
            .holding("w", vec![1])
            .holding("v", vec![9])
            .merging_with(concatenate);
        assert_eq!(block_on(store.append("w", &[2])), Ok(()));
        assert_eq!(block_on(store.append("w", &[3, 4])), Ok(()));
        assert_eq!(block_on(store.load("w")), Ok(Some(vec![1, 2, 3, 4])));
        assert_eq!(block_on(store.load("v")), Ok(Some(vec![9])));
        assert_eq!(store.appended("w"), [vec![2], vec![3, 4]]);
        assert!(store.appended("v").is_empty());
    }

    #[test]
    fn an_update_the_merge_refuses_is_kept_nowhere() {
        let store = MemoryRecordStore::new().holding("w", vec![1]).merging_with(concatenate);
        let refused = block_on(store.append("w", &[]));
        assert!(
            matches!(&refused, Err(PortError::StoredDocumentUnreadable { message, .. }) if message.contains("an empty update")),
            "{refused:?}"
        );
        assert_eq!(block_on(store.load("w")), Ok(Some(vec![1])));
        assert!(store.appended("w").is_empty());
    }

    #[test]
    fn a_store_given_no_merge_keeps_the_updates_apart() {
        let store = MemoryRecordStore::new().holding("w", vec![1]);
        assert_eq!(block_on(store.append("w", &[2])), Ok(()));
        assert_eq!(block_on(store.load("w")), Ok(Some(vec![1])));
        assert_eq!(store.appended("w"), [vec![2]]);
    }

    #[test]
    fn an_update_to_a_workspace_the_store_holds_no_record_of_is_refused() {
        let store = MemoryRecordStore::new().merging_with(concatenate);
        let refused = block_on(store.append("x", &[1]));
        assert_eq!(refused, Err(PortError::WorkspaceNotFound { workspace_id: "x".to_owned() }));
        assert!(store.appended("x").is_empty());
    }
}
