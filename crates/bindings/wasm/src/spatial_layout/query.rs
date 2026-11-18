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
//! - `edges`: `["ok", nodes, degradations, svg?]`, the edge layer as
//!   `scene_wire` writes scene nodes, what the layout reported instead of
//!   failing, and, for a request carrying `svg`, the layer drawn as a scene of
//!   its own in the envelope it names (the drag overlay's picture in the same
//!   call), refused `input-too-large`/`svg` past `MAX_SVG_BYTES`;
//! - `scene-digest`: `["ok", digest, degradations]`, the digest as the text
//!   `SceneDigest::to_json` writes and the degradations as `edges` carries them;
//! - every other query: `["ok", ...]`, each double the sixteen hex digits of
//!   its bits, so a non-finite answer crosses as exactly as a finite one:
//!   `node-size` `[h]`, `node-content` `[w, h]`, `label-placement` `[x, y]`
//!   or `[]` for a path that draws no line, `label-obstacles` the frame
//!   titles then every obstacle as `[x, y, w, h]` rows, `comment-bubble` and
//!   `outline-content-box` `[x, y, w, h]`;
//! - `tidy`: `["ok", move...]`, each box that moves as `[id, x, y]`, or
//!   `[id, x, y, w, h]` for a frame that grew, the numbers as bits;
//! - `notice`: `["ok", nodes, [], svg?]`, as `edges` answers, the notice drawn
//!   by `whiteboard_canvas_render::notice`; a host measurer that did not
//!   answer draws it by the ratio estimate rather than refusing it.

use std::collections::BTreeSet;

use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_canvas_render::comments::placement::place_comment_bubble;
use whiteboard_canvas_render::compose_canvas::{
    ContentSize, layout_spatial_canvas, layout_spatial_edges, natural_node_content_size,
};
use whiteboard_canvas_render::compose_edges::{LabelSize, edge_label_placement, label_obstacles};
use whiteboard_canvas_render::constant_ratio::ConstantRatioMeasure;
use whiteboard_canvas_render::measure::Measure;
use whiteboard_canvas_render::node_outline::outline_content_box;
use whiteboard_canvas_render::notice::{NoticeOptions, notice_scene};
use whiteboard_canvas_render::scene_digest::{DigestError, scene_digest};
use whiteboard_canvas_render::scene_wire::{Tree, nodes_tree};
use whiteboard_canvas_render::theme::geometry::SPATIAL_THEME_GEOMETRY;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::tidy::{TidyMove, TidyNode, TidyOptions, tidy_nodes};
use whiteboard_det::math::js_max;
use whiteboard_model::node_content::is_frame;
use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{BoundingBox, Scene, SceneNode};

use super::answer::{events, refused, svg_item};
use super::host_measure::{Host, HostMeasurer};
use super::request::{NodeSize, NoticeAsk, Query, Request, Run, SvgAsk, query_of};
use super::{
    MAX_BODY_BYTES, MAX_ELEMENTS, MAX_FRAGMENTS, MAX_SVG_BYTES, Unmeasured, measured,
    past_canvas_caps, plugin, settled, with_measurer, with_options,
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
        Some(Query::SceneDigest(request)) => digest(&request, host),
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
        Some(Query::Tidy { nodes, options }) => tidy(&nodes, &options),
        Some(Query::Notice(ask)) => notice(&ask, host),
        None => refused("malformed", "request"),
    }
}

/// The most bytes a notice's words may hold together. Its words are a
/// sentence or two, so this bounds how many texts the wrap measures without
/// asking the whole request's bytes to.
pub(super) const MAX_NOTICE_BYTES: usize = 64 * 1024;

/// A notice drawn, its picture beside it when `svg` asks for one. A measurer
/// that fails draws it by the ratio estimate: a notice is what a surface draws
/// where the host's own measurer failed, so it cannot depend on it.
fn notice(ask: &NoticeAsk, host: Option<&dyn Host>) -> String {
    if ask.title.len().saturating_add(ask.detail.len()) > MAX_NOTICE_BYTES {
        return refused("input-too-large", "too-large");
    }
    let mode = if ask.dark { SpatialThemeMode::Dark } else { SpatialThemeMode::Light };
    let options = NoticeOptions { mode, max_width: ask.max_width, at: ask.at };
    let draw = |measure: &dyn Measure| notice_scene(&ask.title, &ask.detail, &options, measure);
    let scene = match with_measurer(&ask.measure, host, draw) {
        Ok(scene) => scene,
        Err(Unmeasured::Host) => draw(&ConstantRatioMeasure),
        Err(Unmeasured::FontHandle) => return refused("malformed", "font-handle"),
    };
    let mut items =
        vec![Tree::Text("ok".to_owned()), nodes_tree(&scene.nodes), Tree::List(Vec::new())];
    if let Some(svg) = &ask.svg {
        match svg_item(&scene, svg, MAX_SVG_BYTES) {
            Ok(item) => items.push(item),
            Err(refusal) => return refusal,
        }
    }
    Tree::List(items).to_json().unwrap_or_else(|_| refused("malformed", "non-finite"))
}

