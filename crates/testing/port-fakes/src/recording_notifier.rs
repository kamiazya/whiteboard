use std::collections::BTreeSet;
use std::future::{Future, ready};
use std::sync::{Mutex, PoisonError};

use whiteboard_ports::{
    AgentActivity, ClientNotifier, MaybeSend, RestoreProgress, ViewportRequest,
};

/// Pages held open in memory: the documents a ready page watches, and every
/// viewport request and restore event handed over, in order. With none
/// watched it is a keeper with no audience, which answers every request
/// `false`.
#[derive(Debug, Default)]
pub struct RecordingNotifier {
    watched: BTreeSet<(String, String)>,
    requests: Mutex<Vec<ViewportRequest>>,
    restores: Mutex<Vec<RestoreProgress>>,
    activity: Mutex<Vec<AgentActivity>>,
}

impl RecordingNotifier {
    /// No page open anywhere.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The same pages, and a ready one on `document_id` of `workspace_id`.
    #[must_use]
    pub fn watching(mut self, workspace_id: &str, document_id: &str) -> Self {
        self.watched.insert((workspace_id.to_owned(), document_id.to_owned()));
        self
    }

    /// Every viewport request handed over so far, oldest first.
    #[must_use]
    pub fn requests(&self) -> Vec<ViewportRequest> {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Every agent activity told so far, leaving none behind.
    #[must_use]
    pub fn take_activity(&self) -> Vec<AgentActivity> {
        std::mem::take(&mut *self.activity.lock().unwrap_or_else(PoisonError::into_inner))
    }

    /// Every restore event told so far, leaving none behind, so a test reads
    /// what one call told.
    #[must_use]
    pub fn take_restores(&self) -> Vec<RestoreProgress> {
        std::mem::take(&mut *self.restores.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

impl ClientNotifier for RecordingNotifier {
    fn request_viewport(
        &self,
        request: &ViewportRequest,
    ) -> impl Future<Output = bool> + MaybeSend {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner).push(request.clone());
        let key = (request.workspace_id.clone(), request.document_id.clone());
        ready(self.watched.contains(&key))
    }

    fn restore_progress(&self, event: &RestoreProgress) {
        self.restores.lock().unwrap_or_else(PoisonError::into_inner).push(event.clone());
    }

    fn agent_activity(&self, activity: &AgentActivity) {
        self.activity.lock().unwrap_or_else(PoisonError::into_inner).push(activity.clone());
    }
}

#[cfg(test)]
mod tests {
    use whiteboard_ports::{
        AgentActivity, ClientNotifier, RestorePhase, RestoreProgress, Touched, ViewportMode,
        ViewportRequest,
    };

    use super::RecordingNotifier;
    use crate::block_on;

    fn request(workspace_id: &str, document_id: &str) -> ViewportRequest {
        ViewportRequest {
            workspace_id: workspace_id.to_owned(),
            document_id: document_id.to_owned(),
            mode: Some(ViewportMode::Fit),
            element_ids: None,
            scroll_x: None,
            scroll_y: None,
            zoom: None,
        }
    }

    #[test]
    fn a_watched_document_is_told_and_every_request_is_kept() {
        let pages = RecordingNotifier::new().watching("w", "d");
        assert!(block_on(pages.request_viewport(&request("w", "d"))));
        assert!(!block_on(pages.request_viewport(&request("w", "e"))));
        assert!(!block_on(pages.request_viewport(&request("v", "d"))));
        let kept: Vec<_> = pages.requests().into_iter().map(|r| r.document_id).collect();
        assert_eq!(kept, ["d", "e", "d"]);
    }

    #[test]
    fn no_page_open_tells_nobody() {
        let pages = RecordingNotifier::new();
        assert!(!block_on(pages.request_viewport(&request("w", "d"))));
        assert_eq!(pages.requests().len(), 1);
    }

    fn restore(path: &str, phase: RestorePhase) -> RestoreProgress {
        RestoreProgress { workspace_id: "w".into(), path: path.into(), phase, label: None }
    }

    #[test]
    fn an_activity_told_is_kept_until_taken() {
        let pages = RecordingNotifier::new();
        let told = |summary: &str| AgentActivity {
            workspace_id: "w".into(),
            document_id: "d".into(),
            touched: Touched::default(),
            summary: summary.into(),
        };
        pages.agent_activity(&told("one"));
        pages.agent_activity(&told("two"));
        assert_eq!(pages.take_activity(), vec![told("one"), told("two")]);
        assert!(pages.take_activity().is_empty());
        assert!(pages.requests().is_empty(), "an activity is no viewport request");
    }

    #[test]
    fn a_restore_told_is_kept_until_taken() {
        let pages = RecordingNotifier::new();
        pages.restore_progress(&restore("a", RestorePhase::Started));
        pages.restore_progress(&restore("a", RestorePhase::Complete));
        assert_eq!(
            pages.take_restores(),
            vec![restore("a", RestorePhase::Started), restore("a", RestorePhase::Complete)]
        );
        assert!(pages.take_restores().is_empty());
        assert!(pages.requests().is_empty(), "a restore is no viewport request");
    }
}
