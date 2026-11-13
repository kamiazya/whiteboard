//! The node-box primitives, `translate_scene` and `seed_from_id` against the
//! recorded TypeScript answers (`node-box.jsonl`): for each node and the options
//! a composer hands its box, the content bounds and width, the chrome with and
//! without a fit, the recorded label's runs above and inside, a probe label's
//! runs, and a content scene placed in the node, above it and fitted to it, with
//! how many times the measurer was asked. Every double is compared as its IEEE
//! bits.

#[path = "typeset_support/dump.rs"]
mod dump;
#[path = "theme_support/tokens.rs"]
mod tokens;

use std::cell::Cell;
use std::collections::BTreeMap;

use dump::dump_scene;
use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::{FontDescriptor, Measure, VerticalMetrics};
use whiteboard_canvas_render::node_box::{
    LabelPlace, NodeBoxHost, NodeBoxOptions, TextPlacement, chrome_shape, chrome_with_fit,
    content_width, fit_scene_in_node, label_runs, node_content_bounds, place_above_node,
    place_in_node,
};
use whiteboard_canvas_render::seed::seed_from_id;
use whiteboard_canvas_render::theme::appearance::SpatialAppearanceResolver;
use whiteboard_canvas_render::theme::asset::create_themed_appearance;
use whiteboard_canvas_render::theme::geometry::SpatialGeometry;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_canvas_render::translate_scene::translate_scene;
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_model::spatial::{CanvasColor, CanvasColorPreset, NodeResource, SpatialNode};
use whiteboard_scene::{Scene, SceneNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

type Res<T> = Result<T, String>;

fn f64_of(hex: &str) -> Res<f64> {
    u64::from_str_radix(hex, 16).map(f64::from_bits).map_err(|e| format!("{hex}: {e}"))
}

fn hex(value: f64) -> String {
    let value = if value.is_nan() { f64::NAN } else { value };
    format!("{:016x}", value.to_bits())
}

fn fnv(text: &str) -> u32 {
    text.encode_utf16()
        .fold(0x811c_9dc5_u32, |state, unit| (state ^ u32::from(unit)).wrapping_mul(16_777_619))
}

/// A recorded digest: the text's UTF-16 length and its FNV-1a.
#[derive(Deserialize, Debug, PartialEq)]
struct Digest {
    n: usize,
    h: u32,
}

fn digest(text: &str) -> Digest {
    Digest { n: text.encode_utf16().count(), h: fnv(text) }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeWire {
    id: String,
    #[serde(rename = "box")]
    bbox: [String; 4],
    color: Option<String>,
    resource: Option<ResourceWire>,
    label: Option<String>,
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
#[serde(deny_unknown_fields)]
struct FitWire {
    n: usize,
    h: u32,
    truncated: bool,
    overflows: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    bounds: [String; 4],
    width: String,
    chrome: String,
    fitted: String,
    label: Option<String>,
    above: String,
    inside: String,
    probe: String,
    placed: Digest,
    lifted: Digest,
    fit: Option<FitWire>,
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
    /// What a file node's reference resolved to: the input of the label, which
    /// the replay reads as recorded until the label itself is ported (S11b).
    #[serde(rename = "resolved")]
    _resolved: Value,
    probe: String,
    content: String,
    answer: Answer,
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

/// What the host resolved for the one node of a case.
struct Host {
    id: String,
    shape: Option<String>,
    align: Option<TextPlacement>,
}

impl NodeBoxHost for Host {
    fn silhouette(&self, node_id: &str) -> Option<&str> {
        if node_id == self.id { self.shape.as_deref() } else { None }
    }

    fn text_placement(&self, _node: &SpatialNode) -> Option<TextPlacement> {
        self.align
    }
}

fn node_of(wire: &NodeWire) -> Res<SpatialNode> {
    let [x, y, w, h] = &wire.bbox;
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
        ..SpatialNode::default()
    })
}

fn dump_nodes(nodes: Vec<SceneNode>) -> Res<String> {
    dump_scene(&Scene { nodes, legend: None })
}

struct Context {
    sketch: ThemeTokens,
    contents: BTreeMap<String, Vec<SceneNode>>,
}

fn content<'c>(context: &'c Context, name: &str) -> Res<&'c [SceneNode]> {
    context.contents.get(name).map(Vec::as_slice).ok_or_else(|| format!("no content {name}"))
}

