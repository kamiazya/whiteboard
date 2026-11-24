use std::collections::{BTreeMap, VecDeque};
use std::future::{Future, ready};
use std::sync::{Mutex, MutexGuard, PoisonError};

use whiteboard_ports::{
    MaybeSend, NewVersion, OperatorKind, PortError, SavedVersion, VersionOperator, VersionStore,
};

/// The stamp a save takes when the store was given none.
const EPOCH: &str = "1970-01-01T00:00:00.000Z";

/// Bytes held per workspace and version id.
type ByVersion = BTreeMap<(String, String), Vec<u8>>;

#[derive(Debug, Default)]
struct State {
    histories: BTreeMap<(String, String), Vec<SavedVersion>>,
    /// The ids the next saves take, in order.
    ids: VecDeque<String>,
    /// How many saves minted an id of their own once `ids` ran out.
    minted: u64,
    /// The stamp every save takes.
    at: Option<String>,
    /// A version's past document, by workspace and version id.
    checkouts: ByVersion,
    /// A workspace-scoped version's past record, by workspace and version id.
    workspaces_at: ByVersion,
}

/// Version histories held in memory, each listed back newest first; or a
/// store that answers every call with one failure.
///
/// A save is the keeper's as the port describes it: an id from the ones the
/// store was handed (`version-<n>` once they run out), the stamp it was
/// handed, the agent as its operator, the version a restore point restored,
/// and a refusal once the document keeps as many manual versions, or as many
/// restore points, as the ceiling the store was given for each, which spends
/// its id as the daemon's store does. A checkout answers the bytes the store
/// was handed for that version, and none for any other.
#[derive(Debug, Default)]
pub struct MemoryVersionStore {
    state: Mutex<State>,
    failure: Option<PortError>,
    manual_ceiling: Option<usize>,
    restore_point_ceiling: Option<usize>,
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
        self,
        workspace_id: &str,
        document_id: &str,
        versions: Vec<SavedVersion>,
    ) -> Self {
        let key = (workspace_id.to_owned(), document_id.to_owned());
        self.locked().histories.insert(key, versions);
        self
    }

    /// The same store, its saves taking `ids` in order and every one stamped
    /// `at` (`toISOString`'s text).
    #[must_use]
    pub fn minting(self, ids: Vec<String>, at: &str) -> Self {
        {
            let mut state = self.locked();
            state.ids = ids.into();
            state.at = Some(at.to_owned());
        }
        self
    }

    /// The same store, refusing a manual save of a document that already
    /// keeps `limit` manual versions.
    #[must_use]
    pub fn keeping_at_most(mut self, limit: usize) -> Self {
        self.manual_ceiling = Some(limit);
        self
    }

    /// The same store, refusing a restore point of a document that already
    /// keeps `limit` restore points.
    #[must_use]
    pub fn keeping_restore_points_at_most(mut self, limit: usize) -> Self {
        self.restore_point_ceiling = Some(limit);
        self
    }

    /// The same store, answering `document` as the past state `load` checks
    /// out of `version_id` in `workspace_id`.
    #[must_use]
    pub fn checking_out(self, workspace_id: &str, version_id: &str, document: Vec<u8>) -> Self {
        let key = (workspace_id.to_owned(), version_id.to_owned());
        self.locked().checkouts.insert(key, document);
        self
    }

    /// The same store, answering `record` as the workspace `version_id` of
    /// `workspace_id` was saved with; a version given none is not
    /// workspace-scoped.
    #[must_use]
    pub fn holding_workspace_at(
        self,
        workspace_id: &str,
        version_id: &str,
        record: Vec<u8>,
    ) -> Self {
        let key = (workspace_id.to_owned(), version_id.to_owned());
        self.locked().workspaces_at.insert(key, record);
        self
    }

    /// A store whose every call fails with `failure`.
    #[must_use]
    pub fn failing(failure: PortError) -> Self {
        Self { failure: Some(failure), ..Self::default() }
    }

    /// A poisoned state is still a consistent one: no critical section here
    /// can panic part way through a change.
    fn locked(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn record(
        &self,
        workspace_id: &str,
        document_id: &str,
        save: &NewVersion,
    ) -> Result<SavedVersion, PortError> {
        if let Some(failure) = &self.failure {
            return Err(failure.clone());
        }
        let mut state = self.locked();
        let key = (workspace_id.to_owned(), document_id.to_owned());
        let id = if let Some(id) = state.ids.pop_front() {
            id
        } else {
            state.minted += 1;
            format!("version-{}", state.minted)
        };
        // The id is minted before the ceilings are asked, as the daemon's
        // store mints it: a refused save spends one.
        let held = |kept: fn(&SavedVersion) -> bool| {
            state
                .histories
                .get(&key)
                .map_or(0, |history| history.iter().filter(|v| kept(v)).count())
        };
        if let Some(limit) = self.manual_ceiling
            && !save.auto
            && held(|v| !v.auto) >= limit
        {
            return Err(PortError::TooManyVersions { limit });
        }
        if let Some(limit) = self.restore_point_ceiling
            && save.restored_from.is_some()
            && held(|v| v.restored_from.is_some()) >= limit
        {
            return Err(PortError::TooManyVersions { limit });
        }
        let saved = SavedVersion {
            id,
            created_at: state.at.clone().unwrap_or_else(|| EPOCH.to_owned()),
            label: save.label.clone(),
            auto: save.auto,
            operator: Some(VersionOperator { kind: OperatorKind::Ai, display_name: None }),
            restored_from: save.restored_from.clone(),
        };
        let history = state.histories.entry(key).or_default();
        // Newest first, the later of two equal stamps first. Stamps compare as
        // text, which orders the four-digit years a fake is handed.
        let at = history.iter().position(|held| held.created_at <= saved.created_at);
        history.insert(at.unwrap_or(history.len()), saved.clone());
        Ok(saved)
    }

    fn checkout(
        &self,
        held: fn(&State) -> &ByVersion,
        workspace_id: &str,
        version_id: &str,
    ) -> Result<Option<Vec<u8>>, PortError> {
        if let Some(failure) = &self.failure {
            return Err(failure.clone());
        }
        let key = (workspace_id.to_owned(), version_id.to_owned());
        Ok(held(&self.locked()).get(&key).cloned())
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
            None => Ok(self.locked().histories.get(&key).cloned().unwrap_or_default()),
        })
    }

    fn save(
        &self,
        workspace_id: &str,
        document_id: &str,
        save: &NewVersion,
    ) -> impl Future<Output = Result<SavedVersion, PortError>> + MaybeSend {
        ready(self.record(workspace_id, document_id, save))
    }

    fn load(
        &self,
        workspace_id: &str,
        version_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<u8>>, PortError>> + MaybeSend {
        ready(self.checkout(|state| &state.checkouts, workspace_id, version_id))
    }

    fn load_workspace_at(
        &self,
        workspace_id: &str,
        version_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<u8>>, PortError>> + MaybeSend {
        ready(self.checkout(|state| &state.workspaces_at, workspace_id, version_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_on;

    fn saved(id: &str) -> SavedVersion {
        stamped(id, "2026-01-02T03:04:05.006Z")
    }

    fn stamped(id: &str, at: &str) -> SavedVersion {
        SavedVersion {
            id: id.to_owned(),
            created_at: at.to_owned(),
            label: None,
            auto: false,
            operator: None,
            restored_from: None,
        }
    }

    fn manual(label: &str) -> NewVersion {
        NewVersion { label: Some(label.to_owned()), auto: false, restored_from: None }
    }

    fn restore_point(of: &str) -> NewVersion {
        NewVersion { label: None, auto: true, restored_from: Some(of.to_owned()) }
    }

    fn ids(store: &MemoryVersionStore, workspace_id: &str, document_id: &str) -> Vec<String> {
        let listed = block_on(store.list(workspace_id, document_id)).expect("a listing");
        listed.into_iter().map(|version| version.id).collect()
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
    fn a_failing_store_answers_its_failure_for_every_call() {
        let store = MemoryVersionStore::failing(PortError::DatabaseBusy);
        assert_eq!(block_on(store.list("w", "d")), Err(PortError::DatabaseBusy));
        assert_eq!(block_on(store.list("x", "e")), Err(PortError::DatabaseBusy));
        assert_eq!(block_on(store.save("w", "d", &manual("l"))), Err(PortError::DatabaseBusy));
    }

    #[test]
    fn a_save_takes_the_next_minted_id_and_stamp_and_names_the_agent() {
        let store = MemoryVersionStore::new()
            .minting(vec!["m1".to_owned(), "m2".to_owned()], "2026-11-24T12:00:00.000Z");
        let first = block_on(store.save("w", "d", &manual("one"))).expect("a save");
        let checkpoint = NewVersion { label: None, auto: true, restored_from: None };
        let second = block_on(store.save("w", "e", &checkpoint)).expect("a save");
        let third = block_on(store.save("w", "d", &manual("three"))).expect("a save");
        assert_eq!(
            first,
            SavedVersion {
                id: "m1".to_owned(),
                created_at: "2026-11-24T12:00:00.000Z".to_owned(),
                label: Some("one".to_owned()),
                auto: false,
                operator: Some(VersionOperator { kind: OperatorKind::Ai, display_name: None }),
                restored_from: None,
            }
        );
        assert_eq!((second.id.as_str(), second.label, second.auto), ("m2", None, true));
        assert_eq!(third.id, "version-1");
        assert_eq!(ids(&store, "w", "d"), ["version-1", "m1"]);
        assert_eq!(ids(&store, "w", "e"), ["m2"]);
    }

    #[test]
    fn a_store_given_no_stamp_stamps_the_epoch() {
        let store = MemoryVersionStore::new();
        let saved = block_on(store.save("w", "d", &manual("l"))).expect("a save");
        assert_eq!((saved.id.as_str(), saved.created_at.as_str()), ("version-1", EPOCH));
    }

    #[test]
    fn a_save_is_listed_by_its_stamp_newest_first() {
        let store = MemoryVersionStore::new()
            .holding(
                "w",
                "d",
                vec![
                    stamped("late", "2026-12-01T00:00:00.000Z"),
                    stamped("same", "2026-11-24T12:00:00.000Z"),
                    stamped("early", "2026-01-01T00:00:00.000Z"),
                ],
            )
            .minting(vec!["new".to_owned()], "2026-11-24T12:00:00.000Z");
        block_on(store.save("w", "d", &manual("l"))).expect("a save");
        assert_eq!(ids(&store, "w", "d"), ["late", "new", "same", "early"]);
    }

    #[test]
    fn a_manual_save_past_the_ceiling_is_refused_and_keeps_nothing() {
        let automatic = SavedVersion { auto: true, ..saved("auto") };
        let store = MemoryVersionStore::new()
            .holding("w", "d", vec![automatic, saved("a"), saved("b")])
            .keeping_at_most(2);
        let refused = block_on(store.save("w", "d", &manual("l")));
        assert_eq!(refused, Err(PortError::TooManyVersions { limit: 2 }));
        assert_eq!(ids(&store, "w", "d"), ["auto", "a", "b"]);
        let checkpoint = NewVersion { label: None, auto: true, restored_from: None };
        assert!(block_on(store.save("w", "d", &checkpoint)).is_ok());
        assert!(block_on(store.save("w", "e", &manual("l"))).is_ok());
        assert_eq!(ids(&store, "w", "e"), ["version-3"], "the refused save spent version-1");
        let one_below =
            MemoryVersionStore::new().holding("w", "d", vec![saved("a")]).keeping_at_most(2);
        assert!(block_on(one_below.save("w", "d", &manual("l"))).is_ok());
    }

    #[test]
    fn a_failing_store_fails_every_checkout() {
        let store = MemoryVersionStore::failing(PortError::DatabaseBusy);
        assert_eq!(block_on(store.load("w", "v")), Err(PortError::DatabaseBusy));
        assert_eq!(block_on(store.load_workspace_at("w", "v")), Err(PortError::DatabaseBusy));
    }

    #[test]
    fn a_checkout_answers_the_bytes_held_for_its_workspace_and_version_alone() {
        let store = MemoryVersionStore::new()
            .checking_out("w", "v", vec![1, 2])
            .checking_out("x", "v", vec![3])
            .holding_workspace_at("w", "v", vec![4]);
        assert_eq!(block_on(store.load("w", "v")), Ok(Some(vec![1, 2])));
        assert_eq!(block_on(store.load("x", "v")), Ok(Some(vec![3])));
        assert_eq!(block_on(store.load("w", "u")), Ok(None));
        assert_eq!(block_on(store.load("y", "v")), Ok(None));
        assert_eq!(block_on(store.load_workspace_at("w", "v")), Ok(Some(vec![4])));
        assert_eq!(block_on(store.load_workspace_at("x", "v")), Ok(None), "not workspace-scoped");
        assert_eq!(block_on(store.load_workspace_at("w", "u")), Ok(None));
    }

    #[test]
    fn a_restore_point_names_the_version_it_restored() {
        let store =
            MemoryVersionStore::new().minting(vec!["p".to_owned()], "2026-11-24T12:00:00.000Z");
        let saved = block_on(store.save("w", "d", &restore_point("v1"))).expect("a save");
        assert_eq!((saved.id.as_str(), saved.auto), ("p", true));
        assert_eq!(saved.restored_from.as_deref(), Some("v1"));
        let listed = block_on(store.list("w", "d")).expect("a listing");
        assert_eq!(listed, [saved]);
    }

    #[test]
    fn a_restore_point_past_its_own_ceiling_is_refused_and_keeps_nothing() {
        let point = |id: &str| SavedVersion {
            auto: true,
            restored_from: Some("v".to_owned()),
            ..saved(id)
        };
        let store = MemoryVersionStore::new()
            .holding("w", "d", vec![point("p2"), point("p1"), saved("m1"), saved("m2")])
            .keeping_at_most(2)
            .keeping_restore_points_at_most(2);
        let refused = block_on(store.save("w", "d", &restore_point("v")));
        assert_eq!(refused, Err(PortError::TooManyVersions { limit: 2 }));
        assert_eq!(ids(&store, "w", "d"), ["p2", "p1", "m1", "m2"]);
        let checkpoint = NewVersion { label: None, auto: true, restored_from: None };
        assert!(block_on(store.save("w", "d", &checkpoint)).is_ok(), "a plain checkpoint is kept");
        assert!(block_on(store.save("w", "e", &restore_point("v"))).is_ok());
        assert_eq!(ids(&store, "w", "e"), ["version-3"], "the refused point spent version-1");
        let unbounded = MemoryVersionStore::new()
            .holding("w", "d", vec![point("p2"), point("p1")])
            .keeping_at_most(1);
        assert!(block_on(unbounded.save("w", "d", &restore_point("v"))).is_ok());
    }
}
