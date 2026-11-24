use std::collections::BTreeSet;
use std::future::{Future, ready};
use std::sync::{Mutex, PoisonError};

use whiteboard_ports::{ClientNotifier, MaybeSend, ViewportRequest};

/// Pages held open in memory: the documents a ready page watches, and every
/// viewport request handed over, in order. With none watched it is a keeper
/// with no audience, which answers every request `false`.
#[derive(Debug, Default)]
pub struct RecordingNotifier {
    watched: BTreeSet<(String, String)>,
    requests: Mutex<Vec<ViewportRequest>>,
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
}

#[cfg(test)]
mod tests {
    use whiteboard_ports::{ClientNotifier, ViewportMode, ViewportRequest};

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
}
