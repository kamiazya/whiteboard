//! Where a thread points, and whether the document holds what it names: the
//! anchor as a tool accepts it, and as it is stored (`storedAnchor`).

use std::collections::{BTreeMap, BTreeSet};

use whiteboard_model::Value;
use whiteboard_model::node_content::node_text;
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_model::text_anchor::{TextAnchor, TextQuote, resolve_text_anchor};

use crate::js_offset::offset;

/// A spot, a node, an edge, a node set or a region of a canvas.
#[derive(Debug, Clone, PartialEq)]
pub struct SpatialAnchor {
    pub node_id: Option<String>,
    pub edge_id: Option<String>,
    pub node_ids: Option<Vec<String>>,
    pub x: f64,
    pub y: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

/// A passage of a note's body, or of a text node's text when `node_id` names
/// one, quoted and with the offsets the caller counted.
#[derive(Debug, Clone, PartialEq)]
pub struct TextPassage {
    pub node_id: Option<String>,
    pub prefix: Option<String>,
    pub exact: String,
    pub suffix: Option<String>,
    pub start: f64,
    pub end: f64,
}

/// Where a thread points: the surface it is about.
#[derive(Debug, Clone, PartialEq)]
pub enum ThreadAnchor {
    Spatial(SpatialAnchor),
    Text(TextPassage),
    Document,
}

/// What a document holds that an anchor may name.
pub(super) enum Content {
    Note(String),
    Board(Board),
}

/// A board's ids, indexed once per batch: an anchor may name a board's worth
/// of nodes and a batch many anchors, so a walk per id is ops x ids x nodes
/// of work under the workspace write lock. A node maps to its text, absent
/// for one that carries none.
pub(super) struct Board {
    nodes: BTreeMap<String, Option<String>>,
    edges: BTreeSet<String>,
}

impl Board {
    pub(super) fn of(canvas: &SpatialCanvas) -> Self {
        Self {
            nodes: canvas
                .nodes
                .iter()
                .map(|node| (node.id.clone(), node_text(node).map(str::to_owned)))
                .collect(),
            edges: canvas.edges.iter().map(|edge| edge.id.clone()).collect(),
        }
    }
}

fn number(n: f64) -> Value {
    Value::Number(n)
}

fn text(s: &str) -> Value {
    Value::String(s.to_owned())
}

/// The anchor as the schema parses it, which is the order its members are
/// written in.
fn spatial_value(anchor: &SpatialAnchor) -> Value {
    let mut members = vec![("kind".to_owned(), text("spatial"))];
    members.extend(anchor.node_id.iter().map(|id| ("nodeId".to_owned(), text(id))));
    members.extend(anchor.edge_id.iter().map(|id| ("edgeId".to_owned(), text(id))));
    members.extend(
        anchor
            .node_ids
            .iter()
            .map(|ids| ("nodeIds".to_owned(), Value::Seq(ids.iter().map(|id| text(id)).collect()))),
    );
    members.push(("x".to_owned(), number(anchor.x)));
    members.push(("y".to_owned(), number(anchor.y)));
    members.extend(anchor.width.map(|w| ("width".to_owned(), number(w))));
    members.extend(anchor.height.map(|h| ("height".to_owned(), number(h))));
    Value::Map(members)
}

fn text_value(passage: &TextPassage, start: f64, end: f64) -> Value {
    let mut quote = Vec::new();
    quote.extend(passage.prefix.iter().map(|p| ("prefix".to_owned(), text(p))));
    quote.push(("exact".to_owned(), text(&passage.exact)));
    quote.extend(passage.suffix.iter().map(|s| ("suffix".to_owned(), text(s))));
    let mut members = vec![("kind".to_owned(), text("text"))];
    members.extend(passage.node_id.iter().map(|id| ("nodeId".to_owned(), text(id))));
    members.push(("quote".to_owned(), Value::Map(quote)));
    members.push(("start".to_owned(), number(start)));
    members.push(("end".to_owned(), number(end)));
    Value::Map(members)
}

/// The anchor as it is stored, or why it names nothing on this document.
/// Checked at write time because an orphaned thread is what a LATER deletion
/// leaves behind: opening one already orphaned is a typo the caller reads
/// back as success. A passage is stored at where its quote is.
pub(super) fn stored(anchor: &ThreadAnchor, content: &Content) -> Result<Value, String> {
    match anchor {
        ThreadAnchor::Document => Ok(Value::Map(vec![("kind".to_owned(), text("document"))])),
        ThreadAnchor::Spatial(spatial) => {
            spatial_refusal(spatial, content).map_or_else(|| Ok(spatial_value(spatial)), Err)
        }
        ThreadAnchor::Text(passage) => stored_passage(passage, content),
    }
}

fn spatial_refusal(anchor: &SpatialAnchor, content: &Content) -> Option<String> {
    let Content::Board(board) = content else {
        return Some(
            "a markdown document has no canvas to anchor to; anchor to a quoted passage (kind: text) or to the document as a whole (kind: document)".to_owned(),
        );
    };
    let named = anchor.node_id.iter().chain(anchor.node_ids.iter().flatten());
    if let Some(missing) = named.into_iter().find(|id| !board.nodes.contains_key(*id)) {
        return Some(format!("node \"{missing}\" is not on the canvas"));
    }
    anchor
        .edge_id
        .as_ref()
        .filter(|id| !board.edges.contains(*id))
        .map(|id| format!("edge \"{id}\" is not on the canvas"))
}

/// The text a passage is quoted from, or why there is none.
fn quoted_text<'a>(node_id: Option<&String>, content: &'a Content) -> Result<&'a str, String> {
    match (node_id, content) {
        (None, Content::Note(body)) => Ok(body),
        (None, Content::Board(_)) => {
            Err("a canvas has no body to quote; name the text node the passage is in (nodeId)"
                .to_owned())
        }
        (Some(id), Content::Note(_)) => {
            Err(format!("a markdown document has no node \"{id}\"; omit nodeId to quote its body"))
        }
        (Some(id), Content::Board(board)) => match board.nodes.get(id) {
            None => Err(format!("node \"{id}\" is not on the canvas")),
            Some(None) => Err(format!("node \"{id}\" is not a text node")),
            Some(Some(text)) => Ok(text),
        },
    }
}

