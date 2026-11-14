//! The proposal layer against the recorded TypeScript answers: whether each
//! change still fits its board (`proposal-conflicts.jsonl`).

use std::collections::BTreeMap;

use serde::Deserialize;
use whiteboard_model::proposal::{ChangeOp, SpatialChange, canvas_change_conflicts};
use whiteboard_model::spatial::{ExtensionFacets, SpatialCanvas};
use whiteboard_model::{Value, json};

use crate::canvas_wire::{ElementWire, NodeWire, Res, canvas_parts};
use crate::proposal_wire::{ChangeWire, change_of};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CanvasWire {
    facets: Option<serde_json::Value>,
    nodes: Vec<NodeWire>,
    edges: Vec<ElementWire>,
    lines: Option<Vec<ElementWire>>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ConflictRecord {
    Board { name: String, canvas: CanvasWire },
    Case { board: String, change: Box<ChangeWire>, conflicts: bool },
}

/// `value` at `path`, a key per mapping and an index per sequence.
fn at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, step| match value {
        Value::Map(entries) => entries.iter().find(|(key, _)| key == step).map(|(_, v)| v),
        Value::Seq(items) => items.get(step.parse::<usize>().ok()?),
        _ => None,
    })
}

/// The facets bucket at `path` in the order the recording wrote it.
/// `serde_json`'s own map sorts its keys, so a bucket read through it reaches
/// the comparison in one order whatever the TypeScript held — and a recorded
/// prior whose keys are in another order than its board's would pin nothing.
fn written(record: &Value, path: &[&str]) -> Option<ExtensionFacets> {
    match at(record, path)? {
        Value::Map(entries) => Some(entries.clone()),
        _ => None,
    }
}

/// The board with every element's facets in written order.
fn board_in_written_order(mut canvas: SpatialCanvas, record: &Value) -> SpatialCanvas {
    for (i, node) in canvas.nodes.iter_mut().enumerate() {
        node.facets = written(record, &["canvas", "nodes", &i.to_string(), "facets"]);
    }
    for (i, edge) in canvas.edges.iter_mut().enumerate() {
        edge.facets = written(record, &["canvas", "edges", &i.to_string(), "facets"]);
    }
    for (i, line) in canvas.lines.iter_mut().flatten().enumerate() {
        line.facets = written(record, &["canvas", "lines", &i.to_string(), "facets"]);
    }
    canvas
}

/// The change with its patch's and prior's facets in written order.
fn change_in_written_order(mut change: SpatialChange, record: &Value) -> SpatialChange {
    let patch = written(record, &["change", "patch", "facets"]);
    let prior = written(record, &["change", "assumed", "facets"]);
    match &mut change {
        SpatialChange::EdgePatch { patch: p, assumed, .. } => {
            (p.facets, assumed.facets) = (patch, prior);
        }
        SpatialChange::LinePatch { patch: p, assumed, .. } => {
            (p.facets, assumed.facets) = (patch, prior);
        }
        SpatialChange::NodeRemove { assumed, .. } => assumed.facets = prior,
        SpatialChange::EdgeRemove { assumed, .. } => assumed.facets = prior,
        SpatialChange::LineRemove { assumed, .. } => assumed.facets = prior,
        _ => {}
    }
    change
}

fn replay_conflicts(text: &str) -> Res<usize> {
    let mut boards: BTreeMap<String, SpatialCanvas> = BTreeMap::new();
    let mut cases = 0;
    for (line, json) in text.lines().enumerate() {
        let record: ConflictRecord =
            serde_json::from_str(json).map_err(|e| format!("line {line}: {e}"))?;
        let ordered = json::parse(json).map_err(|e| format!("line {line}: {e:?}"))?;
        match record {
            ConflictRecord::Board { name, canvas } => {
                let c = &canvas;
                let parts = canvas_parts(c.facets.as_ref(), &c.nodes, &c.edges, c.lines.as_deref());
                boards.insert(name, board_in_written_order(parts?, &ordered));
            }
            ConflictRecord::Case { board, change, conflicts } => {
                let canvas = boards.get(&board).ok_or(format!("no board {board}"))?;
                let ChangeOp::Spatial(spatial) = change_of(&change)?.op else {
                    return Err(format!("line {line}: a passage change"));
                };
                let got =
                    canvas_change_conflicts(&change_in_written_order(*spatial, &ordered), canvas);
                if got != conflicts {
                    return Err(format!("line {line} ({board}): got {got}, recorded {conflicts}"));
                }
                cases += 1;
            }
        }
    }
    Ok(cases)
}

#[test]
fn every_recorded_conflict_verdict_is_reproduced() {
    let text =
        include_str!("../../../../../packages/canvas-render/src/oracle/proposal-conflicts.jsonl");
    assert_eq!(replay_conflicts(text), Ok(1527));
}
