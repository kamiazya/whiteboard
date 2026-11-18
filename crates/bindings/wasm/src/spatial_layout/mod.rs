//! `layoutSpatialCanvasWithAnchors` in one call (ADR-0054 step 7): a whole
//! canvas laid out by the composer, with the documents it points at, the
//! measurer and the caller's options handed over as DATA, so nothing crosses
//! back mid-layout but the host's own measurer, when the request names it
//! ([`host_measure`]: the browser's canvas context, which nothing here repeats).
//!
//! In: the request (the value wire of [`crate::json_canvas_wire`], read by
//! [`request`]), whose font-table measurer names faces registered beforehand
//! by [`register_layout_fonts`], and the host's measurer when the request
//! names `{kind: 'host'}`. A request naming `cache: <id>` reads laid-out
//! bodies from that surface's content cache and keeps its own there
//! ([`cache`]); `release_layout_cache(id)` forgets them. Out: one JSON text
//! whose first element names the outcome:
//!
//! - `["ok", scene, anchors, degradations]`: the scene as the TypeScript holds
//!   it ([`whiteboard_canvas_render::scene_wire`]), the anchors as
//!   `[id, pair]` rows in the order the routing settled them, and what the
//!   layout reported instead of failing, as the TypeScript's events; for a
//!   request carrying `fragments` (rendered math blocks and fences by key), a
//!   fifth element: the sources the table did not hold, each drawn as its
//!   fallback, as `FragmentAsk`s once each in the order asked, which the host
//!   renders and lays out again with; and for a request carrying `svg` (the
//!   envelope the picture is drawn in, [`request`]'s `SvgAsk`), a last
//!   element: the scene as `whiteboard-canvas-render`'s backend draws it, the
//!   document's text or, for `form: 'keyed'`, its keyed projection as
//!   `[rootOpen, [[name, value]...], [[key, svg, annotation?]...]]`, so a
//!   picture is one call (refused `input-too-large` / `svg` past
//!   [`MAX_SVG_BYTES`], never cut short);
//! - `["refused", code, class]`: an input past this entry's caps (`code`
//!   `input-too-large`, `class` naming the cap), or one that is not a request;
//!   `["refused", "malformed", "non-finite"]` a layout holding a number the
//!   answer cannot spell, `["refused", "malformed", "host-measure"]` a host
//!   measurer not handed over or one that did not answer, and
//!   `["refused", "malformed", "font-handle"]` a handle this instance holds no
//!   faces under, which the host registers again;
//! - `["needs", {code}]`: the fences, as `[lang, value]` rows in the order the
//!   layout met them, that the default highlighter colours and whose tokens the
//!   request's `codeTokens` did not carry; the host tokenises exactly those and
//!   asks once more with them (owner decision q75).
//!
//! A host draws a refusal as one (owner decision q81, D7). A body past the
//! parser's bounds is no refusal (D7a): a node's own body draws its literal
//! text and reports `body-parse-failed`, a note or a comment draws its literal
//! text as one paragraph. Nor is fragment markup placed past
//! [`MAX_PLACED_BYTES`]: each block past it draws its fallback.
//!
//! A request naming a `kind` is a markdown body rather than a canvas
//! ([`markdown`]): a note laid out as `layoutMdastBlocks` lays it out, or a
//! comment's prose as `layoutCommentBody` does, on the same caps, measurers
//! and answers, its anchors always none; a note's `#Heading` that names
//! nothing answers `["missing", "section"]`.

mod answer;
mod cache;
mod fonts;
mod fragments;
mod host_measure;
mod markdown;
mod measure;
mod query;
mod request;
mod svg;

pub use cache::{MAX_CACHED_BODIES, MAX_CACHED_BYTES, release_layout_cache};
pub use fonts::{
    MAX_FACES, MAX_HANDLES, MAX_HELD_BYTES, register_layout_fonts, release_layout_fonts,
};
pub use fragments::{MAX_FRAGMENTS, MAX_PLACED_BYTES};
pub use host_measure::{Host, HostMeasurer, font_key};
pub use query::{MAX_RUNS, layout_query, query_with_host};
pub use svg::MAX_SVG_BYTES;

use std::sync::OnceLock;

use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_canvas_render::compose_canvas::{self, LaidOut, LayoutOptions, RenderStyle};
use whiteboard_canvas_render::compose_node::{BodySeams, ContentCache};
use whiteboard_canvas_render::measure::Measure;
use whiteboard_canvas_render::references::{Expansion, ReferenceWire, WireHost};
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_canvas_render::theme::tokens::theme_table;
use whiteboard_canvas_render::typeset::{DiagramRenderer, MathRenderer};
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::annotation::{AnnotationAnchor, CommentThread};
use whiteboard_model::proposal::{ChangeOp, Proposal, ProposedChange, SpatialChange};
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_model::{Map, Value};
use whiteboard_plugin_visual::host::{THEMES, visual_registry};
use whiteboard_plugin_visual::render::StencilBadge;
use whiteboard_scene::NodeDecoration;

