//! What a replay of `compose-canvas.jsonl` answers in the composer's place: the
//! meta line read into the crate's types, and a host that parses each body as
//! recorded, draws the recorded overlays over the top-level canvas, and notes
//! every degradation and every question the recording cannot answer.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::compose_canvas::{Overlaid, Overlays};
use whiteboard_canvas_render::compose_node::{
    ComposeHost, ComposeOptions, ContentCache, Degradation, ParseFailed,
};
use whiteboard_canvas_render::node_box::ResolvedReference;
use whiteboard_canvas_render::theme::appearance::{
    RoutableElement, SpatialAppearanceResolver, SpatialCommentAppearance, SpatialNodeAppearance,
    SpatialProposalAppearance,
};
use whiteboard_canvas_render::theme::palette::SpatialSyntaxPalette;
use whiteboard_canvas_render::typeset::{
    CanvasSummary, EmbedResolver, Embedded, FittedBlocks, IconRange, ImageRef, InlineSeams,
};
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::mdast::Root;
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};
use whiteboard_plugin_visual::host::visual_registry;
use whiteboard_plugin_visual::visual::{TagKeyDeclaration, TagLibrary, TagValueDeclaration};
use whiteboard_scene::{Appearance, SceneLegend, SceneNode};

use crate::canvas_wire::{ElementWire, NodeWire, Res, canvas_parts, differ};
use crate::{degrade_support, model, tokens};

/// A degradation as recorded.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Event {
    kind: String,
    node_id: String,
    detail: String,
}

/// What the overlays drew over the top-level canvas: everything after its first
/// `from` nodes.
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct OverlayWire {
    pub(crate) from: usize,
    pub(crate) nodes: Vec<SceneNode>,
}

/// A recorded canvas: the board's facets and tags, its nodes, edges and lines.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CanvasWire {
    facets: Option<Value>,
    tags: Option<Vec<String>>,
    nodes: Vec<NodeWire>,
    edges: Vec<ElementWire>,
    lines: Option<Vec<ElementWire>>,
}

