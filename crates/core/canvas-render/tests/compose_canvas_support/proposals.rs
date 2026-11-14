//! The proposal layer against the recorded TypeScript answers: whether each
//! change still fits its board (`proposal-conflicts.jsonl`).

use std::collections::BTreeMap;

use serde::Deserialize;
use whiteboard_model::proposal::{ChangeOp, canvas_change_conflicts};
use whiteboard_model::spatial::SpatialCanvas;

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

fn replay_conflicts(text: &str) -> Res<usize> {
    let mut boards: BTreeMap<String, SpatialCanvas> = BTreeMap::new();
    let mut cases = 0;
    for (line, json) in text.lines().enumerate() {
        let record: ConflictRecord =
            serde_json::from_str(json).map_err(|e| format!("line {line}: {e}"))?;
        match record {
            ConflictRecord::Board { name, canvas } => {
                let c = &canvas;
                let parts = canvas_parts(c.facets.as_ref(), &c.nodes, &c.edges, c.lines.as_deref());
                boards.insert(name, parts?);
            }
            ConflictRecord::Case { board, change, conflicts } => {
                let canvas = boards.get(&board).ok_or(format!("no board {board}"))?;
                let ChangeOp::Spatial(spatial) = change_of(&change)?.op else {
                    return Err(format!("line {line}: a passage change"));
                };
                let got = canvas_change_conflicts(&spatial, canvas);
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
    assert_eq!(replay_conflicts(text), Ok(1470));
}
