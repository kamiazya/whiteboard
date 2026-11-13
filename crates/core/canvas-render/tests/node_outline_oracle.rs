//! A silhouette's hit test and edge anchoring (`outline_contains`,
//! `outline_entry_point`) against the recorded TypeScript answers
//! (`node-outline.jsonl`): for every bundled silhouette and an unknown id, over
//! ordinary, degenerate and non-finite boxes, whether each point is inside and
//! where each approach's terminal lands, to the last bit.

use serde::Deserialize;
use whiteboard_canvas_render::node_outline::{outline_contains, outline_entry_point};
use whiteboard_scene::{BoundingBox, ScenePoint};

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

fn point_of(x: &str, y: &str) -> Res<ScenePoint> {
    Ok(ScenePoint { x: f64_of(x)?, y: f64_of(y)? })
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Record {
    Contains {
        shape: String,
        #[serde(rename = "box")]
        bbox: [String; 4],
        points: Vec<[String; 2]>,
        inside: String,
    },
    Entry {
        shape: String,
        #[serde(rename = "box")]
        bbox: [String; 4],
        approaches: Vec<[String; 6]>,
    },
}

fn box_of(wire: &[String; 4]) -> Res<BoundingBox> {
    let [x, y, w, h] = wire;
    Ok(BoundingBox { x: f64_of(x)?, y: f64_of(y)?, w: f64_of(w)?, h: f64_of(h)? })
}

fn replay_contains(
    shape: &str,
    bbox: &BoundingBox,
    points: &[[String; 2]],
    inside: &str,
) -> Res<()> {
    let got: String = points
        .iter()
        .map(|[x, y]| Ok(if outline_contains(shape, bbox, point_of(x, y)?) { '1' } else { '0' }))
        .collect::<Res<_>>()?;
    if got == inside { Ok(()) } else { Err(format!("inside: got {got}, recorded {inside}")) }
}

fn replay_entry(shape: &str, bbox: &BoundingBox, approaches: &[[String; 6]]) -> Res<()> {
    for [fx, fy, tx, ty, lx, ly] in approaches {
        let landed = outline_entry_point(shape, bbox, point_of(fx, fy)?, point_of(tx, ty)?);
        let got = [hex(landed.x), hex(landed.y)];
        if got != [lx.clone(), ly.clone()] {
            return Err(format!(
                "from ({fx}, {fy}) to ({tx}, {ty}): got {got:?}, recorded ({lx}, {ly})"
            ));
        }
    }
    Ok(())
}

fn replay(record: &Record) -> Res<()> {
    match record {
        Record::Contains { shape, bbox, points, inside } => {
            replay_contains(shape, &box_of(bbox)?, points, inside)
                .map_err(|e| format!("{shape}: {e}"))
        }
        Record::Entry { shape, bbox, approaches } => {
            replay_entry(shape, &box_of(bbox)?, approaches).map_err(|e| format!("{shape}: {e}"))
        }
    }
}

#[test]
fn every_recorded_hit_test_and_anchor_is_reproduced_to_the_last_bit() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/node-outline.jsonl");
    let records: Vec<Record> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    let failures: Vec<String> = records
        .iter()
        .enumerate()
        .filter_map(|(at, record)| replay(record).err().map(|e| format!("line {}: {e}", at + 1)))
        .collect();
    assert!(records.len() > 100, "{} records", records.len());
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
}
