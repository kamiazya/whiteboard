//! The comment placement primitives against the recorded TypeScript answers
//! (`comment-placement.jsonl`): the candidate boxes, the least-covered pick, the
//! leader's end on a bubble's corner and the point of a polyline nearest a pin,
//! each double compared by its bits.

use serde::Deserialize;
use whiteboard_canvas_render::comments::placement::{
    comment_bubble_candidates, comment_leader_end, nearest_point_on_polyline, place_comment_bubble,
};
use whiteboard_scene::{BoundingBox, ScenePoint};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Record {
    Candidates {
        anchor: [String; 2],
        size: [String; 2],
        answer: Vec<[String; 4]>,
    },
    Place {
        anchor: [String; 2],
        size: [String; 2],
        obstacles: Vec<[String; 4]>,
        answer: [String; 4],
    },
    Leader {
        anchor: [String; 2],
        bubble: [String; 4],
        radius: String,
        answer: [String; 2],
    },
    Nearest {
        point: [String; 2],
        path: Vec<[String; 2]>,
        answer: [String; 2],
    },
}

type Res<T> = Result<T, String>;

fn f64_of(hex: &str) -> Res<f64> {
    u64::from_str_radix(hex, 16).map(f64::from_bits).map_err(|e| format!("{hex}: {e}"))
}

/// A double's bits, every NaN the canonical one.
fn hex(value: f64) -> String {
    let value = if value.is_nan() { f64::NAN } else { value };
    format!("{:016x}", value.to_bits())
}

fn point_of([x, y]: &[String; 2]) -> Res<ScenePoint> {
    Ok(ScenePoint { x: f64_of(x)?, y: f64_of(y)? })
}

fn box_of([x, y, w, h]: &[String; 4]) -> Res<BoundingBox> {
    Ok(BoundingBox { x: f64_of(x)?, y: f64_of(y)?, w: f64_of(w)?, h: f64_of(h)? })
}

fn point_hex(point: ScenePoint) -> [String; 2] {
    [hex(point.x), hex(point.y)]
}

fn box_hex(bbox: &BoundingBox) -> [String; 4] {
    [hex(bbox.x), hex(bbox.y), hex(bbox.w), hex(bbox.h)]
}

/// The record's answer, and what the port answers to the same question.
fn replay(record: &Record) -> Res<(Vec<String>, Vec<String>)> {
    Ok(match record {
        Record::Candidates { anchor, size: [w, h], answer } => {
            let got = comment_bubble_candidates(point_of(anchor)?, f64_of(w)?, f64_of(h)?);
            (answer.concat(), got.iter().flat_map(box_hex).collect())
        }
        Record::Place { anchor, size: [w, h], obstacles, answer } => {
            let obstacles = obstacles.iter().map(box_of).collect::<Res<Vec<_>>>()?;
            let got = place_comment_bubble(point_of(anchor)?, f64_of(w)?, f64_of(h)?, &obstacles);
            (answer.to_vec(), box_hex(&got).to_vec())
        }
        Record::Leader { anchor, bubble, radius, answer } => {
            let got = comment_leader_end(point_of(anchor)?, &box_of(bubble)?, f64_of(radius)?);
            (answer.to_vec(), point_hex(got).to_vec())
        }
        Record::Nearest { point, path, answer } => {
            let path = path.iter().map(point_of).collect::<Res<Vec<_>>>()?;
            let got = nearest_point_on_polyline(point_of(point)?, &path);
            (answer.to_vec(), point_hex(got).to_vec())
        }
    })
}

#[test]
fn every_recorded_placement_is_reproduced_to_the_last_bit() {
    let text =
        include_str!("../../../../packages/canvas-render/src/oracle/comment-placement.jsonl");
    let mut kinds = [0_usize; 4];
    let mut failures = Vec::new();
    for (at, line) in text.lines().enumerate() {
        let record: Record =
            serde_json::from_str(line).unwrap_or_else(|e| panic!("line {}: {e}", at + 1));
        let kind = match record {
            Record::Candidates { .. } => 0,
            Record::Place { .. } => 1,
            Record::Leader { .. } => 2,
            Record::Nearest { .. } => 3,
        };
        if let Some(count) = kinds.get_mut(kind) {
            *count += 1;
        }
        match replay(&record) {
            Ok((want, got)) if want == got => {}
            Ok((want, got)) => {
                failures.push(format!("line {}: got {got:?}, recorded {want:?}", at + 1));
            }
            Err(e) => failures.push(format!("line {}: {e}", at + 1)),
        }
    }
    assert!(kinds.iter().all(|&count| count >= 3), "{kinds:?}");
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
}
