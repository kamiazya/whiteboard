//! The layout pieces a root calls on their own, in one export (ADR-0054 step
//! 7, S18d): `layout_query` answers the request [`super::request::Query`]
//! names, through the same decoder, measurers, caps and plugin as
//! `layout_spatial_canvas`, so a drag frame, a label editor, a compose bubble,
//! a body overlay or an auto-fit is answered by the composer that drew the
//! committed scene.
//!
//! Out: one JSON text whose first element names the outcome, as the whole
//! layout's does (`refused`, `needs`), and when answered:
//!
//! - `edges`: `["ok", nodes, degradations]`, the edge layer as `scene_wire`
//!   writes scene nodes, and what the layout reported instead of failing;
//! - every other query: `["ok", ...]`, each double the sixteen hex digits of
//!   its bits, so a non-finite answer crosses as exactly as a finite one:
//!   `node-size` `[h]`, `node-content` `[w, h]`, `label-placement` `[x, y]`
//!   or `[]` for a path that draws no line, `label-obstacles` the frame
//!   titles then every obstacle as `[x, y, w, h]` rows, `comment-bubble` and
//!   `outline-content-box` `[x, y, w, h]`.

use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_canvas_render::comments::placement::place_comment_bubble;
use whiteboard_canvas_render::compose_canvas::{
    ContentSize, layout_spatial_edges, natural_node_content_size,
};
use whiteboard_canvas_render::compose_edges::{LabelSize, edge_label_placement, label_obstacles};
use whiteboard_canvas_render::constant_ratio::ConstantRatioMeasure;
use whiteboard_canvas_render::measure::Measure;
use whiteboard_canvas_render::node_outline::outline_content_box;
use whiteboard_canvas_render::scene_wire::{Tree, nodes_tree};
use whiteboard_canvas_render::theme::geometry::SPATIAL_THEME_GEOMETRY;
use whiteboard_det::math::js_max;
use whiteboard_model::node_content::is_frame;
use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{BoundingBox, SceneNode};

use super::answer::{events, refused};
use super::host_measure::{Host, HostMeasurer};
use super::request::{NodeSize, Query, Request, Run, query_of};
use super::{
    MAX_BODY_BYTES, MAX_ELEMENTS, MAX_FRAGMENTS, measured, past_canvas_caps, plugin, settled,
    with_options,
};
use crate::input_caps::LAYOUT_QUERY;
use crate::json_canvas_wire::json_value;

/// A query answered; see the module's documentation for the wire. `host`
/// measures a request that names `{kind: 'host'}`.
#[wasm_bindgen]
#[must_use]
#[expect(
    clippy::needless_pass_by_value,
    reason = "wasm-bindgen hands an imported object over by value"
)]
pub fn layout_query(request: &str, host: Option<HostMeasurer>) -> String {
    query_with_host(request, host.as_ref().map(|host| host as &dyn Host))
}

/// [`layout_query`] over any [`Host`]: a native caller's stand-in.
#[must_use]
pub fn query_with_host(request: &str, host: Option<&dyn Host>) -> String {
    if request.len() > LAYOUT_QUERY.max_bytes {
        return refused("input-too-large", "too-large");
    }
    let Some(value) = serde_json::from_str(request).ok().as_ref().and_then(json_value) else {
        return refused("malformed", "wire");
    };
    match query_of(&value) {
        Some(Query::Edges(request)) => edges(&request, host),
        Some(Query::NodeSize(size)) => node_size(&size, host),
        Some(Query::LabelPlacement { path, size: [w, h], obstacles, rounded }) => {
            let placed = edge_label_placement(&path, LabelSize { w, h }, &obstacles, rounded);
            ok(vec![hexes(placed.iter().flat_map(|p| [p.x, p.y]))])
        }
        Some(Query::LabelObstacles { nodes, .. }) if nodes.len() > MAX_ELEMENTS => {
            refused("input-too-large", "too-many-elements")
        }
        Some(Query::LabelObstacles { runs, .. }) if runs.len() > MAX_RUNS => {
            refused("input-too-large", "runs")
        }
        Some(Query::LabelObstacles { nodes, runs }) => {
            let titles = frame_titles(&nodes, &runs);
            let obstacles = label_obstacles(&nodes, &titles);
            ok(vec![boxes(&titles), boxes(&obstacles)])
        }
        Some(Query::CommentBubble { anchor, size: [w, h], obstacles }) => {
            ok(vec![box_tree(&place_comment_bubble(anchor, w, h, &obstacles))])
        }
        Some(Query::OutlineContentBox { shape, bbox }) => {
            ok(vec![box_tree(&outline_content_box(shape.as_deref(), &bbox))])
        }
        None => refused("malformed", "request"),
    }
}

