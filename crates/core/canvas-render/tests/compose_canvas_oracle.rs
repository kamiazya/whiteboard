//! The composer's walk against the recorded TypeScript answers
//! (`compose-canvas.jsonl`): for each canvas under the options a caller hands a
//! layout, the whole scene with its legend, the anchors the routing settled, the
//! edges laid out alone, each node's natural size, the degradations reported and
//! how many times the measurer was asked. A body parsed, and what the overlays
//! drew over the top-level canvas, are answered from the recording. The edges
//! laid out alone are also held to the edge suffix of the whole layout, which is
//! what a live drag relies on.

#[path = "canvas_wire/mod.rs"]
mod canvas_wire;
#[path = "degrade_support/mod.rs"]
mod degrade_support;
#[path = "typeset_support/dump.rs"]
mod dump;
#[path = "facet_support/mod.rs"]
mod facet_support;
#[path = "typeset_support/model.rs"]
mod model;
#[path = "compose_canvas_support/seams.rs"]
mod seams;
#[path = "theme_support/tokens.rs"]
mod tokens;

use std::cell::Cell;
use std::collections::BTreeMap;

use canvas_wire::{Counting, OverrideWire, Res, anchor_row, differ, f64_of, hex, pin_of};
use dump::dump_scene;
use seams::{
    CanvasWire, Context, Event, Host, KeyCache, OverlayWire, Recorded, Unmoded, canvas_of,
};
use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::compose_canvas::{
    LayoutOptions, RenderStyle, layout_spatial_canvas, layout_spatial_edges,
    natural_node_content_size,
};
use whiteboard_canvas_render::compose_node::{BodySeams, ContentCache};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::theme::appearance::SpatialAppearanceResolver;
use whiteboard_canvas_render::theme::geometry::SpatialGeometry;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_edge_routing::edge_sides::EdgeAnchorOverride;
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_plugin_visual::render::StencilBadge;
use whiteboard_scene::{NodeDecoration, Scene, SceneLegend, SceneNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CanvasAnswer {
    scene: String,
    overlay: OverlayWire,
    legend: Option<SceneLegend>,
    anchors: Vec<Vec<Option<String>>>,
    events: Vec<Event>,
    calls: usize,
    asked: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryAnswer {
    scene: String,
    events: Vec<Event>,
    calls: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Answer {
    canvas: CanvasAnswer,
    edges: EntryAnswer,
    natural: Vec<[String; 3]>,
    natural_calls: usize,
    natural_events: Vec<Event>,
    natural_asked: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Case {
    id: String,
    board: String,
    canvas: CanvasWire,
    style: Option<String>,
    appearance: String,
    geometry: Option<[String; 3]>,
    fonts: String,
    #[serde(default)]
    locked: Vec<String>,
    #[serde(default)]
    suppressed: Vec<String>,
    library: Option<bool>,
    overrides: Option<Vec<(String, OverrideWire)>>,
    #[serde(default)]
    embed_path: Vec<String>,
    cache: Option<bool>,
    answer: Answer,
}

fn geometry_of(wire: Option<&[String; 3]>) -> Res<Option<SpatialGeometry>> {
    let Some([padding, label, floor]) = wire else { return Ok(None) };
    Ok(Some(SpatialGeometry {
        padding_px: f64_of(padding)?,
        label_font_size_px: f64_of(label)?,
        min_content_width_px: f64_of(floor)?,
    }))
}

fn appearance_of(name: &str) -> Box<dyn SpatialAppearanceResolver> {
    match name {
        "dark" => Box::new(create_spatial_theme(SpatialThemeMode::Dark, None)),
        "unmoded-dark" => Box::new(Unmoded(create_spatial_theme(SpatialThemeMode::Dark, None))),
        _ => Box::new(create_spatial_theme(SpatialThemeMode::Light, None)),
    }
}

fn style_of(style: Option<&str>) -> RenderStyle<'_> {
    match style {
        None | Some("clean") => RenderStyle::Clean,
        Some("document") => RenderStyle::Document,
        Some(id) => RenderStyle::Theme(id),
    }
}

const HOLDS_EVERY_FACE: &dyn Fn(&str) -> bool = &|_| true;
const HOLDS_NO_FACE: &dyn Fn(&str) -> bool = &|_| false;

/// What a case's options are built from, owned so the options can borrow them.
struct Setup<'c> {
    context: &'c Context,
    case: &'c Case,
    canvas: SpatialCanvas,
    appearance: Box<dyn SpatialAppearanceResolver>,
    geometry: Option<SpatialGeometry>,
    pins: Option<Vec<(String, EdgeAnchorOverride)>>,
}

impl<'c> Setup<'c> {
    fn of(context: &'c Context, case: &'c Case) -> Res<Self> {
        let pins = case
            .overrides
            .as_ref()
            .map(|pins| {
                pins.iter().map(|(id, pin)| Ok((id.clone(), pin_of(pin)?))).collect::<Res<_>>()
            })
            .transpose()?;
        Ok(Self {
            context,
            case,
            canvas: canvas_of(&case.canvas)?,
            appearance: appearance_of(&case.appearance),
            geometry: geometry_of(case.geometry.as_ref())?,
            pins,
        })
    }

    /// One entry point's run, with a fresh host, measurer and cache; the keys
    /// the cache was asked, when the case hands one over.
    fn run<T>(
        &self,
        entry: impl FnOnce(&LayoutOptions<'_>) -> T,
    ) -> (T, Recorded, Option<Vec<String>>) {
        let cache = (self.case.cache == Some(true)).then(KeyCache::default);
        let measure = Counting { base: FakeMeasure::default(), calls: Cell::new(0) };
        let want = &self.case.answer.canvas;
        let host = Host::new(self.context, &want.overlay, want.legend.as_ref());
        let badge = StencilBadge { registry: &self.context.registry };
        let decorations: [&dyn NodeDecoration; 1] = [&badge];
        let options = LayoutOptions {
            measure: &measure,
            appearance: self.appearance.as_ref(),
            geometry: self.geometry,
            style: style_of(self.case.style.as_deref()),
            themes: &self.context.themes,
            font_available: match self.case.fonts.as_str() {
                "all" => Some(HOLDS_EVERY_FACE),
                "none" => Some(HOLDS_NO_FACE),
                _ => None,
            },
            registry: &self.context.registry,
            decorations: &decorations,
            tag_library: (self.case.library == Some(true)).then_some(&self.context.library),
            suppressed: &self.case.suppressed,
            locked: &self.case.locked,
            side_overrides: self.pins.as_deref(),
            host: &host,
            overlays: &host,
            content_cache: cache.as_ref().map(|c| c as &dyn ContentCache),
            body: BodySeams {
                inline: &host,
                highlight: None,
                math: None,
                diagram: None,
                embeds: Some(&host),
            },
            budget: None,
            embed_path: &self.case.embed_path,
        };
        let answer = entry(&options);
        (answer, host.recorded(measure.calls.get()), cache.map(|c| c.asked()))
    }
}

fn dump_nodes(nodes: Vec<SceneNode>) -> Res<String> {
    dump_scene(&Scene { nodes, legend: None })
}

fn check_scene(what: &str, got: &str, want: &str) -> Res<()> {
    if got == want { Ok(()) } else { Err(format!("{what}: got\n{got}\nrecorded\n{want}")) }
}

fn replay_canvas(setup: &Setup<'_>) -> Res<Vec<SceneNode>> {
    let want = &setup.case.answer.canvas;
    let (laid, recorded, asked) =
        setup.run(|options| layout_spatial_canvas(&setup.canvas, options));
    differ("keys asked", &asked, &want.asked)?;
    let from = want.overlay.from;
    let drawn: Vec<SceneNode> = laid.scene.nodes.iter().take(from).cloned().collect();
    check_scene("scene", &dump_nodes(laid.scene.nodes)?, &want.scene)?;
    differ("legend", &laid.scene.legend, &want.legend)?;
    let anchors: Vec<_> = laid.anchors.iter().map(|(id, pair)| anchor_row(id, pair)).collect();
    differ("anchors", &anchors, &want.anchors)?;
    recorded.check(&want.events, want.calls)?;
    Ok(drawn)
}

fn replay_edges(setup: &Setup<'_>, drawn: &[SceneNode]) -> Res<()> {
    let want = &setup.case.answer.edges;
    let (content, recorded, _) = setup.run(|options| layout_spatial_edges(&setup.canvas, options));
    let suffix = drawn.get(drawn.len().saturating_sub(content.len())..).unwrap_or_default();
    differ("the edges alone against the whole layout's suffix", &content.as_slice(), &suffix)?;
    check_scene("edges", &dump_nodes(content)?, &want.scene)?;
    recorded.check(&want.events, want.calls)
}

fn replay_natural(setup: &Setup<'_>) -> Res<()> {
    let answer = &setup.case.answer;
    let (sizes, recorded, asked) = setup.run(|options| {
        setup
            .canvas
            .nodes
            .iter()
            .map(|node| {
                let size = natural_node_content_size(node, options);
                [node.id.clone(), hex(size.w), hex(size.h)]
            })
            .collect::<Vec<_>>()
    });
    differ("natural sizes", &sizes, &answer.natural)?;
    differ("keys asked for natural sizes", &asked, &answer.natural_asked)?;
    recorded.check(&answer.natural_events, answer.natural_calls)
}

fn replay_case(context: &Context, case: &Case) -> Res<()> {
    let setup = Setup::of(context, case)?;
    let drawn = replay_canvas(&setup)?;
    replay_edges(&setup, &drawn)?;
    replay_natural(&setup)
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
fn every_recorded_walk_is_reproduced_to_the_last_bit() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/compose-canvas.jsonl");
    let records: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    let context = Context::of(records.first().unwrap_or_else(|| panic!("a meta line")))
        .unwrap_or_else(|e| panic!("the meta line: {e}"));
    let mut boards = BTreeMap::<String, usize>::new();
    let mut failures = Vec::new();
    for (at, record) in records.iter().enumerate().skip(1) {
        let outcome = serde_json::from_value::<Case>(without_kind(record))
            .map_err(|e| e.to_string())
            .and_then(|case| {
                *boards.entry(case.board.clone()).or_default() += 1;
                replay_case(&context, &case).map_err(|e| format!("{}: {e}", case.id))
            });
        if let Err(e) = outcome {
            failures.push(format!("line {}: {e}", at + 1));
        }
    }
    assert!(boards.len() >= 6, "{boards:?}");
    assert!(
        failures.is_empty(),
        "{} differ, the first in full:\n{}\n{}",
        failures.len(),
        failures.first().map_or("", String::as_str),
        failures
            .iter()
            .map(|f| f.lines().next().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n")
    );
}
