//! `compose_node` against the recorded TypeScript answers (`compose-node.jsonl`):
//! for each node and the options a composer hands it, the scene drawn, the
//! degradations reported, the content-cache keys asked and kept, the scene drawn
//! again over the same cache and over one seeded under the first key asked, and
//! how many times the measurer was asked. What the composer asks its host (a
//! body parsed, a reference resolved, an embed target, a file node's canvas
//! embed) is answered from the recording.

#[path = "typeset_support/dump.rs"]
mod dump;
#[path = "typeset_support/model.rs"]
mod model;
#[path = "theme_support/tokens.rs"]
mod tokens;

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use dump::dump_scene;
use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::compose_node::{
    BodySeams, ComposeHost, ComposeOptions, ContentCache, Degradation, ParseFailed, compose_node,
};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::{FontDescriptor, Measure, VerticalMetrics};
use whiteboard_canvas_render::node_box::{
    FacetCard, FacetRow, NodeBoxHost, NodeBoxOptions, ReferenceImage, ResolvedReference,
    TextPlacement,
};
use whiteboard_canvas_render::theme::appearance::SpatialAppearanceResolver;
use whiteboard_canvas_render::theme::asset::create_themed_appearance;
use whiteboard_canvas_render::theme::geometry::SpatialGeometry;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_canvas_render::typeset::{
    EmbedResolver, Embedded, FittedBlocks, IconRange, ImageRef, InlineSeams, NestedLayoutBudget,
};
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_model::mdast::Root;
use whiteboard_model::spatial::{
    BackgroundStyle, CanvasColor, CanvasColorPreset, NodeResource, SpatialNode,
};
use whiteboard_scene::{Scene, SceneNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

type Res<T> = Result<T, String>;

fn f64_of(hex: &str) -> Res<f64> {
    u64::from_str_radix(hex, 16).map(f64::from_bits).map_err(|e| format!("{hex}: {e}"))
}

/// A recorded digest: the text's UTF-16 length and its FNV-1a.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct Digest {
    n: usize,
    h: u32,
}

