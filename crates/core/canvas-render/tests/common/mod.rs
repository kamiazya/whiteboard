//! Replaying a recording of the TypeScript SVG backend: what a record holds, and
//! how a replay names the first way a drawing differs.

use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::svg::{
    KeyedSvgRender, SvgDocumentOptions, render_scene_to_keyed_svg, render_scene_to_svg,
};
use whiteboard_scene::{BoundingBox, Scene};

/// The options of a record as `JSON.stringify` wrote them; an option the
/// backend gains must be named here or the replay refuses the record.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RecordedOptions {
    width: Option<f64>,
    height: Option<f64>,
    view_box: Option<RecordedBox>,
    padding: Option<f64>,
    background: Option<String>,
    text_fill: Option<String>,
    legend: Option<String>,
    raster_scale: Option<f64>,
}

#[derive(Deserialize)]
struct RecordedBox {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Deserialize)]
struct RecordedGroup {
    key: String,
    svg: String,
    #[serde(default)]
    annotation: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedKeyed {
    root_open: String,
    root_attrs: serde_json::Map<String, Value>,
    groups: Vec<RecordedGroup>,
}

#[derive(Deserialize)]
struct Record {
    id: String,
    scene: Value,
    options: Option<RecordedOptions>,
    svg: String,
    keyed: RecordedKeyed,
}

fn options_of(recorded: Option<&RecordedOptions>) -> Option<SvgDocumentOptions> {
    recorded.map(|o| SvgDocumentOptions {
        width: o.width,
        height: o.height,
        view_box: o.view_box.as_ref().map(|b| BoundingBox { x: b.x, y: b.y, w: b.w, h: b.h }),
        padding: o.padding,
        background: o.background.clone(),
        text_fill: o.text_fill.clone(),
        omit_legend: o.legend.as_deref() == Some("omit"),
        raster_scale: o.raster_scale,
    })
}

/// The records of a recording, one JSON object per line.
fn records(text: &str) -> Result<Vec<Record>, serde_json::Error> {
    text.lines().map(serde_json::from_str::<Record>).collect()
}

/// Where two strings first differ, with a little of each side of it.
fn first_difference(expected: &str, got: &str) -> String {
    let at = expected.chars().zip(got.chars()).take_while(|(a, b)| a == b).count();
    let window =
        |text: &str| text.chars().skip(at.saturating_sub(40)).take(120).collect::<String>();
    format!("at char {at}\n  expected: {}\n  got:      {}", window(expected), window(got))
}

fn keyed_disagreement(expected: &RecordedKeyed, got: &KeyedSvgRender) -> Option<String> {
    if expected.root_open != got.root_open {
        return Some(format!(
            "rootOpen\n{}",
            first_difference(&expected.root_open, &got.root_open)
        ));
    }
    let attrs: serde_json::Map<String, Value> =
        got.root_attrs.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    if expected.root_attrs != attrs {
        return Some(format!("rootAttrs {:?} against {attrs:?}", expected.root_attrs));
    }
    if expected.groups.len() != got.groups.len() {
        return Some(format!("{} groups, expected {}", got.groups.len(), expected.groups.len()));
    }
    for (want, have) in expected.groups.iter().zip(&got.groups) {
        if want.key != have.key || want.annotation != have.annotation {
            return Some(format!(
                "group key {:?} annotation {}, expected {:?} {}",
                have.key, have.annotation, want.key, want.annotation
            ));
        }
        if want.svg != have.svg {
            return Some(format!(
                "group {:?}\n{}",
                want.key,
                first_difference(&want.svg, &have.svg)
            ));
        }
    }
    None
}

fn disagreement(record: &Record) -> Option<String> {
    let scene: Scene = match serde_json::from_value(record.scene.clone()) {
        Ok(scene) => scene,
        Err(e) => return Some(format!("the scene is not read: {e}")),
    };
    let options = options_of(record.options.as_ref());
    match (
        render_scene_to_svg(&scene, options.as_ref()),
        render_scene_to_keyed_svg(&scene, options.as_ref()),
    ) {
        (Ok(svg), Ok(keyed)) if svg == record.svg => {
            keyed_disagreement(&record.keyed, &keyed).map(|d| format!("keyed: {d}"))
        }
        (Ok(svg), Ok(_)) => Some(format!("svg {}", first_difference(&record.svg, &svg))),
        (svg, keyed) => Some(format!("refused: {:?} {:?}", svg.err(), keyed.err())),
    }
}

/// Replays a recording: how many records it holds, and for each that was not
/// drawn as recorded, its id and the first difference.
pub(crate) fn replay(text: &str) -> Result<(usize, Vec<String>), String> {
    let all = records(text).map_err(|e| format!("the recording is not read: {e}"))?;
    let failures = all
        .iter()
        .filter_map(|record| disagreement(record).map(|why| format!("{}: {why}", record.id)))
        .collect();
    Ok((all.len(), failures))
}