pub(crate) fn canvas_of(wire: &CanvasWire) -> Res<SpatialCanvas> {
    let mut canvas =
        canvas_parts(wire.facets.as_ref(), &wire.nodes, &wire.edges, wire.lines.as_deref())?;
    canvas.tags.clone_from(&wire.tags);
    Ok(canvas)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmbedWire {
    title: String,
    canvas: CanvasWire,
}

/// The meta line, read into the crate's types.
pub(crate) struct Context {
    pub(crate) registry: Registry,
    pub(crate) themes: Vec<(String, ThemeTokens)>,
    pub(crate) library: TagLibrary,
    bodies: BTreeMap<String, Root>,
    /// A comment's markdown as parsed alone; `None` is a body that throws.
    markdown: BTreeMap<String, Option<Root>>,
    references: BTreeMap<String, SpatialCanvas>,
    embeds: BTreeMap<String, (String, SpatialCanvas)>,
}

fn text_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn entries(value: Option<&Value>) -> Vec<(&String, &Value)> {
    value.and_then(Value::as_object).map(|o| o.iter().collect()).unwrap_or_default()
}

fn library_of(value: &Value) -> TagLibrary {
    entries(Some(value))
        .into_iter()
        .map(|(key, declaration)| {
            let values = declaration.get("values").map(|values| {
                entries(Some(values))
                    .into_iter()
                    .map(|(name, value)| {
                        let color = text_of(value, "color");
                        let description = text_of(value, "description");
                        (name.clone(), TagValueDeclaration { color, description })
                    })
                    .collect()
            });
            (key.clone(), TagKeyDeclaration { values, ..TagKeyDeclaration::default() })
        })
        .collect()
}

impl Context {
    pub(crate) fn of(meta: &Value) -> Res<Self> {
        let at = |key: &str| meta.get(key).ok_or(format!("the meta line's {key}"));
        let mut themes = Vec::new();
        for pair in at("themes")?.as_array().ok_or("themes")? {
            let id = pair.get(0).and_then(Value::as_str).ok_or("a theme id")?;
            themes.push((id.to_owned(), tokens::theme_tokens(pair.get(1).ok_or("tokens")?)?));
        }
        let mut bodies = BTreeMap::new();
        for (text, root) in entries(Some(at("bodies")?)) {
            bodies.insert(text.clone(), model::root(root)?);
        }
        let mut markdown = BTreeMap::new();
        for (text, root) in entries(meta.get("markdown")) {
            let root = if root.is_null() { None } else { Some(model::root(root)?) };
            markdown.insert(text.clone(), root);
        }
        let parse = |e: serde_json::Error| e.to_string();
        let references: BTreeMap<String, CanvasWire> =
            serde_json::from_value(at("references")?.clone()).map_err(parse)?;
        let embeds: BTreeMap<String, EmbedWire> =
            serde_json::from_value(at("embeds")?.clone()).map_err(parse)?;
        Ok(Self {
            registry: visual_registry().map_err(|e| format!("{e:?}"))?,
            themes,
            library: library_of(at("library")?),
            bodies,
            markdown,
            references: references
                .iter()
                .map(|(reference, wire)| Ok((reference.clone(), canvas_of(wire)?)))
                .collect::<Res<_>>()?,
            embeds: embeds
                .iter()
                .map(|(id, wire)| Ok((id.clone(), (wire.title.clone(), canvas_of(&wire.canvas)?))))
                .collect::<Res<_>>()?,
        })
    }
}

/// A content cache that keeps what it is handed and notes every key it is asked.
#[derive(Default)]
pub(crate) struct KeyCache {
    asked: RefCell<Vec<String>>,
    entries: RefCell<BTreeMap<String, FittedBlocks>>,
}

impl KeyCache {
    pub(crate) fn asked(&self) -> Vec<String> {
        self.asked.borrow().clone()
    }
}

impl ContentCache for KeyCache {
    fn get(&self, key: &str) -> Option<FittedBlocks> {
        self.asked.borrow_mut().push(key.to_owned());
        self.entries.borrow().get(key).cloned()
    }

    fn set(&self, key: &str, body: &FittedBlocks) {
        self.entries.borrow_mut().insert(key.to_owned(), body.clone());
    }
}

/// What one run noted.
pub(crate) struct Recorded {
    events: Vec<Event>,
    misses: Vec<String>,
    calls: usize,
}

impl Recorded {
    pub(crate) fn check(&self, events: &[Event], calls: usize) -> Res<()> {
        differ("events", &self.events.as_slice(), &events)?;
        differ("measurer calls", &self.calls, &calls)?;
        differ("host misses", &self.misses, &Vec::new())
    }
}

/// The host of one run.
pub(crate) struct Host<'c> {
    context: &'c Context,
    overlay: OverlayWire,
    legend: Option<SceneLegend>,
    overlaid: Cell<usize>,
    events: RefCell<Vec<Event>>,
    misses: RefCell<Vec<String>>,
}

impl<'c> Host<'c> {
    pub(crate) fn new(
        context: &'c Context,
        overlay: &OverlayWire,
        legend: Option<&SceneLegend>,
    ) -> Self {
        Self {
            context,
            overlay: overlay.clone(),
            legend: legend.cloned(),
            overlaid: Cell::new(0),
            events: RefCell::new(Vec::new()),
            misses: RefCell::new(Vec::new()),
        }
    }

    fn miss(&self, what: String) {
        self.misses.borrow_mut().push(what);
    }

    pub(crate) fn recorded(&self, calls: usize) -> Recorded {
        Recorded { events: self.events.take(), misses: self.misses.take(), calls }
    }
}