use crate::input_caps::LAYOUT_SPATIAL_CANVAS;
use crate::json_canvas_wire::json_value;
use answer::{laid_out, needs, refused};
use cache::Surface;
use fragments::FragmentTable;
use measure::{Unmeasured, with_measurer};
use request::{Asked, Comments, MeasureSpec, Request, Style, SvgAsk, asked_of};

/// The most canvas elements (nodes, edges and lines) a request's own canvas
/// may hold: this entry's `maxNodes`, which bounds the routing a layout runs
/// as `maxBytes` cannot, and is above the model's 2,000 nodes and 2,000 edges
/// and lines.
pub const MAX_ELEMENTS: usize = match LAYOUT_SPATIAL_CANVAS.max_nodes {
    Some(n) => n,
    None => 0,
};

/// The most elements every canvas the request references may hold together:
/// as many again, at least the 4,000 the keepers' reference walk loads. Each
/// canvas is routed on its own, so the two caps add rather than multiply.
pub const MAX_REFERENCED_ELEMENTS: usize = MAX_ELEMENTS;

/// The most text a request's bodies may hold together, in bytes: every node's
/// content and every referenced body. 3 MiB is the keepers' reference budget
/// (`4 × MARKDOWN_MAX_CHARS` UTF-16 units, at most three bytes each) with room
/// for a board's own content. One parse stays bounded by the parser's own
/// 768 KiB, so this bounds how many parses run; the cost of a body is in its
/// parse and its typesetting, which `maxBytes` alone would let a request repeat.
pub const MAX_BODY_BYTES: usize = 3 * 1024 * 1024;

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
    let own =
        content_bytes(&request.canvas).saturating_add(opening_bytes(&request.comments.threads));
    own.saturating_add(referenced_bytes(&request.references))
}

/// The bytes of every body a reference wire carries, a referenced canvas's
/// nodes' included.
fn referenced_bytes(wire: &ReferenceWire) -> usize {
    let referenced = wire.entries.iter().filter_map(|(_, entry)| entry.as_ref());
    referenced.fold(0, |sum, entry| {
        let body = entry.body.as_ref().map_or(0, String::len);
        let canvas = entry.canvas.as_ref().map_or(0, content_bytes);
        sum.saturating_add(body).saturating_add(canvas)
    })
}

fn elements(canvas: &SpatialCanvas) -> usize {
    let lines = canvas.lines.as_ref().map_or(0, Vec::len);
    canvas.nodes.len().saturating_add(canvas.edges.len()).saturating_add(lines)
}

/// The elements of every canvas a reference wire carries.
fn referenced_elements(wire: &ReferenceWire) -> usize {
    let referenced = wire.entries.iter().filter_map(|(_, entry)| {
        let canvas = entry.as_ref()?.canvas.as_ref()?;
        Some(elements(canvas))
    });
    referenced.fold(0, usize::saturating_add)
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

/// The most changes a proposal layer may hold across its proposals: the
/// element cap. Each is looked up against every element and its outline
/// joins what every later bubble is placed against, so what the layer costs
/// grows with their product, which bytes do not bound.
pub const MAX_PROPOSAL_CHANGES: usize = MAX_ELEMENTS;

/// The most proposals a layer may hold: half the element cap. Each draws a
/// bubble placed against every box, outline and earlier bubble, which is
/// where the layer's cost is: 4096 proposals over a hub of 2047 edges took
/// 31.4 s on Node wasm, 2048 took 24.7 s and the hub alone 16.5 s, while one
/// proposal adding 4096 boxes took 0.2 s.
pub const MAX_PROPOSALS: usize = MAX_ELEMENTS / 2;

/// The most mapping entries the facets of the priors may hold, at every depth
/// together: the element cap. A prior's facets agree with the element's in
/// any key order, so each key is searched for through its mapping and the
/// comparison costs the square of the entries, which bytes bound only loosely.
pub const MAX_PRIOR_FACET_ENTRIES: usize = MAX_ELEMENTS;

fn map_entries(map: &Map) -> usize {
    map.iter().fold(map.len(), |sum, (_, item)| sum.saturating_add(entries(item)))
}

fn entries(value: &Value) -> usize {
    match value {
        Value::Map(map) => map_entries(map),
        Value::Seq(items) => items.iter().map(entries).fold(0, usize::saturating_add),
        _ => 0,
    }
}

/// The facets a change's prior holds, which it is compared to the element by.
fn prior_facets(change: &ProposedChange) -> Option<&Map> {
    let ChangeOp::Spatial(spatial) = &change.op else { return None };
    match spatial.as_ref() {
        SpatialChange::NodeRemove { assumed, .. } => assumed.facets.as_ref(),
        SpatialChange::EdgeRemove { assumed, .. } => assumed.facets.as_ref(),
        SpatialChange::LineRemove { assumed, .. } => assumed.facets.as_ref(),
        SpatialChange::EdgePatch { assumed, .. } => assumed.facets.as_ref(),
        SpatialChange::LinePatch { assumed, .. } => assumed.facets.as_ref(),
        _ => None,
    }
}

/// The most bubbles the two layers may place together: the element cap.
/// Each bubble is placed against every earlier one of either layer, so a
/// layer at its own cap beside the other at its own costs more than either:
/// over a hub of 2047 edges, 4096 threads with 2048 proposals took 45.6 s on
/// Node wasm, the comment layer's own caps 40.2 s, and 2048 of each 31.8 s.
pub const MAX_BUBBLES: usize = MAX_ELEMENTS;

/// Whether `proposals`, beside a comment layer of `threads`, is past a cap.
fn past_proposal_caps(proposals: &[Proposal], threads: usize) -> bool {
    let changes = proposals.iter().flat_map(|proposal| &proposal.changes);
    let facets = changes.clone().filter_map(prior_facets).map(map_entries);
    proposals.len() > MAX_PROPOSALS
        || proposals.len().saturating_add(threads) > MAX_BUBBLES
        || changes.count() > MAX_PROPOSAL_CHANGES
        || facets.fold(0, usize::saturating_add) > MAX_PRIOR_FACET_ENTRIES
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

/// Whether a family may be declared: the surface holds a face for it, and the
/// measurer measures it in that face (the declared family must be the measured one).
fn held_families<'a>(
    families: &'a [String],
    measure: &'a dyn Measure,
) -> impl Fn(&str) -> bool + 'a {
    move |family| families.iter().any(|held| held == family) && measure.has_family(family)
}

