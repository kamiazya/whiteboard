//! The pages a document is open in, as an operation reaches them: best effort
//! and one way, since a keeper with no page open is the normal case rather
//! than a failure.

/// Which end of a restore a page is told of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestorePhase {
    /// The page makes its editor read-only and says a restore is under way.
    Started,
    /// The page releases both.
    Complete,
}

/// A restore beginning or ending on one document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreProgress {
    pub workspace_id: String,
    /// The document written: the target, for a restore into another path.
    pub path: String,
    pub phase: RestorePhase,
    /// The restored version's label, told with `Started` alone.
    pub label: Option<String>,
}

/// The seam an operation reaches a page watching the same document through
/// (server-core's `CanvasClientNotifier`). Nothing here fails and nothing is
/// awaited: a keeper that could not reach a page answers as one that had none
/// to reach.
pub trait ClientNotifier {
    /// Tells the pages `event.path` is open in that a restore began or ended.
    /// A caller that sends `Started` sends `Complete` however the restore
    /// ends, so a page's editor is never left read-only.
    fn restore_progress(&self, event: &RestoreProgress);
}
