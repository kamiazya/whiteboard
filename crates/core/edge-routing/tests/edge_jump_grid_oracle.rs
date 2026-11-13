//! The line jumps' broad phase (`place`, `SegmentGrid`) against the recorded
//! TypeScript answers (`edge-jump-grid.jsonl`): over each board, driven as
//! `computeEdgeJumps` drives it, where every run is placed, which levels and
//! cells each reaches, which runs it is handed as candidates, and the work
//! counted after each step, to the last bit — through to the budget being
//! spent.

use serde_json::{Value, json};
use whiteboard_det::format::js_number_to_string;
use whiteboard_edge_routing::edge_jumps::grid::{Placed, Reach, SegmentGrid, place};
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

fn placed_wire(p: Option<&Placed>) -> Value {
    p.map_or(Value::Null, |p| {
        json!([p.level, hex(p.min_x), hex(p.max_x), hex(p.min_y), hex(p.max_y)])
    })
}

fn reach_wire(reached: &[Reach]) -> Value {
    let key = |(x, y): &(u64, u64)| {
        let at = |bits: u64| js_number_to_string(f64::from_bits(bits));
        format!("{},{}", at(*x), at(*y))
    };
    reached
        .iter()
        .map(|r| json!([r.level, u8::from(r.own), r.keys.iter().map(key).collect::<Vec<_>>()]))
        .collect()
}

/// Sorted indices as inclusive runs of consecutive ones.
fn ranges(indices: &[usize]) -> Value {
    let mut out: Vec<[usize; 2]> = Vec::new();
    for &i in indices {
        match out.last_mut() {
            Some(last) if last[1] + 1 == i => last[1] = i,
            _ => out.push([i, i]),
        }
    }
    json!(out)
}

/// One edge as `computeEdgeJumps` takes it; answers whether the budget is spent.
fn step_edge(grid: &mut SegmentGrid, runs: &[Option<Placed>], steps: &mut Vec<Value>) -> bool {
    let reached: Vec<Option<Vec<Reach>>> =
        runs.iter().map(|p| p.as_ref().map(|p| grid.reach(p))).collect();
    let work_after_reach = grid.work();
    let mut spent = false;
    let candidates: Vec<Value> = reached
        .iter()
        .map(|r| match r {
            Some(r) if !spent => grid.candidates(r).map_or_else(
                || {
                    spent = true;
                    json!("spent")
                },
                |found| ranges(&found),
            ),
            _ => Value::Null,
        })
        .collect();
    steps.push(json!({
        "reached": reached.iter().map(|r| r.as_deref().map_or(Value::Null, reach_wire)).collect::<Vec<_>>(),
        "workAfterReach": work_after_reach,
        "candidates": candidates,
        "workAfter": grid.work(),
    }));
    for r in reached.iter().flatten() {
        grid.add(r);
    }
    spent
}

fn run_of(run: &Value) -> Res<Option<Placed>> {
    let point = |x: &Value, y: &Value| Ok::<_, String>(Point { x: f64_of(x)?, y: f64_of(y)? });
    Ok(place(point(&run[0], &run[1])?, point(&run[2], &run[3])?))
}

fn replay(record: &Value) -> Res<Value> {
    let placed: Vec<Vec<Option<Placed>>> = array(&record["edges"])?
        .iter()
        .map(|runs| array(runs)?.iter().map(run_of).collect())
        .collect::<Res<_>>()?;
    let mut grid = SegmentGrid::new(placed.iter().flatten().flatten());
    let mut steps = Vec::new();
    for runs in &placed {
        if step_edge(&mut grid, runs, &mut steps) {
            break;
        }
    }
    let placed_wires: Vec<Vec<Value>> =
        placed.iter().map(|runs| runs.iter().map(|p| placed_wire(p.as_ref())).collect()).collect();
    Ok(
        json!({ "id": record["id"], "edges": record["edges"], "placed": placed_wires, "steps": steps }),
    )
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
        _ => Some(format!("{path}: got {got}, recorded {want}")),
    }
}

#[test]
fn every_recorded_placement_reach_and_candidate_list_is_reproduced_to_the_last_bit() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/edge-jump-grid.jsonl");
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
