//! What `layout_query` is asked (ADR-0054 step 7, S18d): one mapping whose
//! `query` names the layout piece a root calls on its own, the rest that
//! piece's arguments as data, read as strictly as a canvas request.
//!
//! - `edges`: a canvas request's fields, whose edge layer alone is laid out
//!   (`layoutSpatialEdges`);
//! - `node-size`: a node, the measurer, the mode and the `floor`
//!   (`fittedTextNodeHeight`);
//! - `node-content`: a node and the options a layout carries
//!   (`naturalNodeContentSize`);
//! - `label-placement`: a drawn path, a label's size, the obstacles and
//!   whether the path is drawn rounded (`edgeLabelPlacement`);
//! - `label-obstacles`: the canvas's nodes and the scene's annotating runs as
//!   `[kind, id, box]` rows (`frameTitleObstacles`, then `labelObstacles`);
//! - `comment-bubble`: an anchor, a bubble's size and the obstacles
//!   (`placeCommentBubble`);
//! - `outline-content-box`: a silhouette id, absent for none, and a box
//!   (`outlineContentBox`);
//! - `tidy`: the board's boxes as `[id, frame, x, y, w, h]` rows, the ids that
//!   may not move (`locked`), the unit roots that may (`scope`, absent for the
//!   whole board) and the edges as `[from, to]` rows, each end an id or null
//!   (`tidyNodes`);
//! - `notice`: a title and a detail, the mode, the measurer, the width there
//!   is, where the box sits and the `svg` it is drawn in (`refusalScene`'s
//!   drawing; the words are the caller's).
//!
//! A point is `[x, y]`, a size `[w, h]` and a box `[x, y, w, h]`.

use std::collections::BTreeSet;

use whiteboard_canvas_render::references::{Expansion, ReferenceWire};
use whiteboard_canvas_render::tidy::{TidyNode, TidyOptions};
use whiteboard_model::Value;
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};
use whiteboard_scene::{BoundingBox, ScenePoint};

use super::code::code_tokens_of;
use super::fragments::fragments_of;
use super::measure::{MeasureSpec, measure_of};
use super::options::{dark_of, style_of};
use super::svg::{SvgAsk, svg_of};
use super::{Comments, Request, Style, flag_of, request_from, strings_of};
use crate::json_canvas_wire::{Fields, items_of, node_of, number_of, string_of};

/// A node's size asked: its fitted height, or its content's natural size.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NodeSize {
    pub(crate) node: SpatialNode,
    /// For the fitted height: whether the ratio measurer is a floor under the
    /// caller's. `None` asks the content's natural size.
    pub(crate) ratio_floor: Option<bool>,
    /// The options the node is laid out with, as a canvas request holding no
    /// element: nothing resolves and no file node is drawn open.
    pub(crate) layout: Request,
}

/// One scene run that annotates an element: what it annotates, and its box.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Run {
    pub(crate) node: bool,
    pub(crate) id: String,
    pub(crate) bbox: BoundingBox,
}

/// A notice asked: what it says, and how it is drawn.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NoticeAsk {
    pub(crate) title: String,
    pub(crate) detail: String,
    pub(crate) dark: bool,
    pub(crate) measure: MeasureSpec,
    pub(crate) max_width: Option<f64>,
    pub(crate) at: Option<ScenePoint>,
    pub(crate) svg: Option<SvgAsk>,
}

/// A query.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Query {
    Notice(Box<NoticeAsk>),
    Edges(Box<Request>),
    SceneDigest(Box<Request>),
    NodeSize(Box<NodeSize>),
    LabelPlacement {
        path: Vec<ScenePoint>,
        size: [f64; 2],
        obstacles: Vec<BoundingBox>,
        rounded: bool,
    },
    LabelObstacles {
        nodes: Vec<SpatialNode>,
        runs: Vec<Run>,
    },
    CommentBubble {
        anchor: ScenePoint,
        size: [f64; 2],
        obstacles: Vec<BoundingBox>,
    },
    OutlineContentBox {
        shape: Option<String>,
        bbox: BoundingBox,
    },
    Tidy {
        nodes: Vec<TidyNode>,
        options: TidyOptions,
    },
}

fn numbers<const N: usize>(value: &Value) -> Option<[f64; N]> {
    items_of(value, number_of)?.try_into().ok()
}

fn point_of(value: &Value) -> Option<ScenePoint> {
    numbers(value).map(|[x, y]| ScenePoint { x, y })
}

fn box_of(value: &Value) -> Option<BoundingBox> {
    numbers(value).map(|[x, y, w, h]| BoundingBox { x, y, w, h })
}

fn run_of(value: &Value) -> Option<Run> {
    let Value::Seq(items) = value else { return None };
    let [kind, id, bbox] = items.as_slice() else { return None };
    let node = match string_of(kind)?.as_str() {
        "node" => true,
        "edge" => false,
        _ => return None,
    };
    Some(Run { node, id: string_of(id)?, bbox: box_of(bbox)? })
}

