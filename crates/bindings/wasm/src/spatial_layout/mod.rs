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
//! - `["needs", {code}]`: the fences, as `[lang, value]` rows in the order the
//!   layout met them, that the default highlighter colours and whose tokens the
//!   request's `codeTokens` did not carry; the host tokenises exactly those and
//!   asks once more with them (owner decision q75);
//! - `["declined", class]`: a request the core cannot answer exactly as the
//!   TypeScript would (a body past the parser's bounds, a number the answer
//!   cannot spell).
//!
//! A host answers a refusal and a decline from the TypeScript.

mod answer;
mod measure;
mod request;

use std::sync::OnceLock;

use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_canvas_render::compose_canvas::{self, LayoutOptions, RenderStyle};
use whiteboard_canvas_render::compose_node::BodySeams;
use whiteboard_canvas_render::measure::Measure;
use whiteboard_canvas_render::references::{Expansion, WireHost};
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_canvas_render::theme::tokens::theme_table;
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::annotation::{AnnotationAnchor, CommentThread};
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_plugin_visual::host::{THEMES, visual_registry};
use whiteboard_plugin_visual::render::StencilBadge;
use whiteboard_scene::NodeDecoration;

use crate::input_caps::LAYOUT_SPATIAL_CANVAS;
use crate::json_canvas_wire::json_value;
use answer::{declined, laid_out, needs, refused};
use measure::measurer;
use request::{Comments, Request, Style, request_of};

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

/// The bodies a comment layer lays out: each thread's opening message.
fn opening_bytes(threads: &[CommentThread]) -> usize {
    let openings = threads.iter().filter_map(|thread| thread.messages.first());
    openings.fold(0, |sum, message| sum.saturating_add(message.body.len()))
}

fn body_total(request: &Request) -> usize {
    let referenced = request.references.entries.iter().filter_map(|(_, entry)| entry.as_ref());
    let own =
        content_bytes(&request.canvas).saturating_add(opening_bytes(&request.comments.threads));
    referenced.fold(own, |sum, entry| {
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

/// How many file-node ids the expansion policy lists. Each names a file node
/// of the request, so an honest list is no longer than the element cap; past
/// it the list is refused with the elements, since every file node is asked
/// against every listed id.
fn expanded_ids(request: &Request) -> usize {
    match &request.expand {
        Expansion::Every(_) => 0,
        Expansion::Only(ids) => ids.len(),
    }
}

/// The most threads, the most obstacles, and the most node ids the node-set
/// anchors name together, that a comment layer may hold: the element cap.
/// Each thread's bubble is placed against every box and every earlier bubble,
/// and each node-set id is looked up against every node, so what a layer costs
/// grows with their product, which bytes do not bound.
pub const MAX_COMMENT_ITEMS: usize = MAX_ELEMENTS;

/// The most passages a comment layer may anchor: a quarter of the element
/// cap. Each is looked for through the whole text of the node it names, so
/// what they cost is their count times the bodies, which the bodies' own cap
/// bounds only once.
pub const MAX_PASSAGES: usize = MAX_COMMENT_ITEMS / 4;

fn passages(threads: &[CommentThread]) -> usize {
    threads.iter().filter(|thread| matches!(thread.anchor, AnnotationAnchor::Text(_))).count()
}

fn node_set_ids(threads: &[CommentThread]) -> usize {
    let sets = threads.iter().filter_map(|thread| match &thread.anchor {
        AnnotationAnchor::Spatial(anchor) => anchor.node_ids.as_ref().map(Vec::len),
        _ => None,
    });
    sets.fold(0, usize::saturating_add)
}

fn past_comment_caps(comments: &Comments) -> bool {
    comments.threads.len() > MAX_COMMENT_ITEMS
        || comments.obstacles.len() > MAX_COMMENT_ITEMS
        || node_set_ids(&comments.threads) > MAX_COMMENT_ITEMS
        || passages(&comments.threads) > MAX_PASSAGES
}

/// The bundled visual plugin, built once per instance.
fn registry() -> Option<&'static Registry> {
    static REGISTRY: OnceLock<Option<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| visual_registry().ok()).as_ref()
}

/// The bundled plugin's themes by namespaced id, read once per instance.
fn themes() -> Option<&'static [(String, ThemeTokens)]> {
    static THEME_TABLE: OnceLock<Option<Vec<(String, ThemeTokens)>>> = OnceLock::new();
    THEME_TABLE.get_or_init(|| theme_table("visual", THEMES)).as_deref()
}

fn render_style(style: &Style) -> RenderStyle<'_> {
    match style {
        Style::Clean => RenderStyle::Clean,
        Style::Document => RenderStyle::Document,
        Style::Theme(id) => RenderStyle::Theme(id),
    }
}

/// The request laid out, as the answer's JSON text.
fn lay_out(
    request: &Request,
    measure: &dyn Measure,
    registry: &Registry,
    themes: &[(String, ThemeTokens)],
) -> String {
    let mode = if request.dark { SpatialThemeMode::Dark } else { SpatialThemeMode::Light };
    let held = |family: &str| request.font_families.iter().any(|held| held == family);
    let appearance = create_spatial_theme(mode, None);
    let host = WireHost::new(&request.references, request.expand.clone())
        .with_code_tokens(&request.code_tokens);
    let badge = StencilBadge { registry };
    let decorations: [&dyn NodeDecoration; 1] = [&badge];
    let options = LayoutOptions {
        measure,
        appearance: &appearance,
        geometry: request.geometry,
        style: render_style(&request.style),
        themes,
        font_available: Some(&held),
        registry,
        decorations: &decorations,
        tag_library: request.tags.as_ref(),
        suppressed: &request.suppressed,
        locked: &request.locked,
        side_overrides: request.overrides.as_deref(),
        host: &host,
        comments: request.comments.options(),
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
    let asked = host.needs();
    match host.refused() {
        Some(why) => declined(why.class()),
        None if !asked.is_empty() => needs(&asked),
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
    if element_total(&request) > MAX_ELEMENTS || expanded_ids(&request) > MAX_ELEMENTS {
        return refused("input-too-large", "too-many-elements");
    }
    if past_comment_caps(&request.comments) {
        return refused("input-too-large", "comments");
    }
    if body_total(&request) > MAX_BODY_BYTES {
        return refused("input-too-large", "bodies");
    }
    let Some(measure) = measurer(&request.measure, fonts) else {
        return refused("malformed", "font");
    };
    let (Some(registry), Some(themes)) = (registry(), themes()) else {
        return refused("malformed", "registry");
    };
    // Each family names one a bundled theme names, so an honest list is no
    // longer than the theme table; it is searched once per theme a canvas draws.
    if request.font_families.len() > themes.len() {
        return refused("input-too-large", "font-families");
    }
    lay_out(&request, measure.as_ref(), registry, themes)
}

#[cfg(test)]
mod tests;