fn stored_passage(passage: &TextPassage, content: &Content) -> Result<Value, String> {
    let body = quoted_text(passage.node_id.as_ref(), content)?;
    let units: Vec<u16> = body.encode_utf16().collect();
    let asked = TextAnchor {
        node_id: passage.node_id.clone(),
        quote: TextQuote {
            prefix: passage.prefix.clone(),
            exact: passage.exact.clone(),
            suffix: passage.suffix.clone(),
        },
        start: offset(passage.start),
        end: offset(passage.end),
    };
    // Offsets that already select the quote are the ones it is found at.
    if let Some(placed) = resolve_text_anchor(&units, &asked) {
        return Ok(text_value(passage, to_number(placed.start), to_number(placed.end)));
    }
    let place = passage
        .node_id
        .as_ref()
        .map_or_else(|| "body".to_owned(), |id| format!("text of node \"{id}\""));
    Err(format!("the passage {} is not in the {place}", json_quote(&passage.exact)))
}

/// An offset into a body as the number it is stored as: far below 2^53, and
/// below `u32::MAX` for any body a write holds.
fn to_number(at: usize) -> f64 {
    f64::from(u32::try_from(at).unwrap_or(u32::MAX))
}

/// `JSON.stringify` of a well-formed string.
pub(super) fn json_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                let n = u32::from(c);
                out.push_str("\\u00");
                out.extend(
                    [n >> 4, n & 0xf].map(|digit| char::from_digit(digit, 16).unwrap_or('0')),
                );
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