impl ComposeHost for Host<'_> {
    fn parse_body(&self, text: &str) -> Result<Root, ParseFailed> {
        self.context.bodies.get(text).cloned().ok_or_else(|| {
            self.miss(format!("a body {text:?}"));
            ParseFailed
        })
    }

    fn resolve_reference(&self, reference: &str) -> Option<ResolvedReference> {
        let canvas = self.context.references.get(reference)?.clone();
        Some(ResolvedReference { canvas: Some(canvas), ..ResolvedReference::default() })
    }

    fn expand_file_node(&self, _: &SpatialNode) -> bool {
        true
    }

    fn embedded_canvas(&self, document_id: &str, fragment: Option<&str>) -> Option<SpatialCanvas> {
        if fragment.is_some() {
            self.miss(format!("a fragment of {document_id}"));
        }
        self.context.embeds.get(document_id).map(|(_, canvas)| canvas.clone())
    }

    fn parse_markdown(&self, text: &str) -> Result<Root, ParseFailed> {
        match self.context.markdown.get(text) {
            Some(Some(root)) => Ok(root.clone()),
            Some(None) => Err(ParseFailed),
            None => {
                self.miss(format!("a comment's markdown {text:?}"));
                Err(ParseFailed)
            }
        }
    }

    fn degrade(&self, event: Degradation) {
        let (kind, node_id, detail) = degrade_support::event_of(event);
        self.events.borrow_mut().push(Event { kind: kind.to_owned(), node_id, detail });
    }
}

/// The corpus's bodies hold no shortcode, which is a name between two colons.
fn may_hold_shortcode(text: &str) -> bool {
    text.matches(':').nth(1).is_some()
}

impl InlineSeams for Host<'_> {
    fn expand_emoji(&self, text: &str) -> String {
        if may_hold_shortcode(text) {
            self.miss(format!("emoji in {text:?}"));
        }
        text.to_owned()
    }

    fn icon_ranges(&self, text: &str) -> Vec<IconRange> {
        if may_hold_shortcode(text) {
            self.miss(format!("icons in {text:?}"));
        }
        Vec::new()
    }

    fn document_title(&self, _: &str) -> Option<String> {
        None
    }

    fn embed_name(&self, document_id: &str) -> Option<String> {
        self.context.embeds.get(document_id).map(|(title, _)| title.clone())
    }

    fn embed_pending(&self, _: &str) -> bool {
        false
    }

    fn image_reference(&self, _: &str) -> Option<ImageRef> {
        None
    }
}

impl EmbedResolver for Host<'_> {
    fn resolve_embed(&self, document_id: &str, _: Option<&str>) -> Option<Embedded> {
        let (title, canvas) = self.context.embeds.get(document_id)?;
        let elements =
            canvas.nodes.len() + canvas.edges.len() + canvas.lines.as_ref().map_or(0, Vec::len);
        let canvas = Some(CanvasSummary { elements, empty: elements == 0 });
        Some(Embedded::Canvas { title: Some(title.clone()), canvas })
    }
}

impl Overlays for Host<'_> {
    /// The recorded overlays, once: the corpus lays out no nested canvas.
    fn overlay(&self, _: &SpatialCanvas, drawn: &[SceneNode], _: &ComposeOptions<'_>) -> Overlaid {
        self.overlaid.set(self.overlaid.get() + 1);
        if self.overlaid.get() > 1 {
            self.miss("a second overlay".to_owned());
        }
        if drawn.len() != self.overlay.from {
            self.miss(format!(
                "overlays over {} drawn, recorded {}",
                drawn.len(),
                self.overlay.from
            ));
        }
        Overlaid { nodes: self.overlay.nodes.clone(), legend: self.legend.clone() }
    }
}

/// A resolver that paints as the one it wraps and stamps no mode.
pub(crate) struct Unmoded<R>(pub(crate) R);

impl<R: SpatialAppearanceResolver> SpatialAppearanceResolver for Unmoded<R> {
    fn resolve_node(&self, node: &SpatialNode) -> SpatialNodeAppearance {
        self.0.resolve_node(node)
    }

    fn resolve_edge(&self, edge: RoutableElement<'_>) -> Option<Appearance> {
        self.0.resolve_edge(edge)
    }

    fn resolve_label(&self) -> Appearance {
        self.0.resolve_label()
    }

    fn resolve_syntax(&self) -> Option<SpatialSyntaxPalette> {
        self.0.resolve_syntax()
    }

    fn resolve_comment(&self) -> Option<SpatialCommentAppearance> {
        self.0.resolve_comment()
    }

    fn resolve_proposal(&self) -> Option<SpatialProposalAppearance> {
        self.0.resolve_proposal()
    }
}