fn digest(text: &str) -> Digest {
    let h = text
        .encode_utf16()
        .fold(0x811c_9dc5_u32, |state, unit| (state ^ u32::from(unit)).wrapping_mul(16_777_619));
    Digest { n: text.encode_utf16().count(), h }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ResourceWire {
    mime_type: String,
    content: Option<String>,
    location: Option<String>,
    subpath: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NodeWire {
    id: String,
    #[serde(rename = "box")]
    bbox: [String; 4],
    color: Option<String>,
    resource: Option<ResourceWire>,
    label: Option<String>,
    background: Option<String>,
    background_style: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Event {
    kind: String,
    node_id: String,
    detail: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    scene: String,
    events: Vec<Event>,
    asked: Vec<String>,
    kept: Vec<String>,
    again: Digest,
    seeded: Option<Digest>,
    calls: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Case {
    id: String,
    node: NodeWire,
    theme: String,
    fit_to_box: bool,
    align: Option<String>,
    shape: Option<String>,
    geometry: [String; 3],
    embed_depth: usize,
    /// The switches that are on: `locked`, `suppressed`, `emptyFrame`, `cache`, `spent`.
    flags: Vec<String>,
    embed: Option<SceneNode>,
    answer: Answer,
}

impl Case {
    fn on(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f == flag)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageWire {
    href: String,
    alt: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RowWire {
    label: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CardWire {
    title: Option<String>,
    rows: Vec<RowWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolvedWire {
    label: Option<String>,
    missing: Option<bool>,
    image: Option<ImageWire>,
    /// Only the host's embed answer reads the canvas, and it is recorded.
    #[serde(rename = "canvas")]
    _canvas: Option<Value>,
    markdown: Option<Value>,
    facets: Option<CardWire>,
}

fn resolved_of(wire: ResolvedWire) -> Res<ResolvedReference> {
    Ok(ResolvedReference {
        label: wire.label,
        missing: wire.missing.unwrap_or(false),
        image: wire.image.map(|i| ReferenceImage { href: i.href, alt: i.alt }),
        markdown: wire.markdown.as_ref().map(model::root).transpose()?,
        facets: wire.facets.map(|card| FacetCard {
            title: card.title,
            rows: card
                .rows
                .into_iter()
                .map(|row| FacetRow { label: row.label, value: row.value })
                .collect(),
        }),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmbeddedWire {
    title: String,
    root: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SeededWire {
    nodes: Vec<SceneNode>,
    truncated: bool,
    overflows: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MetaWire {
    #[serde(rename = "kind")]
    _kind: String,
    sketch: Value,
    bodies: BTreeMap<String, Option<Value>>,
    embedded: BTreeMap<String, EmbeddedWire>,
    references: BTreeMap<String, Option<ResolvedWire>>,
    seeded: SeededWire,
}

/// What the meta line holds, read into the crate's types.
struct Context {
    sketch: ThemeTokens,
    bodies: BTreeMap<String, Option<Root>>,
    embedded: BTreeMap<String, (String, Root)>,
    references: BTreeMap<String, Option<ResolvedReference>>,
    seeded: FittedBlocks,
}

fn context_of(meta: &Value) -> Res<Context> {
    let wire: MetaWire = serde_json::from_value(meta.clone()).map_err(|e| e.to_string())?;
    let mut bodies = BTreeMap::new();
    for (text, root) in wire.bodies {
        bodies.insert(text, root.as_ref().map(model::root).transpose()?);
    }
    let mut embedded = BTreeMap::new();
    for (id, target) in wire.embedded {
        embedded.insert(id, (target.title, model::root(&target.root)?));
    }
    let mut references = BTreeMap::new();
    for (reference, resolved) in wire.references {
        references.insert(reference, resolved.map(resolved_of).transpose()?);
    }
    Ok(Context {
        sketch: tokens::theme_tokens(&wire.sketch)?,
        bodies,
        embedded,
        references,
        seeded: FittedBlocks {
            nodes: wire.seeded.nodes,
            truncated: wire.seeded.truncated,
            overflows: wire.seeded.overflows,
        },
    })
}

/// The fake measurer, counting what it is asked.
struct Counting {
    base: FakeMeasure,
    calls: Cell<usize>,
}

impl Measure for Counting {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        self.calls.set(self.calls.get() + 1);
        self.base.advance_width(text, font)
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        self.base.vertical_metrics(font)
    }
}

/// A content cache that remembers what it was asked and what it kept.
#[derive(Default)]
struct Recording {
    asked: RefCell<Vec<String>>,
    kept: RefCell<Vec<String>>,
    entries: RefCell<BTreeMap<String, FittedBlocks>>,
}

impl ContentCache for Recording {
    fn get(&self, key: &str) -> Option<FittedBlocks> {
        self.asked.borrow_mut().push(key.to_owned());
        self.entries.borrow().get(key).cloned()
    }

    fn set(&self, key: &str, body: &FittedBlocks) {
        self.kept.borrow_mut().push(key.to_owned());
        self.entries.borrow_mut().insert(key.to_owned(), body.clone());
    }
}

/// Every host answer of one case, from the case and the meta line.
struct Host<'c> {
    context: &'c Context,
    case: &'c Case,
    align: Option<TextPlacement>,
    events: RefCell<Vec<Event>>,
    misses: RefCell<Vec<String>>,
}

impl Host<'_> {
    fn miss(&self, what: String) {
        self.misses.borrow_mut().push(what);
    }
}

impl NodeBoxHost for Host<'_> {
    fn silhouette(&self, node_id: &str) -> Option<&str> {
        if node_id == self.case.node.id { self.case.shape.as_deref() } else { None }
    }

    fn text_placement(&self, _node: &SpatialNode) -> Option<TextPlacement> {
        self.align
    }
}

impl ComposeHost for Host<'_> {
    fn parse_body(&self, text: &str) -> Result<Root, ParseFailed> {
        match self.context.bodies.get(text) {
            Some(Some(root)) => Ok(root.clone()),
            Some(None) => Err(ParseFailed),
            None => {
                self.miss(format!("a body {text:?}"));
                Err(ParseFailed)
            }
        }
    }

    fn resolve_reference(&self, reference: &str) -> Option<ResolvedReference> {
        self.context.references.get(reference).cloned().flatten()
    }

    fn passage_highlights(&self, _: &SpatialNode, _: &str, _: &FittedBlocks) -> Vec<SceneNode> {
        Vec::new()
    }

    fn compose_file_embed(
        &self,
        _: &SpatialNode,
        _: Option<&ResolvedReference>,
        _: &ComposeOptions<'_>,
    ) -> Option<SceneNode> {
        self.case.embed.clone()
    }

    fn body_suppressed(&self, node_id: &str) -> bool {
        self.case.on("suppressed") && node_id == self.case.node.id
    }

    fn locked(&self, node_id: &str) -> bool {
        self.case.on("locked") && node_id == self.case.node.id
    }

    fn empty_frame(&self, node_id: &str) -> bool {
        self.case.on("emptyFrame") && node_id == self.case.node.id
    }

    fn degrade(&self, event: Degradation) {
        let (kind, node_id, detail) = match event {
            Degradation::BodyParseFailed { node_id } => {
                ("body-parse-failed", node_id, String::new())
            }
            Degradation::UnknownNodeKind { node_id, media_type } => {
                ("unknown-node-kind", node_id, media_type)
            }
            Degradation::UnsupportedBackgroundStyle { node_id, style } => {
                ("unsupported-background-style", node_id, style.as_str().to_owned())
            }
        };
        self.events.borrow_mut().push(Event { kind: kind.to_owned(), node_id, detail });
    }
}

/// A shortcode is a name between two colons; a facet card's `: value` holds one.
fn may_hold_shortcode(text: &str) -> bool {
    text.matches(':').nth(1).is_some()
}

impl InlineSeams for Host<'_> {
    /// The corpus holds no shortcode.
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
        self.context.embedded.get(document_id).map(|(title, _)| title.clone())
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
        let (title, root) = self.context.embedded.get(document_id)?;
        Some(Embedded::Document { title: Some(title.clone()), root: root.clone() })
    }
}

fn node_of(wire: &NodeWire) -> Res<SpatialNode> {
    let [x, y, w, h] = &wire.bbox;
    let background_style = match wire.background_style.as_deref() {
        None => None,
        Some("cover") => Some(BackgroundStyle::Cover),
        Some("ratio") => Some(BackgroundStyle::Ratio),
        Some("repeat") => Some(BackgroundStyle::Repeat),
        Some(other) => return Err(format!("a background style {other}")),
    };
    Ok(SpatialNode {
        id: wire.id.clone(),
        x: f64_of(x)?,
        y: f64_of(y)?,
        width: f64_of(w)?,
        height: f64_of(h)?,
        color: wire.color.as_ref().map(|t| {
            CanvasColorPreset::from_wire(t).map_or_else(
                || CanvasColor::CanvasColorHex(t.clone()),
                CanvasColor::CanvasColorPreset,
            )
        }),
        resource: wire.resource.as_ref().map(|r| NodeResource {
            mime_type: r.mime_type.clone(),
            content: r.content.clone(),
            location: r.location.clone(),
            subpath: r.subpath.clone(),
        }),
        label: wire.label.clone(),
        background: wire.background.clone(),
        background_style,
        ..SpatialNode::default()
    })
}

fn dump_nodes(nodes: Vec<SceneNode>) -> Res<String> {
    dump_scene(&Scene { nodes, legend: None })
}

fn differ<T: PartialEq + std::fmt::Debug>(what: &str, got: &T, want: &T) -> Res<()> {
    if got == want { Ok(()) } else { Err(format!("{what}: got\n{got:?}\nrecorded\n{want:?}")) }
}

/// What a case's options are built from, owned so the options can borrow them.
struct Setup<'c> {
    measure: Counting,
    appearance: Box<dyn SpatialAppearanceResolver>,
    host: Host<'c>,
    geometry: SpatialGeometry,
    sketch: bool,
}

impl<'c> Setup<'c> {
    fn of(context: &'c Context, case: &'c Case) -> Res<Self> {
        let appearance: Box<dyn SpatialAppearanceResolver> = match case.theme.as_str() {
            "sketch" => Box::new(create_themed_appearance(
                &context.sketch,
                SpatialThemeMode::Light,
                "Yomogi",
            )),
            "dark" => Box::new(create_spatial_theme(SpatialThemeMode::Dark, None)),
            _ => Box::new(create_spatial_theme(SpatialThemeMode::Light, None)),
        };
        let align = match case.align.as_deref() {
            Some("start") => Some(TextPlacement::Start),
            Some("center") => Some(TextPlacement::Center),
            _ => None,
        };
        let [padding, label, floor] = &case.geometry;
        Ok(Self {
            measure: Counting { base: FakeMeasure::default(), calls: Cell::new(0) },
            appearance,
            host: Host {
                context,
                case,
                align,
                events: RefCell::new(Vec::new()),
                misses: RefCell::new(Vec::new()),
            },
            geometry: SpatialGeometry {
                padding_px: f64_of(padding)?,
                label_font_size_px: f64_of(label)?,
                min_content_width_px: f64_of(floor)?,
            },
            sketch: case.theme == "sketch",
        })
    }

    /// One composition, over `cache`; the TypeScript opens a fresh budget for each.
    fn compose(&self, node: &SpatialNode, cache: Option<&Recording>) -> Res<String> {
        let budget = if self.host.case.on("spent") {
            NestedLayoutBudget::with_remaining(0, NestedLayoutBudget::ELEMENTS)
        } else {
            NestedLayoutBudget::new()
        };
        let options = ComposeOptions {
            node_box: NodeBoxOptions {
                measure: &self.measure,
                appearance: self.appearance.as_ref(),
                geometry: self.geometry,
                fit_to_box: self.host.case.fit_to_box,
                theme: self.sketch.then_some(&self.host.context.sketch),
                host: &self.host,
            },
            theme_id: self.sketch.then_some("visual.sketch"),
            host: &self.host,
            content_cache: cache.map(|c| c as &dyn ContentCache),
            body: BodySeams {
                inline: &self.host,
                highlight: None,
                math: None,
                diagram: None,
                embeds: Some(&self.host),
                canvas_layout: None,
            },
            budget: &budget,
            embed_path: &[],
            embed_depth: self.host.case.embed_depth,
        };
        dump_nodes(compose_node(node, &options))
    }
}

fn replay_case(context: &Context, case: &Case) -> Res<()> {
    let node = node_of(&case.node)?;
    let setup = Setup::of(context, case)?;
    let want = &case.answer;
    let cache = case.on("cache").then(Recording::default);
    let scene = setup.compose(&node, cache.as_ref())?;
    if scene != want.scene {
        return Err(format!("scene: got\n{scene}\nrecorded\n{}", want.scene));
    }
    differ("again", &digest(&setup.compose(&node, cache.as_ref())?), &want.again)?;
    let asked = cache.as_ref().map(|c| c.asked.borrow().clone()).unwrap_or_default();
    let kept = cache.as_ref().map(|c| c.kept.borrow().clone()).unwrap_or_default();
    differ("asked", &asked, &want.asked)?;
    differ("kept", &kept, &want.kept)?;
    let seeded = match want.asked.first() {
        None => None,
        Some(first) => {
            let seed = Recording::default();
            seed.entries.borrow_mut().insert(first.clone(), context.seeded.clone());
            Some(digest(&setup.compose(&node, Some(&seed))?))
        }
    };
    differ("seeded", &seeded, &want.seeded)?;
    differ("events", &*setup.host.events.borrow(), &want.events)?;
    differ("measurer calls", &setup.measure.calls.get(), &want.calls)?;
    differ("host misses", &*setup.host.misses.borrow(), &Vec::new())
}

/// A record's fields but its `kind`, which the reader has already dispatched on.
fn without_kind(record: &Value) -> Value {
    let mut fields = record.clone();
    if let Some(object) = fields.as_object_mut() {
        object.remove("kind");
    }
    fields
}

#[test]
fn every_recorded_composition_is_reproduced_to_the_last_bit() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/compose-node.jsonl");
    let records: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    let context = context_of(records.first().unwrap_or_else(|| panic!("a meta line")))
        .unwrap_or_else(|e| panic!("the meta line: {e}"));
    let mut cases = 0;
    let mut failures = Vec::new();
    for (at, record) in records.iter().enumerate().skip(1) {
        let outcome = serde_json::from_value::<Case>(without_kind(record))
            .map_err(|e| e.to_string())
            .and_then(|case| replay_case(&context, &case).map_err(|e| format!("{}: {e}", case.id)));
        cases += 1;
        if let Err(e) = outcome {
            failures.push(format!("line {}: {e}", at + 1));
        }
    }
    assert!(cases > 150, "{cases} cases");
    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures
            .iter()
            .map(|f| f.lines().next().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n")
    );
}
