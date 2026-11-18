//! A markdown body in one call (ADR-0054 step 7): a note laid out as
//! `layoutMdastBlocks` lays it out on every surface, and a comment's prose as
//! `layoutCommentBody` does, through the same entry, caps and answer as a
//! canvas.
//!
//! A note's request carries what the surface hands the TypeScript as data:
//! the theme mode and style an embedded board is drawn in, the families the
//! surface holds, the tag library, the references (absent, no embed resolves
//! and a paragraph that is only an embed is set as prose), the fragment table,
//! the fences' tokens, the `#Heading` whose section alone is drawn, and the
//! surface whose content cache an embedded board's bodies read. Its answer is
//! the canvas's `["ok", scene, [], degradations, asked?]`, the anchors always
//! empty; a section the note does not hold answers `["missing", "section"]`.
//! A body past the parser's bounds draws its literal text as one paragraph
//! (owner decision q81, D7a), and a request past its caps is refused.

use whiteboard_canvas_render::comments::CommentOptions;
use whiteboard_canvas_render::comments::body::literal_root;
use whiteboard_canvas_render::compose_canvas::{LaidOut, LayoutOptions};
use whiteboard_canvas_render::compose_node::{BodySeams, ComposeHost, ContentCache};
use whiteboard_canvas_render::markdown_document::{layout_comment_text, layout_markdown_document};
use whiteboard_canvas_render::measure::Measure;
use whiteboard_canvas_render::references::{Expansion, ReferenceWire, WireHost};
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_canvas_render::typeset::{
    DiagramRenderer, EmbedResolver, MathRenderer, select_markdown_section,
};
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::mdast::Root;
use whiteboard_plugin_visual::render::StencilBadge;
use whiteboard_scene::NodeDecoration;

use super::answer::{laid_out, missing, refused};
use super::cache::Surface;
use super::fragments::FragmentTable;
use super::host_measure::Host;
use super::request::{MarkdownRequest, Note, Prose};
use super::{
    MAX_BODY_BYTES, MAX_FRAGMENTS, MAX_REFERENCED_ELEMENTS, held_families, measured, outcome,
    plugin, referenced_bytes, referenced_elements, render_style,
};

/// The body a request lays out; see the module's documentation for the wire.
pub(super) fn layout_markdown(request: &MarkdownRequest, host: Option<&dyn Host>) -> String {
    match &request.prose {
        Prose::Note(note) => layout_note(request, note, host),
        Prose::Comment(density) => {
            if request.body.len() > MAX_BODY_BYTES {
                return refused("input-too-large", "bodies");
            }
            let empty = ReferenceWire::default();
            measured(&request.measure, host, None, |measure, _| {
                // The plain parser and no reference: a comment resolves no link.
                let seams = WireHost::new(&empty, Expansion::Every(false));
                let root = seams
                    .parse_markdown(&request.body)
                    .unwrap_or_else(|_| literal_root(&request.body));
                let scene =
                    layout_comment_text(&root, request.max_width, *density, measure, &seams);
                laid_out(&LaidOut { scene, anchors: Vec::new() }, &[], None, None)
            })
        }
    }
}

/// The content a note carries past its caps, if any.
fn past_note_caps(request: &MarkdownRequest, note: &Note) -> Option<&'static str> {
    let wire = note.references.as_ref();
    if wire.map_or(0, referenced_elements) > MAX_REFERENCED_ELEMENTS {
        return Some("referenced-elements");
    }
    if note.fragments.as_ref().is_some_and(|table| table.len() > MAX_FRAGMENTS) {
        return Some("fragments");
    }
    let bodies = request.body.len().saturating_add(wire.map_or(0, referenced_bytes));
    (bodies > MAX_BODY_BYTES).then_some("bodies")
}

fn layout_note(request: &MarkdownRequest, note: &Note, host: Option<&dyn Host>) -> String {
    if let Some(what) = past_note_caps(request, note) {
        return refused("input-too-large", what);
    }
    let plugin = match plugin(&note.font_families) {
        Ok(plugin) => plugin,
        Err(refusal) => return refusal,
    };
    let surface = note.cache.map(|id| Surface::new(id, &request.measure, note.dark, None));
    measured(&request.measure, host, surface, |measure, surface| {
        lay_out_note(request, note, plugin, measure, surface)
    })
}

/// The root the note draws: its whole body, or the section its heading names.
fn root_of(body: &str, note: &Note, host: &WireHost<'_>) -> Result<Root, String> {
    let whole = host.parse_body(body).unwrap_or_else(|_| literal_root(body));
    match &note.section {
        None => Ok(whole),
        Some(heading) => select_markdown_section(&whole, heading).ok_or_else(|| missing("section")),
    }
}

fn lay_out_note(
    request: &MarkdownRequest,
    note: &Note,
    (registry, themes): (&Registry, &[(String, ThemeTokens)]),
    measure: &dyn Measure,
    surface: Option<&Surface>,
) -> String {
    let empty = ReferenceWire::default();
    let host = WireHost::new(note.references.as_ref().unwrap_or(&empty), Expansion::Every(false))
        .with_code_tokens(&note.code_tokens);
    let root = match root_of(&request.body, note, &host) {
        Ok(root) => root,
        Err(answer) => return answer,
    };
    let mode = if note.dark { SpatialThemeMode::Dark } else { SpatialThemeMode::Light };
    let appearance = create_spatial_theme(mode, None);
    let held = held_families(&note.font_families, measure);
    let fragments = note.fragments.as_deref().map(FragmentTable::new);
    let decorations: [&dyn NodeDecoration; 1] = [&StencilBadge { registry }];
    let options = LayoutOptions {
        measure,
        appearance: &appearance,
        geometry: None,
        style: render_style(&note.style),
        themes,
        font_available: Some(&held),
        registry,
        decorations: &decorations,
        tag_library: note.tags.as_ref(),
        suppressed: &[],
        locked: &[],
        side_overrides: None,
        host: &host,
        comments: CommentOptions::default(),
        proposals: &[],
        content_cache: surface.map(|surface| surface as &dyn ContentCache),
        fragment_table_reads: fragments.as_ref().map(FragmentTable::reads),
        body: BodySeams {
            inline: &host,
            highlight: Some(&host),
            math: fragments.as_ref().map(|table| table as &dyn MathRenderer),
            diagram: fragments.as_ref().map(|table| table as &dyn DiagramRenderer),
            embeds: note.references.is_some().then_some(&host as &dyn EmbedResolver),
        },
        budget: None,
        embed_path: &[],
    };
    let scene = layout_markdown_document(&root, request.max_width, &options);
    outcome(&LaidOut { scene, anchors: Vec::new() }, &host, fragments.as_ref(), note.svg.as_ref())
}
