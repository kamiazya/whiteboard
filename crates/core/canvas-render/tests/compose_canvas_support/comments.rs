//! The comment layer against the recorded TypeScript answers
//! (`compose-comments.jsonl`): canvases carrying threads laid out whole, the
//! scene compared to the last bit, where the walk's share ends, what the walk
//! and then the pin counts asked the measurer, and the degradations reported.
//! Each body as parsed, and each bubble's body laid out at the origin, are
//! answered from the recording.

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::canvas_wire::{Res, differ, f64_of};
use crate::dump::dump_scene;
use crate::seams::{CanvasWire, Context, Event, Host, OverlayWire, canvas_of};
use crate::without_kind;
use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::comments::CommentOptions;
use whiteboard_canvas_render::compose_canvas::{LayoutOptions, RenderStyle, layout_spatial_canvas};
use whiteboard_canvas_render::compose_node::BodySeams;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::{FontDescriptor, Measure, VerticalMetrics};
use whiteboard_canvas_render::theme::appearance::{
    RoutableElement, SpatialAppearanceResolver, SpatialCommentAppearance, SpatialNodeAppearance,
    SpatialProposalAppearance,
};
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::palette::SpatialSyntaxPalette;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_model::annotation::{
    AnnotationAnchor, CommentMessage, CommentThread, SpatialAnchor,
};
use whiteboard_model::spatial::SpatialNode;
use whiteboard_plugin_visual::render::StencilBadge;
use whiteboard_scene::{Appearance, BoundingBox, NodeDecoration, Scene, SceneNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Answer {
    scene: String,
    from: usize,
    bodies: BTreeMap<String, Vec<SceneNode>>,
    pin_counts: Vec<(String, String)>,
    walk_calls: usize,
    events: Vec<Event>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnchorWire {
    kind: String,
    node_id: Option<String>,
    edge_id: Option<String>,
    node_ids: Option<Vec<String>>,
    x: Option<String>,
    y: Option<String>,
    width: Option<String>,
    height: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageWire {
    id: String,
    body: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ThreadWire {
    id: String,
    anchor: AnchorWire,
    resolved: bool,
    messages: Vec<MessageWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Case {
    id: String,
    board: String,
    canvas: CanvasWire,
    threads: Vec<ThreadWire>,
    appearance: String,
    style: Option<String>,
    show_resolved: Option<bool>,
    obstacles: Option<Vec<[String; 4]>>,
    answer: Answer,
}

fn optional(wire: Option<&String>) -> Res<Option<f64>> {
    wire.map(|hex| f64_of(hex)).transpose()
}

fn anchor_of(wire: &AnchorWire) -> Res<AnnotationAnchor> {
    Ok(match wire.kind.as_str() {
        "document" => AnnotationAnchor::Document,
        "text" => AnnotationAnchor::Text { node_id: wire.node_id.clone() },
        "spatial" => AnnotationAnchor::Spatial(SpatialAnchor {
            node_id: wire.node_id.clone(),
            edge_id: wire.edge_id.clone(),
            node_ids: wire.node_ids.clone(),
            x: optional(wire.x.as_ref())?.ok_or("a spatial x")?,
            y: optional(wire.y.as_ref())?.ok_or("a spatial y")?,
            width: optional(wire.width.as_ref())?,
            height: optional(wire.height.as_ref())?,
        }),
        other => return Err(format!("an anchor of kind {other}")),
    })
}

fn thread_of(wire: &ThreadWire) -> Res<CommentThread> {
    Ok(CommentThread {
        id: wire.id.clone(),
        anchor: anchor_of(&wire.anchor)?,
        resolved: wire.resolved,
        messages: wire
            .messages
            .iter()
            .map(|m| CommentMessage { id: m.id.clone(), body: m.body.clone() })
            .collect(),
    })
}

fn box_of([x, y, w, h]: &[String; 4]) -> Res<BoundingBox> {
    Ok(BoundingBox { x: f64_of(x)?, y: f64_of(y)?, w: f64_of(w)?, h: f64_of(h)? })
}

/// A measurer noting each question's text, family and size.
struct Asking {
    base: FakeMeasure,
    asked: RefCell<Vec<(String, String, f64)>>,
}

impl Measure for Asking {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        self.asked.borrow_mut().push((text.to_owned(), font.family.clone(), font.size_px));
        self.base.advance_width(text, font)
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        self.base.vertical_metrics(font)
    }
}

/// A resolver that paints as the one it wraps and has no comment chrome.
struct Bare<R>(R);

impl<R: SpatialAppearanceResolver> SpatialAppearanceResolver for Bare<R> {
    fn mode(&self) -> Option<SpatialThemeMode> {
        self.0.mode()
    }

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
        None
    }

    fn resolve_proposal(&self) -> Option<SpatialProposalAppearance> {
        self.0.resolve_proposal()
    }
}

fn appearance_of(name: &str) -> Box<dyn SpatialAppearanceResolver> {
    match name {
        "dark" => Box::new(create_spatial_theme(SpatialThemeMode::Dark, None)),
        "bare" => Box::new(Bare(create_spatial_theme(SpatialThemeMode::Light, None))),
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

/// The measurer's questions past the walk's, as the recording keeps them.
fn check_asked(asked: &[(String, String, f64)], want: &Answer) -> Res<()> {
    differ("walk measurer calls", &asked.len().min(want.walk_calls), &want.walk_calls)?;
    let counts: Vec<(String, String)> = asked
        .get(want.walk_calls..)
        .unwrap_or_default()
        .iter()
        .map(|(text, family, size)| {
            differ("a pin count's size", size, &10.0)?;
            Ok((text.clone(), family.clone()))
        })
        .collect::<Res<_>>()?;
    differ("pin counts", &counts, &want.pin_counts)
}

fn replay_case(context: &Context, case: &Case) -> Res<()> {
    let canvas = canvas_of(&case.canvas)?;
    let threads = case.threads.iter().map(thread_of).collect::<Res<Vec<_>>>()?;
    let obstacles = case.obstacles.iter().flatten().map(box_of).collect::<Res<Vec<_>>>()?;
    let want = &case.answer;
    let overlay = OverlayWire { from: want.from, nodes: Vec::new() };
    let host = Host::new(context, &overlay, None, want.bodies.clone());
    let measure = Asking { base: FakeMeasure::default(), asked: RefCell::new(Vec::new()) };
    let appearance = appearance_of(&case.appearance);
    let badge = StencilBadge { registry: &context.registry };
    let decorations: [&dyn NodeDecoration; 1] = [&badge];
    let options = LayoutOptions {
        measure: &measure,
        appearance: appearance.as_ref(),
        geometry: None,
        style: style_of(case.style.as_deref()),
        themes: &context.themes,
        font_available: None,
        registry: &context.registry,
        decorations: &decorations,
        tag_library: None,
        suppressed: &[],
        locked: &[],
        side_overrides: None,
        host: &host,
        overlays: &host,
        comments: CommentOptions {
            threads: &threads,
            show_resolved: case.show_resolved == Some(true),
            obstacles: &obstacles,
        },
        content_cache: None,
        body: BodySeams { inline: &host, highlight: None, math: None, diagram: None, embeds: None },
        budget: None,
        embed_path: &[],
    };
    let laid = layout_spatial_canvas(&canvas, &options);
    let scene = dump_scene(&Scene { nodes: laid.scene.nodes, legend: None })?;
    if scene != want.scene {
        return Err(format!("scene: got\n{scene}\nrecorded\n{}", want.scene));
    }
    differ("legend", &laid.scene.legend, &None)?;
    check_asked(&measure.asked.borrow(), want)?;
    host.recorded(0).check(&want.events, 0)
}

#[test]
fn every_recorded_comment_layer_is_reproduced_to_the_last_bit() {
    let text =
        include_str!("../../../../../packages/canvas-render/src/oracle/compose-comments.jsonl");
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
    assert!(boards.len() >= 3, "{boards:?}");
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
