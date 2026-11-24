//! The pages a document is open in, as a tool reaches them: best effort and
//! one way, since a keeper with no page open is the normal case rather than a
//! failure.

use std::future::Future;

use crate::MaybeSend;

/// Which half of a viewport request the page applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewportMode {
    /// Frame the elements named, or the whole board.
    Fit,
    /// Go to a position at a zoom.
    Move,
}

/// Where a watching page should look in one document. A field the caller did
/// not send is `None`, and travels to the page as absent: the page applies
/// its own default, never one chosen here.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewportRequest {
    pub workspace_id: String,
    pub document_id: String,
    pub mode: Option<ViewportMode>,
    pub element_ids: Option<Vec<String>>,
    pub scroll_x: Option<f64>,
    pub scroll_y: Option<f64>,
    pub zoom: Option<f64>,
}

/// The seam a tool reaches a page watching the same document through
/// (server-core's `CanvasClientNotifier`). Nothing here fails: a keeper that
/// could not reach a page answers as one that had none to reach.
pub trait ClientNotifier {
    /// Hands `request` to the pages `request.document_id` is open in, and
    /// answers whether one of them was ready to apply it. The page does not
    /// confirm, so `true` means told, not moved; a keeper with no audience (a
    /// stdio server) answers `false`. A keeper may keep the request for a
    /// page that opens later; what it answers is only who was there.
    fn request_viewport(&self, request: &ViewportRequest)
    -> impl Future<Output = bool> + MaybeSend;
}
