//! The line jumps (`compute_edge_jumps`) against the recorded TypeScript
//! answers (`edge-jumps.jsonl`): over each board, every hop and the edge it is
//! drawn on, in the order the TypeScript's map holds them, to the last bit.

use serde_json::{Value, json};
use whiteboard_edge_routing::edge_jumps::{EdgePath, compute_edge_jumps};
use whiteboard_edge_routing::geometry::Point;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

type Res<T> = Result<T, String>;

fn f64_of(hex: &Value) -> Res<f64> {
    let hex = hex.as_str().ok_or_else(|| format!("{hex} is not a hex double"))?;
    u64::from_str_radix(hex, 16).map(f64::from_bits).map_err(|e| format!("{hex}: {e}"))
}

fn array(value: &Value) -> Res<&Vec<Value>> {
    value.as_array().ok_or_else(|| format!("{value} is not an array"))
}

fn hex(value: f64) -> String {
    let value = if value.is_nan() { f64::NAN } else { value };
    format!("{:016x}", value.to_bits())
}

fn edge_of(edge: &Value) -> Res<(String, Vec<Point>)> {
    let id = edge[0].as_str().ok_or("an edge id")?.to_owned();
    let path = array(&edge[1])?
        .iter()
        .map(|p| Ok(Point { x: f64_of(&p[0])?, y: f64_of(&p[1])? }))
        .collect::<Res<_>>()?;
    Ok((id, path))
}

fn replay(record: &Value) -> Res<Value> {
    let edges: Vec<(String, Vec<Point>)> =
        array(&record["edges"])?.iter().map(edge_of).collect::<Res<_>>()?;
    let paths: Vec<EdgePath<'_>> = edges.iter().map(|(id, path)| EdgePath { id, path }).collect();
    let jumps: Vec<Value> = compute_edge_jumps(&paths)
        .iter()
        .map(|(id, points)| {
            json!([
                id,
                points.iter().map(|p| json!([p.segment, hex(p.x), hex(p.y)])).collect::<Vec<_>>()
            ])
        })
        .collect();
    Ok(json!({ "id": record["id"], "edges": record["edges"], "jumps": jumps }))
}

/// The first path at which two JSON values part, for a readable failure.
fn first_difference(path: &str, got: &Value, want: &Value) -> Option<String> {
    match (got, want) {
        (Value::Array(g), Value::Array(w)) if g.len() == w.len() => g
            .iter()
            .zip(w)
            .enumerate()
            .find_map(|(i, (g, w))| first_difference(&format!("{path}[{i}]"), g, w)),
        (Value::Object(g), Value::Object(w)) if g.len() == w.len() => {
            w.iter().find_map(|(k, w)| first_difference(&format!("{path}.{k}"), &g[k.as_str()], w))
        }
        _ if got == want => None,
        _ => {
            let short = |v: &Value| v.to_string().chars().take(400).collect::<String>();
            Some(format!("{path}: got {}, recorded {}", short(got), short(want)))
        }
    }
}

#[test]
fn every_recorded_hop_is_reproduced_to_the_last_bit() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/edge-jumps.jsonl");
    let records: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    let failures: Vec<String> = records
        .iter()
        .filter_map(|record| {
            let id = record["id"].as_str().unwrap_or("?");
            match replay(record) {
                Ok(got) => first_difference(id, &got, record),
                Err(e) => Some(format!("{id}: {e}")),
            }
        })
        .collect();
    assert!(records.len() > 10, "{} records", records.len());
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
}
