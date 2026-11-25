//! `projectCanvasSnapshot`: a canvas as the engine answers it, projected to
//! the snapshot's nodes, edges and lines, each list and each text cut to its
//! budget, the true totals beside them.
//!
//! What the snapshot copies rather than builds (an end, the bends, a colour,
//! the facets and tags) is the engine's value as it stands, so its members
//! keep the order the TypeScript reads them in.

use whiteboard_model::Value;
use whiteboard_model::canvas_value::node_of;
use whiteboard_model::node_content::{
    NodeKind, frame_label, node_file, node_kind, node_text, node_url,
};

use super::{Halt, SnapshotPending};
use crate::content::{field, holds_wide_map};

/// Per-node text budget, in UTF-16 units: a text node can hold a whole
/// markdown document.
pub const SNAPSHOT_TEXT_MAX_CHARS: usize = 400;
/// The nodes returned; a board holding more is reported truncated.
pub const SNAPSHOT_MAX_NODES: usize = 300;
/// The edges returned, and separately the lines.
pub const SNAPSHOT_MAX_EDGES: usize = 600;

/// The snapshot of one board.
#[derive(Debug, Clone, PartialEq)]
pub struct CanvasSnapshotOutput {
    pub document_id: String,
    pub nodes: Vec<SnapshotNode>,
    pub edges: Vec<SnapshotEdge>,
    pub lines: Vec<SnapshotLine>,
    /// The totals on the board, not the lengths returned.
    pub node_count: usize,
    pub edge_count: usize,
    pub line_count: usize,
    /// Any of the three lists, or a node's text, was cut.
    pub truncated: bool,
}

/// What a node shows, by its kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shown {
    /// A text node's text, `truncated` when it was cut to the budget.
    Text { text: String, truncated: bool },
    /// A frame's label.
    Label(String),
    /// Where a file node points.
    File(String),
    /// Where a link node points.
    Url(String),
}

/// One node: where it is, what it shows and what dresses it.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotNode {
    pub id: String,
    /// The word the canvas tools publish: `text`, `file`, `link` or `group`.
    pub kind: &'static str,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: Option<Value>,
    pub locked: bool,
    pub facets: Option<Value>,
    pub tags: Option<Value>,
    pub shown: Option<Shown>,
}

/// One edge, a relation between two nodes.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotEdge {
    pub id: String,
    pub from: Value,
    pub to: Value,
    pub label: Option<Value>,
    pub color: Option<Value>,
    pub locked: bool,
    pub bends: Option<Value>,
    pub facets: Option<Value>,
    pub tags: Option<Value>,
}

/// One line: ink, which carries no lock and no tags.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotLine {
    pub id: String,
    pub from: Value,
    pub to: Value,
    pub label: Option<Value>,
    pub color: Option<Value>,
    pub bends: Option<Value>,
    pub facets: Option<Value>,
}

const UNDECIDED: Halt = Halt::Pending(SnapshotPending::UndecidedRead);

/// The canvas of the engine's `{ canvas, skipped }`.
pub(super) fn canvas_in(answer: &Value) -> Option<&Value> {
    field(answer, "canvas").filter(|canvas| matches!(canvas, Value::Map(_)))
}

/// The snapshot of `canvas`, the first of each list in stored order.
pub(super) fn project(
    document_id: &str,
    canvas: &Value,
    node_locks: &[String],
    edge_locks: &[String],
) -> Result<CanvasSnapshotOutput, Halt> {
    let nodes = items(field(canvas, "nodes"))?;
    let edges = items(field(canvas, "edges"))?;
    let lines = match field(canvas, "lines") {
        None => &[][..],
        held => items(held)?,
    };
    let locked = |locks: &[String], id: &str| locks.iter().any(|held| held == id);
    let projected: Vec<SnapshotNode> = nodes
        .iter()
        .take(SNAPSHOT_MAX_NODES)
        .map(|value| node(value, |id| locked(node_locks, id)))
        .collect::<Result<_, _>>()?;
    let edges_out: Vec<SnapshotEdge> = edges
        .iter()
        .take(SNAPSHOT_MAX_EDGES)
        .map(|value| edge(value, |id| locked(edge_locks, id)))
        .collect::<Result<_, _>>()?;
    let lines_out: Vec<SnapshotLine> =
        lines.iter().take(SNAPSHOT_MAX_EDGES).map(line).collect::<Result<_, _>>()?;
    let cut_text = projected
        .iter()
        .any(|node| matches!(node.shown, Some(Shown::Text { truncated: true, .. })));
    Ok(CanvasSnapshotOutput {
        document_id: document_id.to_owned(),
        nodes: projected,
        edges: edges_out,
        lines: lines_out,
        node_count: nodes.len(),
        edge_count: edges.len(),
        line_count: lines.len(),
        truncated: nodes.len() > SNAPSHOT_MAX_NODES
            || edges.len() > SNAPSHOT_MAX_EDGES
            || lines.len() > SNAPSHOT_MAX_EDGES
            || cut_text,
    })
}

