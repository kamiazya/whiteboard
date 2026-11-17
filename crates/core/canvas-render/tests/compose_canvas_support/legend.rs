//! The legend against the recorded TypeScript answers (`canvas-legend.jsonl`):
//! what the colour channel of the boxes and of the edges is doing and which
//! declared distinctions carry it, and the legend derived from that under the
//! light and the dark theme.

use serde::Deserialize;
use whiteboard_canvas_render::legend::canvas_legend;
use whiteboard_canvas_render::legend::channels::{ChannelUse, colour_channels};
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_plugin_visual::host::visual_registry;
use whiteboard_scene::SceneLegend;

use crate::canvas_wire::{Res, differ};
use crate::seams::{CanvasWire, canvas_of};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reading {
    #[serde(rename = "use")]
    usage: String,
    carried_by: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegendRecord {
    name: String,
    canvas: CanvasWire,
    boxes: Reading,
    edges: Reading,
    light: Option<SceneLegend>,
    dark: Option<SceneLegend>,
}

fn reading_of(usage: &ChannelUse) -> (String, Vec<String>) {
    match usage {
        ChannelUse::Unused => ("unused".to_owned(), Vec::new()),
        ChannelUse::Contested => ("contested".to_owned(), Vec::new()),
        ChannelUse::Carried(by) => ("carried".to_owned(), by.clone()),
    }
}

/// The recordings that list a scoped tag written under a built-in
/// partition's name (`frame:west`) as the key carrying the colour, when what
/// carried it was the partition itself. The TypeScript did, and the recording
/// is frozen; the legend lists only scoped-tag keys, so the replay expects
/// these with that key dropped.
const CORRECTED: [&str; 2] = ["frame-carried", "sweep-99"];

/// The partitions the boxes hold under their own name, spelled here rather
/// than read from the code the replay judges.
const BUILT_IN: [&str; 3] = ["frame", "kind", "stencil"];

fn lists_a_built_in(legend: Option<&SceneLegend>) -> bool {
    legend.is_some_and(|l| l.keys.iter().any(|k| BUILT_IN.contains(&k.key.as_str())))
}

/// `recorded` less any key named after a built-in partition, and no legend
/// when that leaves nothing to say.
fn corrected(recorded: Option<&SceneLegend>) -> Option<SceneLegend> {
    let mut legend = recorded?.clone();
    legend.keys.retain(|k| !BUILT_IN.contains(&k.key.as_str()));
    let says = !legend.keys.is_empty() || legend.uncarried.boxes || legend.uncarried.edges;
    says.then_some(legend)
}

/// What the replay expects of one theme's legend: the recording, or for a
/// [`CORRECTED`] record, the recording corrected, which must differ from it
/// so the list cannot outlive what it corrects.
fn expected(record: &LegendRecord, recorded: Option<&SceneLegend>) -> Res<Option<SceneLegend>> {
    let listed = CORRECTED.contains(&record.name.as_str());
    if listed != lists_a_built_in(recorded) {
        let state =
            if listed { "corrected, lists no built-in" } else { "lists a built-in, uncorrected" };
        return Err(state.to_owned());
    }
    Ok(if listed { corrected(recorded) } else { recorded.cloned() })
}

fn replay_legend(record: &LegendRecord) -> Res<()> {
    let registry = visual_registry().map_err(|e| format!("{e:?}"))?;
    let canvas = canvas_of(&record.canvas)?;
    let channels = colour_channels(&canvas, &registry);
    let want = |r: &Reading| (r.usage.clone(), r.carried_by.clone());
    differ("boxes", &reading_of(&channels.boxes), &want(&record.boxes))?;
    differ("edges", &reading_of(&channels.edges), &want(&record.edges))?;
    let light = create_spatial_theme(SpatialThemeMode::Light, None);
    let want_light = expected(record, record.light.as_ref())?;
    differ("light", &canvas_legend(&canvas, &light, &registry), &want_light)?;
    let dark = create_spatial_theme(SpatialThemeMode::Dark, None);
    let want_dark = expected(record, record.dark.as_ref())?;
    differ("dark", &canvas_legend(&canvas, &dark, &registry), &want_dark)
}

#[test]
fn every_recorded_legend_is_reproduced() {
    let text = include_str!("../../../../../packages/canvas-render/src/oracle/canvas-legend.jsonl");
    let failures: Vec<String> = text
        .lines()
        .map(|json| serde_json::from_str::<LegendRecord>(json).map_err(|e| e.to_string()))
        .filter_map(|record| {
            let record =
                record.and_then(|r| replay_legend(&r).map_err(|e| format!("{}: {e}", r.name)));
            record.err()
        })
        .collect();
    assert_eq!(text.lines().count(), 185);
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
}