fn differ(what: &str, got: &str, want: &str) -> Res<()> {
    if got == want { Ok(()) } else { Err(format!("{what}: got\n{got}\nrecorded\n{want}")) }
}

/// What a case's options are built from, owned so the options can borrow them.
struct Setup<'c> {
    measure: Counting,
    appearance: Box<dyn SpatialAppearanceResolver>,
    host: Host,
    geometry: SpatialGeometry,
    theme: Option<&'c ThemeTokens>,
    fit_to_box: bool,
}

impl<'c> Setup<'c> {
    fn of(context: &'c Context, case: &Case, node: &SpatialNode) -> Res<Self> {
        let appearance: Box<dyn SpatialAppearanceResolver> = match case.theme.as_str() {
            "sketch" => Box::new(create_themed_appearance(
                &context.sketch,
                SpatialThemeMode::Light,
                "Yomogi",
            )),
            "dark" => Box::new(create_spatial_theme(SpatialThemeMode::Dark, None)),
            _ => Box::new(create_spatial_theme(SpatialThemeMode::Light, None)),
        };
        let [padding, label, floor] = &case.geometry;
        let align = match case.align.as_deref() {
            Some("start") => Some(TextPlacement::Start),
            Some("center") => Some(TextPlacement::Center),
            _ => None,
        };
        Ok(Self {
            measure: Counting { base: FakeMeasure::default(), calls: Cell::new(0) },
            appearance,
            host: Host { id: node.id.clone(), shape: case.shape.clone(), align },
            geometry: SpatialGeometry {
                padding_px: f64_of(padding)?,
                label_font_size_px: f64_of(label)?,
                min_content_width_px: f64_of(floor)?,
            },
            theme: (case.theme == "sketch").then_some(&context.sketch),
            fit_to_box: case.fit_to_box,
        })
    }

    fn options(&self) -> NodeBoxOptions<'_> {
        NodeBoxOptions {
            measure: &self.measure,
            appearance: self.appearance.as_ref(),
            geometry: self.geometry,
            fit_to_box: self.fit_to_box,
            theme: self.theme,
            host: &self.host,
        }
    }
}

/// The box itself: its content bounds and width, its chrome, and its labels.
fn check_box(node: &SpatialNode, options: &NodeBoxOptions<'_>, case: &Case) -> Res<()> {
    let want = &case.answer;
    let bounds = node_content_bounds(node, options);
    let bounds = [bounds.x, bounds.y, bounds.w, bounds.h].map(hex).join(",");
    differ("bounds", &bounds, &want.bounds.join(","))?;
    differ("width", &hex(content_width(node, options)), &want.width)?;
    let chrome = SceneNode::Shape(Box::new(chrome_shape(node, options)));
    differ("chrome", &dump_nodes(vec![chrome])?, &want.chrome)?;
    let fitted = SceneNode::Shape(Box::new(chrome_with_fit(node, options, true, true)));
    differ("fitted chrome", &dump_nodes(vec![fitted])?, &want.fitted)?;
    let runs = |text: Option<&str>, place| dump_nodes(label_runs(node, text, place, options));
    differ("above", &runs(want.label.as_deref(), LabelPlace::Above)?, &want.above)?;
    differ("inside", &runs(want.label.as_deref(), LabelPlace::Inside)?, &want.inside)?;
    differ("probe", &runs(Some(&case.probe), LabelPlace::Inside)?, &want.probe)
}

/// A content scene placed in the node, lifted above it and fitted to it.
fn check_content(
    node: &SpatialNode,
    options: &NodeBoxOptions<'_>,
    scene: &[SceneNode],
    want: &Answer,
) -> Res<()> {
    let placed = dump_nodes(place_in_node(node, scene, options))?;
    if digest(&placed) != want.placed {
        return Err(format!("placed {:?}, recorded {:?}\n{placed}", digest(&placed), want.placed));
    }
    let lifted = dump_nodes(place_above_node(node, scene))?;
    if digest(&lifted) != want.lifted {
        return Err(format!("lifted {:?}, recorded {:?}\n{lifted}", digest(&lifted), want.lifted));
    }
    let got = match fit_scene_in_node(scene, node, options) {
        None => None,
        Some(kept) => {
            let text = dump_nodes(kept.nodes)?;
            Some((text.encode_utf16().count(), fnv(&text), kept.truncated, kept.overflows))
        }
    };
    let held = want.fit.as_ref().map(|f| (f.n, f.h, f.truncated, f.overflows));
    if got == held { Ok(()) } else { Err(format!("fit {got:?}, recorded {held:?}")) }
}

