//! `compose_edges_and_labels` against the recorded TypeScript answers
//! (`compose-edges.jsonl`): for each board under each theme and geometry, the
//! edges and lines drawn with their labels, the anchors the routing settled in
//! the order it settled them, and how many times the measurer was asked. The
//! visual plugin's facets on the canvas and on each element are read by the
//! plugin's own readers, which are held to what the TypeScript's answered
//! (`facts`). The hops it computes itself; where any element draws them, the
//! hops recorded over every routed edge, drawn or not, are compared too.

#[path = "canvas_wire/mod.rs"]
mod canvas_wire;
#[path = "typeset_support/dump.rs"]
mod dump;
#[path = "facet_support/mod.rs"]
mod facet_support;
#[path = "theme_support/tokens.rs"]
mod tokens;

use std::cell::Cell;
use std::collections::BTreeMap;

use canvas_wire::{
    Counting, ElementWire, NodeWire, OverrideWire, Res, anchor_row, canvas_parts, differ, f64_of,
    hex, pin_of,
};
use dump::dump_scene;
use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::compose_edges::{EdgeOptions, compose_edges_and_labels};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::{NodeBoxOptions, NodeOutlines};
use whiteboard_canvas_render::theme::appearance::SpatialAppearanceResolver;
use whiteboard_canvas_render::theme::asset::create_themed_appearance;
use whiteboard_canvas_render::theme::geometry::SpatialGeometry;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_edge_routing::edge_jumps::{EdgePath, compute_edge_jumps};
use whiteboard_edge_routing::edge_sides::EdgeAnchorOverride;
use whiteboard_edge_routing::geometry::Point;
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_plugin_visual::host::visual_registry;
use whiteboard_plugin_visual::read;
use whiteboard_plugin_visual::visual::{EdgeRoutingStyle, LineJumps, VisualEdgesFacet};
use whiteboard_scene::{Scene, SceneNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StyleWire {
    style: Option<String>,
    routing: Option<String>,
    line_jumps: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Facts {
    canvas: StyleWire,
    own: Vec<StyleWire>,
    stroke: Vec<String>,
}

type JumpsWire = Vec<(String, Vec<[String; 3]>)>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    scene: String,
    anchors: Vec<Vec<Option<String>>>,
    jumps: Option<JumpsWire>,
    calls: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    theme: String,
    geometry: [String; 3],
    facets: Option<Value>,
    nodes: Vec<NodeWire>,
    edges: Vec<ElementWire>,
    lines: Option<Vec<ElementWire>>,
    shapes: BTreeMap<String, String>,
    overrides: Option<Vec<(String, OverrideWire)>>,
    facts: Facts,
    answer: Answer,
}

fn style_of(wire: &StyleWire) -> Res<VisualEdgesFacet> {
    let routing = wire.style.as_deref().or(wire.routing.as_deref());
    let routing = routing.map(|r| EdgeRoutingStyle::from_wire(r).ok_or(format!("routing {r}")));
    let jumps =
        wire.line_jumps.as_deref().map(|j| LineJumps::from_wire(j).ok_or(format!("jumps {j}")));
    Ok(VisualEdgesFacet { routing: routing.transpose()?, line_jumps: jumps.transpose()? })
}

/// What the plugin's readers answer for the canvas and each element, edges then
/// lines, held to what the TypeScript's answered.
fn check_facts(canvas: &SpatialCanvas, facts: &Facts, registry: &Registry) -> Res<()> {
    differ(
        "canvas style",
        &read::edges_style(canvas.facets.as_ref(), registry),
        &style_of(&facts.canvas)?,
    )?;
    let buckets: Vec<_> = canvas
        .edges
        .iter()
        .map(|edge| edge.facets.as_ref())
        .chain(canvas.lines.iter().flatten().map(|line| line.facets.as_ref()))
        .collect();
    let own: Vec<_> = buckets.iter().map(|facets| read::edges_style(*facets, registry)).collect();
    let recorded: Vec<_> = facts.own.iter().map(style_of).collect::<Res<_>>()?;
    differ("own styles", &own, &recorded)?;
    let stroke: Vec<_> = buckets
        .iter()
        .map(|facets| read::stroke_width(*facets, registry).map_or("thin", |w| w.as_str()))
        .collect();
    differ("weights", &stroke, &facts.stroke.iter().map(String::as_str).collect())
}

/// The hops over every edge drawn in `content`, its own hops taken off, as
/// the recording writes them.
fn jumps_over(content: &[SceneNode]) -> JumpsWire {
    let edges: Vec<(&str, Vec<Point>)> = content
        .iter()
        .filter_map(|node| match node {
            SceneNode::Edge(edge) => Some((
                edge.id.as_str(),
                edge.path.iter().map(|p| Point { x: p.x, y: p.y }).collect(),
            )),
            _ => None,
        })
        .collect();
    let paths: Vec<EdgePath<'_>> = edges.iter().map(|(id, path)| EdgePath { id, path }).collect();
    compute_edge_jumps(&paths)
        .into_iter()
        .map(|(id, points)| {
            let wire = points
                .iter()
                .map(|p| {
                    [
                        hex(f64::from(u32::try_from(p.segment).unwrap_or(u32::MAX))),
                        hex(p.x),
                        hex(p.y),
                    ]
                })
                .collect();
            (id.to_owned(), wire)
        })
        .collect()
}

fn appearance_of(
    sketch: &ThemeTokens,
    neon: &ThemeTokens,
    theme: &str,
) -> Box<dyn SpatialAppearanceResolver> {
    match theme {
        "sketch" => Box::new(create_themed_appearance(sketch, SpatialThemeMode::Light, "Yomogi")),
        "neon" => Box::new(create_themed_appearance(neon, SpatialThemeMode::Light, "Roboto")),
        "dark" => Box::new(create_spatial_theme(SpatialThemeMode::Dark, None)),
        _ => Box::new(create_spatial_theme(SpatialThemeMode::Light, None)),
    }
}

fn geometry_of(case: &Case) -> Res<SpatialGeometry> {
    let [padding, label, floor] = &case.geometry;
    Ok(SpatialGeometry {
        padding_px: f64_of(padding)?,
        label_font_size_px: f64_of(label)?,
        min_content_width_px: f64_of(floor)?,
    })
}

fn replay_case(themes: &(ThemeTokens, ThemeTokens), registry: &Registry, case: &Case) -> Res<()> {
    let canvas =
        canvas_parts(case.facets.as_ref(), &case.nodes, &case.edges, case.lines.as_deref())?;
    check_facts(&canvas, &case.facts, registry)?;
    let outlines = NodeOutlines(case.shapes.clone().into_iter().collect());
    let measure = Counting { base: FakeMeasure::default(), calls: Cell::new(0) };
    let appearance = appearance_of(&themes.0, &themes.1, &case.theme);
    let theme = match case.theme.as_str() {
        "sketch" => Some(&themes.0),
        "neon" => Some(&themes.1),
        _ => None,
    };
    let pins: Option<Vec<(String, EdgeAnchorOverride)>> = case
        .overrides
        .as_ref()
        .map(|pins| pins.iter().map(|(id, pin)| Ok((id.clone(), pin_of(pin)?))).collect::<Res<_>>())
        .transpose()?;
    let options = EdgeOptions {
        node_box: NodeBoxOptions {
            measure: &measure,
            appearance: appearance.as_ref(),
            geometry: geometry_of(case)?,
            fit_to_box: true,
            theme,
            outlines: &outlines,
            registry,
        },
        side_overrides: pins.as_deref(),
    };
    let composed = compose_edges_and_labels(&canvas, &options);
    if let Some(recorded) = &case.answer.jumps {
        differ("hops over every edge", &jumps_over(&composed.content), recorded)?;
    }
    let scene = dump_scene(&Scene { nodes: composed.content, legend: None });
    if scene != case.answer.scene {
        return Err(format!("scene: got\n{scene}\nrecorded\n{}", case.answer.scene));
    }
    let anchors: Vec<_> = composed.anchors.iter().map(|(id, pair)| anchor_row(id, pair)).collect();
    differ("anchors", &anchors, &case.answer.anchors)?;
    differ("measurer calls", &measure.calls.get(), &case.answer.calls)
}

fn themes_of(meta: &Value) -> Res<(ThemeTokens, ThemeTokens)> {
    let at = |key: &str| meta.get(key).ok_or(format!("the meta line's {key}"));
    Ok((tokens::theme_tokens(at("sketch")?)?, tokens::theme_tokens(at("neon")?)?))
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
fn every_recorded_edge_pass_is_reproduced_to_the_last_bit() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/compose-edges.jsonl");
    let records: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    let themes = themes_of(records.first().unwrap_or_else(|| panic!("a meta line")))
        .unwrap_or_else(|e| panic!("the meta line: {e}"));
    let registry = visual_registry().unwrap_or_else(|e| panic!("the bundled plugin: {e:?}"));
    let mut failures = Vec::new();
    for (at, record) in records.iter().enumerate().skip(1) {
        let outcome = serde_json::from_value::<Case>(without_kind(record))
            .map_err(|e| e.to_string())
            .and_then(|case| {
                replay_case(&themes, &registry, &case).map_err(|e| format!("{}: {e}", case.id))
            });
        if let Err(e) = outcome {
            failures.push(format!("line {}: {e}", at + 1));
        }
    }
    assert!(records.len() > 100, "{} records", records.len());
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
