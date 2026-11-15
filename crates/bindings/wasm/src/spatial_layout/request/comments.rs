//! The annotation layer a request carries (`threads`, `commentLayer`,
//! `showResolved`, `commentObstacles`): each thread as `commentThreadSchema`
//! stores it, less what no layout reads (a message's author and timestamps,
//! the thread's own timestamp), which the request gate leaves off.

use whiteboard_canvas_render::comments::CommentOptions;
use whiteboard_model::Value;
use whiteboard_model::annotation::{
    AnnotationAnchor, CommentMessage, CommentThread, SpatialAnchor,
};
use whiteboard_model::text_anchor::{TextAnchor, TextQuote};
use whiteboard_scene::BoundingBox;

use super::{flag_of, strings_of};
use crate::edge_primitives::count;
use crate::json_canvas_wire::{Fields, items_of, number_of, string_of};

/// The comment layer as read; switched off, it holds no threads.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Comments {
    pub(crate) threads: Vec<CommentThread>,
    pub(crate) show_resolved: bool,
    pub(crate) obstacles: Vec<BoundingBox>,
}

impl Comments {
    pub(crate) fn options(&self) -> CommentOptions<'_> {
        CommentOptions {
            threads: &self.threads,
            show_resolved: self.show_resolved,
            obstacles: &self.obstacles,
        }
    }
}

fn quote_of(value: &Value) -> Option<TextQuote> {
    let mut f = Fields::of(value)?;
    let quote = TextQuote {
        prefix: f.field("prefix", string_of)?,
        exact: f.field("exact", string_of)??,
        suffix: f.field("suffix", string_of)?,
    };
    f.all_named().then_some(quote)
}

fn offset_of(value: &Value) -> Option<usize> {
    count(number_of(value)?)
}

fn spatial_of(f: &mut Fields<'_>) -> Option<SpatialAnchor> {
    Some(SpatialAnchor {
        node_id: f.field("nodeId", string_of)?,
        edge_id: f.field("edgeId", string_of)?,
        node_ids: f.field("nodeIds", strings_of)?,
        x: f.field("x", number_of)??,
        y: f.field("y", number_of)??,
        width: f.field("width", number_of)?,
        height: f.field("height", number_of)?,
    })
}

fn passage_of(f: &mut Fields<'_>) -> Option<TextAnchor> {
    Some(TextAnchor {
        node_id: f.field("nodeId", string_of)?,
        quote: f.field("quote", quote_of)??,
        start: f.field("start", offset_of)??,
        end: f.field("end", offset_of)??,
    })
}

/// An anchor by its `kind`: a spatial one, a passage, or the document.
fn anchor_of(value: &Value) -> Option<AnnotationAnchor> {
    let mut f = Fields::of(value)?;
    let anchor = match f.field("kind", string_of)??.as_str() {
        "spatial" => AnnotationAnchor::Spatial(spatial_of(&mut f)?),
        "text" => AnnotationAnchor::Text(passage_of(&mut f)?),
        "document" => AnnotationAnchor::Document,
        _ => return None,
    };
    f.all_named().then_some(anchor)
}

fn resolved_of(value: &Value) -> Option<bool> {
    match string_of(value)?.as_str() {
        "open" => Some(false),
        "resolved" => Some(true),
        _ => None,
    }
}

fn message_of(value: &Value) -> Option<CommentMessage> {
    let mut f = Fields::of(value)?;
    let message =
        CommentMessage { id: f.field("id", string_of)??, body: f.field("body", string_of)?? };
    f.all_named().then_some(message)
}

fn thread_of(value: &Value) -> Option<CommentThread> {
    let mut f = Fields::of(value)?;
    let thread = CommentThread {
        id: f.field("id", string_of)??,
        anchor: f.field("anchor", anchor_of)??,
        resolved: f.field("status", resolved_of)??,
        messages: f.field("messages", |v| items_of(v, message_of))??,
    };
    f.all_named().then_some(thread)
}

fn box_of(value: &Value) -> Option<BoundingBox> {
    let mut f = Fields::of(value)?;
    let bbox = BoundingBox {
        x: f.field("x", number_of)??,
        y: f.field("y", number_of)??,
        w: f.field("w", number_of)??,
        h: f.field("h", number_of)??,
    };
    f.all_named().then_some(bbox)
}

/// The layer's four fields of a request being read; `None` when one is malformed.
pub(super) fn comments_of(f: &mut Fields<'_>) -> Option<Comments> {
    let threads = f.field("threads", |v| items_of(v, thread_of))?.unwrap_or_default();
    let layer = f.field("commentLayer", flag_of)?.unwrap_or(true);
    Some(Comments {
        threads: if layer { threads } else { Vec::new() },
        show_resolved: f.field("showResolved", flag_of)?.unwrap_or_default(),
        obstacles: f.field("commentObstacles", |v| items_of(v, box_of))?.unwrap_or_default(),
    })
}