/// The request laid out, as the answer's JSON text.
fn lay_out(
    request: &Request,
    measure: &dyn Measure,
    surface: Option<&Surface>,
    plugin: Plugin,
) -> String {
    with_options(request, measure, surface, plugin, &mut |options, host, fragments| {
        let laid = compose_canvas::layout_spatial_canvas(&request.canvas, options);
        outcome(&laid, host, fragments, request.svg.as_ref())
    })
}

/// `then` over the composer's options as `request` names them, with the host
/// its bodies resolve through and the fragment table it carries.
fn with_options(
    request: &Request,
    measure: &dyn Measure,
    surface: Option<&Surface>,
    (registry, themes): Plugin,
    then: &mut dyn FnMut(&LayoutOptions<'_>, &WireHost<'_>, Option<&FragmentTable<'_>>) -> String,
) -> String {
    let mode = if request.dark { SpatialThemeMode::Dark } else { SpatialThemeMode::Light };
    let held = held_families(&request.font_families, measure);
    let appearance = create_spatial_theme(mode, None);
    let host = WireHost::new(&request.references, request.expand.clone())
        .with_code_tokens(&request.code_tokens);
    let fragments = request.fragments.as_deref().map(FragmentTable::new);
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
        proposals: &request.proposals,
        content_cache: surface.map(|surface| surface as &dyn ContentCache),
        fragment_table_reads: fragments.as_ref().map(FragmentTable::reads),
        body: BodySeams {
            inline: &host,
            highlight: Some(&host),
            math: fragments.as_ref().map(|table| table as &dyn MathRenderer),
            diagram: fragments.as_ref().map(|table| table as &dyn DiagramRenderer),
            embeds: Some(&host),
        },
        budget: None,
        embed_path: &request.embed_path,
    };
    then(&options, &host, fragments.as_ref())
}

/// What a layout through `host` and `fragments` answers, its SVG drawn when `svg` asks for one.
fn outcome(
    laid: &LaidOut,
    host: &WireHost<'_>,
    fragments: Option<&FragmentTable<'_>>,
    svg: Option<&SvgAsk>,
) -> String {
    let ok = || laid_out(laid, &host.degradations(), fragments.map(FragmentTable::asked), svg);
    settled(host, ok)
}

/// What a layout through `host` answers when `ok` is its laid-out answer: the
/// fences it must be sent first, if any.
fn settled(host: &WireHost<'_>, ok: impl FnOnce() -> String) -> String {
    let asked = host.needs();
    if asked.is_empty() { ok() } else { needs(&asked) }
}