fn tidy_node_of(value: &Value) -> Option<TidyNode> {
    let Value::Seq(items) = value else { return None };
    let [id, frame, x, y, w, h] = items.as_slice() else { return None };
    Some(TidyNode {
        id: string_of(id)?,
        frame: flag_of(frame)?,
        x: number_of(x)?,
        y: number_of(y)?,
        width: number_of(w)?,
        height: number_of(h)?,
    })
}

/// An edge as `[from, to]`, each end a node id or null for one that names none.
fn tidy_edge_of(value: &Value) -> Option<(Option<String>, Option<String>)> {
    let Value::Seq(items) = value else { return None };
    let [from, to] = items.as_slice() else { return None };
    let end = |end: &Value| match end {
        Value::Null => Some(None),
        other => string_of(other).map(Some),
    };
    Some((end(from)?, end(to)?))
}

fn tidy_of(f: &mut Fields<'_>) -> Option<Query> {
    let nodes = f.field("nodes", |v| items_of(v, tidy_node_of))??;
    let scope = f.field("scope", strings_of)?.map(|ids| ids.into_iter().collect::<BTreeSet<_>>());
    let locked = f.field("locked", strings_of)?.unwrap_or_default().into_iter().collect();
    let edges = f.field("edges", |v| items_of(v, tidy_edge_of))?;
    Some(Query::Tidy { nodes, options: TidyOptions { scope, locked, edges } })
}

fn floor_of(value: &Value) -> Option<bool> {
    match string_of(value)?.as_str() {
        "ratio" => Some(true),
        "none" => Some(false),
        _ => None,
    }
}

/// A node's size: `fitted` reads the floor and takes the fitted height's
/// options alone, as `fittedTextNodeHeight` hands `naturalNodeContentSize`
/// only the measurer and the appearance.
fn node_size_of(f: &mut Fields<'_>, fitted: bool) -> Option<NodeSize> {
    let node = f.field("node", node_of)??;
    let measure = f.field("measure", measure_of)??;
    let dark = f.field("mode", dark_of)??;
    let code_tokens = f.field("codeTokens", code_tokens_of)?.unwrap_or_default();
    let (ratio_floor, style, font_families, fragments) = if fitted {
        (Some(f.field("floor", floor_of)??), Style::Clean, Vec::new(), None)
    } else {
        (
            None,
            f.field("style", style_of)?.unwrap_or_default(),
            f.field("fontFamilies", strings_of)?.unwrap_or_default(),
            f.field("fragments", fragments_of)?,
        )
    };
    let layout = Request {
        canvas: SpatialCanvas::default(),
        measure,
        dark,
        style,
        font_families,
        geometry: None,
        locked: Vec::new(),
        suppressed: Vec::new(),
        overrides: None,
        tags: None,
        embed_path: Vec::new(),
        references: ReferenceWire::default(),
        expand: Expansion::Every(false),
        code_tokens,
        proposals: Vec::new(),
        comments: Comments::default(),
        fragments,
        cache: None,
        svg: None,
    };
    Some(NodeSize { node, ratio_floor, layout })
}

fn query_from(f: &mut Fields<'_>, query: &str) -> Option<Query> {
    Some(match query {
        "edges" => {
            let request = request_from(f)?;
            Query::Edges(Box::new(Request { svg: f.field("svg", svg_of)?, ..request }))
        }
        "scene-digest" => Query::SceneDigest(Box::new(request_from(f)?)),
        "node-size" => Query::NodeSize(Box::new(node_size_of(f, true)?)),
        "node-content" => Query::NodeSize(Box::new(node_size_of(f, false)?)),
        "label-placement" => Query::LabelPlacement {
            path: f.field("path", |v| items_of(v, point_of))??,
            size: f.field("size", numbers)??,
            obstacles: f.field("obstacles", |v| items_of(v, box_of))??,
            rounded: f.field("rounded", flag_of)??,
        },
        "label-obstacles" => Query::LabelObstacles {
            nodes: f.field("nodes", |v| items_of(v, node_of))??,
            runs: f.field("runs", |v| items_of(v, run_of))??,
        },
        "comment-bubble" => Query::CommentBubble {
            anchor: f.field("anchor", point_of)??,
            size: f.field("size", numbers)??,
            obstacles: f.field("obstacles", |v| items_of(v, box_of))??,
        },
        "outline-content-box" => Query::OutlineContentBox {
            shape: f.field("shape", string_of)?,
            bbox: f.field("box", box_of)??,
        },
        "tidy" => tidy_of(f)?,
        "notice" => Query::Notice(Box::new(NoticeAsk {
            title: f.field("title", string_of)??,
            detail: f.field("detail", string_of)??,
            dark: f.field("mode", dark_of)??,
            measure: f.field("measure", measure_of)??,
            max_width: f.field("maxWidth", number_of)?,
            at: f.field("at", point_of)?,
            svg: f.field("svg", svg_of)?,
        })),
        _ => return None,
    })
}

/// The query a value stands for, or `None` when it is none.
pub(crate) fn query_of(value: &Value) -> Option<Query> {
    let mut f = Fields::of(value)?;
    let query = f.field("query", string_of)??;
    let asked = query_from(&mut f, &query)?;
    f.all_named().then_some(asked)
}
