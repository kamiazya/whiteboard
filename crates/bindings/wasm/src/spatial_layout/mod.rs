//! `layoutSpatialCanvasWithAnchors` in one call (ADR-0054 step 7): a whole
//! canvas laid out by the composer, with the documents it points at, the
//! measurer and the caller's options handed over as DATA, so nothing crosses
//! back mid-layout.
//!
//! In: the request (the value wire of [`crate::json_canvas_wire`], read by
//! [`request`]) and the bytes of the faces a font-table measurer reads. Out:
//! one JSON text whose first element names the outcome:
//!
//! - `["ok", scene, anchors, degradations]`: the scene as the TypeScript holds
//!   it ([`whiteboard_canvas_render::scene_wire`]), the anchors as
//!   `[id, pair]` rows in the order the routing settled them, and what the
//!   layout reported instead of failing, as the TypeScript's events;
//! - `["refused", code, class]`: an input past this entry's caps, or one that
//!   is not a request;
//! - `["declined", class]`: a request the core cannot answer exactly as the
//!   TypeScript would (a body past the parser's bounds, a shortcode, a fence
//!   the highlighter colours, a canvas narrowed to a fragment, a text the
//!   font measurer cannot measure as the host's does, a number the answer
//!   cannot spell).
//!
//! A host answers the last two from the TypeScript.

mod answer;
mod measure;
mod request;

use std::sync::OnceLock;

use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_canvas_render::compose_canvas::{self, LayoutOptions, RenderStyle};
use whiteboard_canvas_render::compose_node::BodySeams;
use whiteboard_canvas_render::references::WireHost;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_plugin_visual::host::visual_registry;
use whiteboard_plugin_visual::render::StencilBadge;
use whiteboard_scene::NodeDecoration;

use crate::input_caps::LAYOUT_SPATIAL_CANVAS;
use crate::json_canvas_wire::json_value;
use answer::{declined, laid_out, refused};
use measure::{Measurer, measurer};
use request::{Request, request_of};

/// The most canvas elements (nodes, edges and lines) a request may hold, its
/// own canvas and every canvas it references together: this entry's
/// `maxNodes`, which bounds the routing a layout runs as `maxBytes` cannot.
pub const MAX_ELEMENTS: usize = match LAYOUT_SPATIAL_CANVAS.max_nodes {
    Some(n) => n,
    None => 0,
};

/// The most text a request's bodies may hold together, in bytes: every node's
/// content and every referenced body. One parse's own bound
/// (`whiteboard_markdown::limits::MAX_BYTES`, 768 KiB), so a layout parses at
/// most what one body may hold; the cost of a body is in its parse and its
/// typesetting, which `maxBytes` alone would let a request repeat.
pub const MAX_BODY_BYTES: usize = 786_432;

fn content_bytes(canvas: &SpatialCanvas) -> usize {
    canvas
        .nodes
        .iter()
        .filter_map(|node| node.resource.as_ref()?.content.as_ref())
        .fold(0, |sum, content| sum.saturating_add(content.len()))
}

fn body_total(request: &Request) -> usize {
    let referenced = request.references.entries.iter().filter_map(|(_, entry)| entry.as_ref());
    referenced.fold(content_bytes(&request.canvas), |sum, entry| {
        let body = entry.body.as_ref().map_or(0, String::len);
        let canvas = entry.canvas.as_ref().map_or(0, content_bytes);
        sum.saturating_add(body).saturating_add(canvas)
    })
}

fn elements(canvas: &SpatialCanvas) -> usize {
    let lines = canvas.lines.as_ref().map_or(0, Vec::len);
    canvas.nodes.len().saturating_add(canvas.edges.len()).saturating_add(lines)
}

fn element_total(request: &Request) -> usize {
    let referenced = request.references.entries.iter().filter_map(|(_, entry)| {
        let canvas = entry.as_ref()?.canvas.as_ref()?;
        Some(elements(canvas))
    });
    referenced.fold(elements(&request.canvas), usize::saturating_add)
}

/// The bundled visual plugin, built once per instance.
fn registry() -> Option<&'static Registry> {
    static REGISTRY: OnceLock<Option<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| visual_registry().ok()).as_ref()
}

/// The request laid out, as the answer's JSON text.
fn lay_out(request: &Request, measure: &Measurer<'_>, registry: &Registry) -> String {
    let mode = if request.dark { SpatialThemeMode::Dark } else { SpatialThemeMode::Light };
    let appearance = create_spatial_theme(mode, None);
    let host = WireHost::new(&request.references, request.expand);
    let badge = StencilBadge { registry };
    let decorations: [&dyn NodeDecoration; 1] = [&badge];
    let options = LayoutOptions {
        measure,
        appearance: &appearance,
        geometry: request.geometry,
        style: RenderStyle::Clean,
        themes: &[],
        font_available: None,
        registry,
        decorations: &decorations,
        tag_library: request.tags.as_ref(),
        suppressed: &request.suppressed,
        locked: &request.locked,
        side_overrides: request.overrides.as_deref(),
        host: &host,
        comments: whiteboard_canvas_render::comments::CommentOptions::default(),
        proposals: &[],
        content_cache: None,
        body: BodySeams {
            inline: &host,
            highlight: Some(&host),
            math: None,
            diagram: None,
            embeds: Some(&host),
        },
        budget: None,
        embed_path: &request.embed_path,
    };
    let laid = compose_canvas::layout_spatial_canvas(&request.canvas, &options);
    match host.refused() {
        Some(why) => declined(why.class()),
        None if measure.inexact() => declined("measure"),
        None => laid_out(&laid, &host.degradations()),
    }
}

/// A whole canvas laid out; see the module's documentation for the wire.
#[wasm_bindgen]
#[must_use]
pub fn layout_spatial_canvas(request: &str, fonts: &[u8]) -> String {
    if request.len().saturating_add(fonts.len()) > LAYOUT_SPATIAL_CANVAS.max_bytes {
        return refused("input-too-large", "too-large");
    }
    let Some(request) = serde_json::from_str(request).ok().as_ref().and_then(json_value) else {
        return refused("malformed", "wire");
    };
    let Some(request) = request_of(&request) else {
        return refused("malformed", "request");
    };
    if element_total(&request) > MAX_ELEMENTS {
        return refused("input-too-large", "too-many-elements");
    }
    if body_total(&request) > MAX_BODY_BYTES {
        return refused("input-too-large", "bodies");
    }
    let Some(measure) = measurer(&request.measure, fonts) else {
        return refused("malformed", "font");
    };
    match registry() {
        Some(registry) => lay_out(&request, &measure, registry),
        None => refused("malformed", "registry"),
    }
}

#[cfg(test)]
mod tests;