/// The boxes a tidy moves, or why it is not answered: refused past the
/// element cap on the board, its edges or the ids it names, and for a box
/// whose coordinate no move can be written from.
fn tidy(nodes: &[TidyNode], options: &TidyOptions) -> String {
    let named = options.scope.as_ref().map_or(0, BTreeSet::len).max(options.locked.len());
    let edges = options.edges.as_ref().map_or(0, Vec::len);
    if nodes.len().max(edges).max(named) > MAX_ELEMENTS {
        return refused("input-too-large", "too-many-elements");
    }
    if nodes.iter().any(|n| ![n.x, n.y, n.width, n.height].iter().all(|v| v.is_finite())) {
        return refused("malformed", "non-finite");
    }
    ok(tidy_nodes(nodes, options).iter().map(move_tree).collect())
}

fn move_tree(moved: &TidyMove) -> Tree {
    let mut row = vec![Tree::Text(moved.id.clone()), hex(moved.x), hex(moved.y)];
    if let Some((w, h)) = moved.size {
        row.extend([hex(w), hex(h)]);
    }
    Tree::List(row)
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
            settled(wire, || edge_layer(nodes, wire, request.svg.as_ref()))
        })
    })
}

/// The spatial digest of the scene a canvas request lays out, as the text
/// `SceneDigest::to_json` writes beside what the layout reported, or why it is not answered. The scene never
/// crosses the boundary: the digest is read where it is laid out.
fn digest(request: &Request, host: Option<&dyn Host>) -> String {
    if let Some(what) = past_canvas_caps(request) {
        return refused("input-too-large", what);
    }
    let plugin = match plugin(&request.font_families) {
        Ok(plugin) => plugin,
        Err(refusal) => return refusal,
    };
    measured(&request.measure, host, None, |measure, _| {
        with_options(request, measure, None, plugin, &mut |options, wire, _| {
            let laid = layout_spatial_canvas(&request.canvas, options);
            settled(wire, || match scene_digest(&laid.scene) {
                // A box the grid never sized (one non-finite coordinate on a
                // single row) would be written as `null`, which the reader's
                // schema refuses as a crash rather than a refusal.
                Ok(digest) if !finite_boxes(&digest) => refused("malformed", "non-finite"),
                Ok(digest) => ok(vec![Tree::Text(digest.to_json()), events(&wire.degradations())]),
                // The grid a non-finite coordinate cannot size: the same
                // layout the scene's own answer refuses as non-finite.
                Err(DigestError::InvalidGrid) => refused("malformed", "non-finite"),
            })
        })
    })
}

/// Every box the digest names is finite.
fn finite_boxes(digest: &whiteboard_canvas_render::scene_digest::SceneDigest) -> bool {
    let finite = |b: &whiteboard_scene::BoundingBox| {
        b.x.is_finite() && b.y.is_finite() && b.w.is_finite() && b.h.is_finite()
    };
    digest.nodes.iter().all(|node| finite(&node.bbox)) && digest.free_regions.iter().all(finite)
}

/// The edge layer, what the layout reported, and, when `svg` asks for one,
/// the layer drawn as a scene of its own (no legend) last.
fn edge_layer(
    nodes: Vec<SceneNode>,
    wire: &whiteboard_canvas_render::references::WireHost<'_>,
    svg: Option<&SvgAsk>,
) -> String {
    let mut items =
        vec![Tree::Text("ok".to_owned()), nodes_tree(&nodes), events(&wire.degradations())];
    if let Some(svg) = svg {
        match svg_item(&Scene { nodes, legend: None }, svg, MAX_SVG_BYTES) {
            Ok(item) => items.push(item),
            Err(refusal) => return refusal,
        }
    }
    Tree::List(items).to_json().unwrap_or_else(|_| refused("malformed", "non-finite"))
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
