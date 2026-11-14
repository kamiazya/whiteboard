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

fn replay_legend(record: &LegendRecord) -> Res<()> {
    let registry = visual_registry().map_err(|e| format!("{e:?}"))?;
    let canvas = canvas_of(&record.canvas)?;
    let channels = colour_channels(&canvas, &registry);
    let want = |r: &Reading| (r.usage.clone(), r.carried_by.clone());
    differ("boxes", &reading_of(&channels.boxes), &want(&record.boxes))?;
    differ("edges", &reading_of(&channels.edges), &want(&record.edges))?;
    let light = create_spatial_theme(SpatialThemeMode::Light, None);
    differ("light", &canvas_legend(&canvas, &light, &registry), &record.light)?;
    let dark = create_spatial_theme(SpatialThemeMode::Dark, None);
    differ("dark", &canvas_legend(&canvas, &dark, &registry), &record.dark)
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
