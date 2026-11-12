//! `fit_blocks_to_height` and `first_line_of_blocks` against the recorded
//! TypeScript answers (`fit.jsonl`): for each laid-out body, what is kept at each
//! height and as a first line, as a digest of its canonical text and the two
//! signals, and as text for the scenes written by hand.

#[path = "typeset_support/dump.rs"]
mod dump;

use dump::dump_scene;
use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::typeset::{FittedBlocks, first_line_of_blocks, fit_blocks_to_height};
use whiteboard_scene::{Scene, SceneNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    height: Option<String>,
    n: usize,
    h: u32,
    truncated: bool,
    overflows: bool,
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    nodes: Value,
    fits: Vec<Answer>,
    first: Answer,
}

fn fnv(text: &str) -> u32 {
    text.encode_utf16()
        .fold(0x811c_9dc5_u32, |state, unit| (state ^ u32::from(unit)).wrapping_mul(16_777_619))
}

/// How a kept body differs from what was recorded, or `Ok`.
fn check(kept: FittedBlocks, want: &Answer) -> Result<(), String> {
    let text = dump_scene(&Scene { nodes: kept.nodes, legend: None })?;
    let got = (text.encode_utf16().count(), fnv(&text), kept.truncated, kept.overflows);
    let held = (want.n, want.h, want.truncated, want.overflows);
    if got != held {
        return Err(format!("kept {got:?}, recorded {held:?}\n{text}"));
    }
    match &want.text {
        Some(recorded) if *recorded != text => Err(format!("text differs\n{text}\n{recorded}")),
        _ => Ok(()),
    }
}

fn replay(record: &Record) -> Result<(), String> {
    let nodes: Vec<SceneNode> =
        serde_json::from_value(record.nodes.clone()).map_err(|e| e.to_string())?;
    for fit in &record.fits {
        let hex = fit.height.as_deref().ok_or("a height")?;
        let height = f64::from_bits(u64::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
        check(fit_blocks_to_height(&nodes, height), fit).map_err(|e| format!("at {hex}: {e}"))?;
    }
    check(first_line_of_blocks(&nodes), &record.first).map_err(|e| format!("first line: {e}"))
}

#[test]
fn every_recorded_body_is_cut_as_the_typescript_cut_it() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/fit.jsonl");
    let records: Vec<Record> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    assert!(records.len() > 200, "the recording holds {} records", records.len());
    let failures: Vec<String> =
        records.iter().filter_map(|r| replay(r).err().map(|e| format!("{}: {e}", r.id))).collect();
    assert!(failures.is_empty(), "{} differ; first: {:?}", failures.len(), failures.first());
}