fn items(value: Option<&Value>) -> Result<&[Value], Halt> {
    match value {
        Some(Value::Seq(items)) => Ok(items),
        _ => Err(UNDECIDED),
    }
}

/// An element's id, which a lock set names it by.
fn id_of(value: &Value) -> Result<String, Halt> {
    match field(value, "id") {
        Some(Value::String(id)) => Ok(id.clone()),
        _ => Err(UNDECIDED),
    }
}

/// A member copied as it stands, when the element holds it.
fn held(value: &Value, key: &str) -> Option<Value> {
    field(value, key).cloned()
}

/// `dressing`: the facets and the tags, each only when it holds something,
/// since an empty bucket or an empty tag list says nothing.
fn dressing(value: &Value) -> Result<(Option<Value>, Option<Value>), Halt> {
    let tags = match field(value, "tags") {
        None => None,
        Some(Value::Seq(items)) if items.is_empty() => None,
        Some(tags @ Value::Seq(_)) => Some(tags.clone()),
        Some(_) => return Err(UNDECIDED),
    };
    Ok((facets(value)?, tags))
}

/// The facet bucket, when it holds a facet.
fn facets(value: &Value) -> Result<Option<Value>, Halt> {
    match field(value, "facets") {
        None => Ok(None),
        Some(Value::Map(entries)) if entries.is_empty() => Ok(None),
        Some(facets) if holds_wide_map(facets) => Err(Halt::Pending(SnapshotPending::StoredOrder)),
        Some(facets @ Value::Map(_)) => Ok(Some(facets.clone())),
        Some(_) => Err(UNDECIDED),
    }
}

/// `projectNode`: a resource nothing claims projects as the frame its
/// published `group` already says it is.
fn node(value: &Value, locked: impl Fn(&str) -> bool) -> Result<SnapshotNode, Halt> {
    let model = node_of(value).ok_or(UNDECIDED)?;
    let kind = node_kind(&model);
    let (facets, tags) = dressing(value)?;
    let shown = match kind.unwrap_or(NodeKind::Frame) {
        NodeKind::Text => {
            let (text, truncated) = cut(node_text(&model).unwrap_or_default())?;
            Some(Shown::Text { text, truncated })
        }
        NodeKind::Frame => frame_label(&model).map(|label| Shown::Label(label.to_owned())),
        NodeKind::File => node_file(&model).map(|file| Shown::File(file.to_owned())),
        NodeKind::Link => node_url(&model).map(|url| Shown::Url(url.to_owned())),
    };
    Ok(SnapshotNode {
        locked: locked(&model.id),
        kind: match kind {
            Some(NodeKind::Text) => "text",
            Some(NodeKind::File) => "file",
            Some(NodeKind::Link) => "link",
            Some(NodeKind::Frame) | None => "group",
        },
        x: model.x,
        y: model.y,
        width: model.width,
        height: model.height,
        color: held(value, "color"),
        facets,
        tags,
        shown,
        id: model.id,
    })
}

/// `text` cut to the budget in UTF-16 units, no ellipsis appended, so what is
/// kept stays an exact prefix of what is stored.
fn cut(text: &str) -> Result<(String, bool), Halt> {
    let mut units = 0;
    for (at, unit) in text.char_indices() {
        let next = units + unit.len_utf16();
        if next > SNAPSHOT_TEXT_MAX_CHARS {
            if units < SNAPSHOT_TEXT_MAX_CHARS {
                return Err(Halt::Pending(SnapshotPending::LoneSurrogate));
            }
            return Ok((text[..at].to_owned(), true));
        }
        units = next;
    }
    Ok((text.to_owned(), false))
}

/// `projectEdge`.
fn edge(value: &Value, locked: impl Fn(&str) -> bool) -> Result<SnapshotEdge, Halt> {
    let id = id_of(value)?;
    let (facets, tags) = dressing(value)?;
    Ok(SnapshotEdge {
        locked: locked(&id),
        id,
        from: held(value, "from").ok_or(UNDECIDED)?,
        to: held(value, "to").ok_or(UNDECIDED)?,
        label: held(value, "label"),
        color: held(value, "color"),
        bends: held(value, "bends"),
        facets,
        tags,
    })
}

/// `projectLine`: no lock and no tags, since ink has neither.
fn line(value: &Value) -> Result<SnapshotLine, Halt> {
    Ok(SnapshotLine {
        id: id_of(value)?,
        from: held(value, "from").ok_or(UNDECIDED)?,
        to: held(value, "to").ok_or(UNDECIDED)?,
        label: held(value, "label"),
        color: held(value, "color"),
        bends: held(value, "bends"),
        facets: facets(value)?,
    })
}