fn hex(n: f64) -> Tree {
    Tree::Text(format!("{:016x}", n.to_bits()))
}

fn hexes(numbers: impl IntoIterator<Item = f64>) -> Tree {
    Tree::List(numbers.into_iter().map(hex).collect())
}

fn box_tree(b: &BoundingBox) -> Tree {
    hexes([b.x, b.y, b.w, b.h])
}

fn boxes(boxes: &[BoundingBox]) -> Tree {
    Tree::List(boxes.iter().map(box_tree).collect())
}

/// `["ok", items...]`; the items hold text alone, which always has a spelling.
fn ok(items: Vec<Tree>) -> String {
    let mut answer = vec![Tree::Text("ok".to_owned())];
    answer.extend(items);
    Tree::List(answer).to_json().unwrap_or_default()
}

/// The frame titles among `runs` (`frameTitleObstacles`): the boxes of the runs
/// that annotate a node the canvas holds as a frame, in the scene's order.
fn frame_titles(nodes: &[SpatialNode], runs: &[Run]) -> Vec<BoundingBox> {
    let frames: Vec<&str> =
        nodes.iter().filter(|node| is_frame(node)).map(|node| node.id.as_str()).collect();
    let titled = |run: &&Run| run.node && frames.contains(&run.id.as_str());
    runs.iter().filter(titled).map(|run| run.bbox).collect()
}

/// The most runs a `label-obstacles` query may hand: four per element. Each
/// run is looked up among the frames, so the query costs the runs times the
/// nodes, which bytes do not bound.
pub const MAX_RUNS: usize = MAX_ELEMENTS * 4;

/// The edge layer of a canvas request, or why it is not answered.
fn edges(request: &Request, host: Option<&dyn Host>) -> String {
    if let Some(what) = past_canvas_caps(request) {
        return refused("input-too-large", what);
    }
    let plugin = match plugin(&request.font_families) {
        Ok(plugin) => plugin,
        Err(refusal) => return refusal,
    };
    measured(&request.measure, host, None, |measure, _| {
        with_options(request, measure, None, plugin, &mut |options, wire, _| {
            let nodes = layout_spatial_edges(&request.canvas, options);
            settled(wire, || edge_layer(&nodes, wire))
        })
    })
}

fn edge_layer(
    nodes: &[SceneNode],
    wire: &whiteboard_canvas_render::references::WireHost<'_>,
) -> String {
    let answer = Tree::List(vec![
        Tree::Text("ok".to_owned()),
        nodes_tree(nodes),
        events(&wire.degradations()),
    ]);
    answer.to_json().unwrap_or_else(|_| refused("malformed", "non-finite"))
}

/// A node's size, or why it is not answered: refused past the bodies' or the
/// fragment table's cap.
fn node_size(size: &NodeSize, host: Option<&dyn Host>) -> String {
    let content = size.node.resource.as_ref().and_then(|resource| resource.content.as_ref());
    if content.map_or(0, String::len) > MAX_BODY_BYTES {
        return refused("input-too-large", "bodies");
    }
    if size.layout.fragments.as_ref().is_some_and(|table| table.len() > MAX_FRAGMENTS) {
        return refused("input-too-large", "fragments");
    }
    let plugin = match plugin(&size.layout.font_families) {
        Ok(plugin) => plugin,
        Err(refusal) => return refusal,
    };
    measured(&size.layout.measure, host, None, |measure, _| {
        // The content's size under `measure`, or the answer that stands for it.
        let under = |measure: &dyn Measure| -> Result<ContentSize, String> {
            let mut natural = ContentSize { w: 0.0, h: 0.0 };
            let unanswered =
                with_options(&size.layout, measure, None, plugin, &mut |options, wire, _| {
                    natural = natural_node_content_size(&size.node, options);
                    settled(wire, String::new)
                });
            if unanswered.is_empty() { Ok(natural) } else { Err(unanswered) }
        };
        let own = match under(measure) {
            Ok(own) => own,
            Err(answer) => return answer,
        };
        let Some(ratio_floor) = size.ratio_floor else {
            return ok(vec![hexes([own.w, own.h])]);
        };
        let natural = if ratio_floor {
            match under(&ConstantRatioMeasure) {
                Ok(ratio) => js_max(own.h, ratio.h),
                Err(answer) => return answer,
            }
        } else {
            own.h
        };
        ok(vec![hexes([natural + 2.0 * SPATIAL_THEME_GEOMETRY.padding_px])])
    })
}