/// Whether a layout's bodies may be kept: one answered, or one asking for
/// fences, whose bodies each drew in full or charged the refusal a missing
/// fence charges, which the composer never keeps; so the call that sends the
/// tokens reads the rest. A refused layout keeps nothing. (A body past the
/// parser's bounds is never kept either: the composer keeps only a body that
/// parsed.)
fn keeps(answer: &str) -> bool {
    answer.starts_with(r#"["ok","#) || answer.starts_with(r#"["needs","#)
}

/// A whole canvas laid out; see the module's documentation for the wire.
/// `host` measures a request that names `{kind: 'host'}`.
#[wasm_bindgen]
#[must_use]
#[expect(
    clippy::needless_pass_by_value,
    reason = "wasm-bindgen hands an imported object over by value"
)]
pub fn layout_spatial_canvas(request: &str, host: Option<HostMeasurer>) -> String {
    layout_with_host(request, host.as_ref().map(|host| host as &dyn Host))
}

/// The content a request carries past its caps (comments, proposals, bodies), if any.
fn past_content_caps(request: &Request) -> Option<&'static str> {
    if past_comment_caps(&request.comments) {
        return Some("comments");
    }
    if past_proposal_caps(&request.proposals, request.comments.threads.len()) {
        return Some("proposals");
    }
    (body_total(request) > MAX_BODY_BYTES).then_some("bodies")
}

/// [`layout_spatial_canvas`] over any [`Host`]: a native caller's stand-in,
/// since the import answers only inside a wasm host.
#[must_use]
pub fn layout_with_host(request: &str, host: Option<&dyn Host>) -> String {
    if request.len() > LAYOUT_SPATIAL_CANVAS.max_bytes {
        return refused("input-too-large", "too-large");
    }
    let Some(request) = serde_json::from_str(request).ok().as_ref().and_then(json_value) else {
        return refused("malformed", "wire");
    };
    match asked_of(&request) {
        Some(Asked::Canvas(request)) => layout_canvas(&request, host),
        Some(Asked::Markdown(request)) => markdown::layout_markdown(&request, host),
        None => refused("malformed", "request"),
    }
}

/// The bundled plugin's registry and its themes by namespaced id.
type Plugin = (&'static Registry, &'static [(String, ThemeTokens)]);

/// The bundled plugin and its themes, or why the request is refused: a family
/// a theme may name is searched once per theme a canvas draws, so an honest
/// list is no longer than the theme table.
fn plugin(font_families: &[String]) -> Result<Plugin, String> {
    let (Some(registry), Some(themes)) = (registry(), themes()) else {
        return Err(refused("malformed", "registry"));
    };
    if font_families.len() > themes.len() {
        return Err(refused("input-too-large", "font-families"));
    }
    Ok((registry, themes))
}

/// `lay_out` over the measurer `spec` names, keeping the bodies `surface`
/// wrote when the answer may keep them.
fn measured(
    spec: &MeasureSpec,
    host: Option<&dyn Host>,
    surface: Option<Surface>,
    lay_out: impl FnOnce(&dyn Measure, Option<&Surface>) -> String,
) -> String {
    match with_measurer(spec, host, |measure| lay_out(measure, surface.as_ref())) {
        Ok(answer) => {
            // Measured throughout, since a host that failed answers `Err`.
            if keeps(&answer)
                && let Some(surface) = surface
            {
                surface.keep();
            }
            answer
        }
        Err(Unmeasured::FontHandle) => refused("malformed", "font-handle"),
        Err(Unmeasured::Host) => refused("malformed", "host-measure"),
    }
}

/// What of a canvas request is past this entry's caps, if anything.
fn past_canvas_caps(request: &Request) -> Option<&'static str> {
    if elements(&request.canvas) > MAX_ELEMENTS || expanded_ids(request) > MAX_ELEMENTS {
        return Some("too-many-elements");
    }
    if referenced_elements(&request.references) > MAX_REFERENCED_ELEMENTS {
        return Some("referenced-elements");
    }
    if request.fragments.as_ref().is_some_and(|table| table.len() > MAX_FRAGMENTS) {
        return Some("fragments");
    }
    past_content_caps(request)
}

/// A canvas request laid out, or refused past its caps.
fn layout_canvas(request: &Request, host: Option<&dyn Host>) -> String {
    if let Some(what) = past_canvas_caps(request) {
        return refused("input-too-large", what);
    }
    let plugin = match plugin(&request.font_families) {
        Ok(plugin) => plugin,
        Err(refusal) => return refusal,
    };
    let surface = request
        .cache
        .map(|id| Surface::new(id, &request.measure, request.dark, request.geometry.as_ref()));
    measured(&request.measure, host, surface, |measure, surface| {
        lay_out(request, measure, surface, plugin)
    })
}

#[cfg(test)]
mod host_tests;
#[cfg(test)]
mod markdown_tests;
#[cfg(test)]
mod proposal_tests;
#[cfg(test)]
mod query_tests;
#[cfg(test)]
mod svg_form_tests;
#[cfg(test)]
mod svg_tests;
#[cfg(test)]
mod tests;