fn replay_case(context: &Context, case: &Case) -> Res<()> {
    let node = node_of(&case.node)?;
    let setup = Setup::of(context, case, &node)?;
    let options = setup.options();
    check_box(&node, &options, case)?;
    check_content(&node, &options, content(context, &case.content)?, &case.answer)?;
    let calls = setup.measure.calls.get();
    if calls == case.answer.calls {
        Ok(())
    } else {
        Err(format!("{calls} measurer calls, recorded {}", case.answer.calls))
    }
}

fn replay_translate(context: &Context, record: &Value) -> Res<()> {
    let text = |key: &str| record[key].as_str().ok_or_else(|| format!("no {key}"));
    let scene = content(context, text("content")?)?;
    let moved = translate_scene(scene, f64_of(text("dx")?)?, f64_of(text("dy")?)?);
    let got = digest(&dump_nodes(moved)?);
    let want: Digest = serde_json::from_value(record.clone()).map_err(|e| e.to_string())?;
    if got == want { Ok(()) } else { Err(format!("translated {got:?}, recorded {want:?}")) }
}

fn replay_seeds(record: &Value) -> Res<()> {
    let ids: Vec<String> =
        serde_json::from_value(record["ids"].clone()).map_err(|e| e.to_string())?;
    let seeds: Vec<u32> =
        serde_json::from_value(record["seeds"].clone()).map_err(|e| e.to_string())?;
    let got: Vec<u32> = ids.iter().map(|id| seed_from_id(id)).collect();
    if got == seeds { Ok(()) } else { Err(format!("seeds {got:?}, recorded {seeds:?}")) }
}

/// A record's fields but its `kind`, which the reader has already dispatched on.
fn without_kind(record: &Value) -> Value {
    let mut fields = record.clone();
    if let Some(object) = fields.as_object_mut() {
        object.remove("kind");
    }
    fields
}

fn context_of(meta: &Value) -> Res<Context> {
    Ok(Context {
        sketch: tokens::theme_tokens(&meta["sketch"])?,
        contents: serde_json::from_value(meta["contents"].clone()).map_err(|e| e.to_string())?,
    })
}

#[test]
fn every_recorded_node_box_answer_is_reproduced_to_the_last_bit() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/node-box.jsonl");
    let records: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    let context = context_of(records.first().unwrap_or_else(|| panic!("a meta line")))
        .unwrap_or_else(|e| {
            panic!("the meta line: {e}");
        });
    let mut counts = BTreeMap::<String, usize>::new();
    let mut failures = Vec::new();
    for (at, record) in records.iter().enumerate().skip(1) {
        let kind = record["kind"].as_str().unwrap_or_default().to_owned();
        let outcome = match kind.as_str() {
            "seed" => replay_seeds(record),
            "translate" => replay_translate(&context, record),
            "case" => serde_json::from_value::<Case>(without_kind(record))
                .map_err(|e| e.to_string())
                .and_then(|case| {
                    replay_case(&context, &case).map_err(|e| format!("{}: {e}", case.id))
                }),
            other => Err(format!("an unknown record kind {other}")),
        };
        *counts.entry(kind).or_default() += 1;
        if let Err(e) = outcome {
            failures.push(format!("line {}: {e}", at + 1));
        }
    }
    assert_eq!(counts.get("seed"), Some(&1), "{counts:?}");
    assert!(counts.get("translate").is_some_and(|n| *n > 50), "{counts:?}");
    assert!(counts.get("case").is_some_and(|n| *n > 300), "{counts:?}");
    assert!(failures.is_empty(), "{} differ; first: {}", failures.len(), failures[0]);
}
