//! `tidy_nodes` against the recorded TypeScript answers.
//!
//! `packages/canvas-render/src/oracle/tidy.jsonl` holds what `tidyNodes` answered
//! over the drawing corpus (`drawing`), every distinct call the package's tidy
//! suites make (`test`), the ceilings (`extra`) and seeded boards (`seeded`). A
//! record holds its input, so this needs no corpus: every record is tidied again
//! and its moves must equal the recorded ones, in order, number for number.

use std::collections::BTreeSet;

use serde::Deserialize;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::tidy::{TidyMove, TidyNode, TidyOptions, tidy_nodes};

const RECORDING: &str = include_str!("../../../../packages/canvas-render/src/oracle/tidy.jsonl");

/// The recorded boards whose answer this core DELIBERATELY changes, pinned by
/// count and by id so neither a new difference nor a stale entry passes.
///
/// The TypeScript charged the tidy budget for the frame walk's pairs and levels
/// but not for a unit's scoop, which asks a node about every frame it holds so
/// far: 1100 frames each strictly inside the last cost about 220 million
/// comparisons across the walk, past what the budget meant to allow, and the
/// same walk over 2000 frames ran for minutes. The core charges those
/// comparisons to the `nesting` account, so this board degrades earlier than
/// the recording (a scoop it cannot afford stops short and the frames it did not
/// reach stand as units of their own). Every other recorded board spends
/// within the account and answers as recorded.
const CORRECTED_SCOOP_BUDGET: [&str; 1] = ["extra/past-level-budget"];

/// A number JSON cannot hold is written by name.
#[derive(Deserialize)]
#[serde(untagged)]
enum Num {
    Number(f64),
    Name(String),
}

impl Num {
    fn value(&self) -> f64 {
        match self {
            Num::Number(n) => *n,
            Num::Name(name) => match name.as_str() {
                "nan" => f64::NAN,
                "inf" => f64::INFINITY,
                _ => f64::NEG_INFINITY,
            },
        }
    }
}

type Row = (String, u8, Num, Num, Num, Num);

/// `[id, x, y]`, or `[id, x, y, width, height]` for a frame that grew.
type Move = (String, Vec<f64>);

#[derive(Deserialize)]
#[serde(tag = "k", rename_all = "lowercase")]
enum Record {
    Meta { boards: usize },
    Drawing(Case),
    Test(Case),
    Extra(Case),
    Seeded(Case),
}

#[derive(Deserialize)]
struct Case {
    id: String,
    nodes: Vec<Row>,
    scope: Option<Vec<String>>,
    locked: Option<Vec<String>>,
    edges: Option<Vec<(Option<String>, Option<String>)>>,
    m: Vec<serde_json::Value>,
}

impl Case {
    fn nodes(&self) -> Vec<TidyNode> {
        self.nodes
            .iter()
            .map(|(id, frame, x, y, w, h)| TidyNode {
                id: id.clone(),
                frame: *frame == 1,
                x: x.value(),
                y: y.value(),
                width: w.value(),
                height: h.value(),
            })
            .collect()
    }

    fn options(&self) -> TidyOptions {
        TidyOptions {
            scope: self.scope.as_ref().map(|ids| ids.iter().cloned().collect::<BTreeSet<_>>()),
            locked: self.locked.iter().flatten().cloned().collect(),
            edges: self.edges.clone(),
        }
    }

    /// The recorded moves.
    fn recorded(&self) -> Vec<Move> {
        self.m
            .iter()
            .map(|m| {
                let parts = m.as_array().map_or(&[][..], Vec::as_slice);
                let id = parts.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
                let numbers = parts.iter().skip(1).filter_map(serde_json::Value::as_f64).collect();
                (id, numbers)
            })
            .collect()
    }
}

fn answered(moves: &[TidyMove]) -> Vec<Move> {
    moves
        .iter()
        .map(|m| {
            let mut numbers = vec![m.x, m.y];
            numbers.extend(m.size.iter().flat_map(|(w, h)| [*w, *h]));
            (m.id.clone(), numbers)
        })
        .collect()
}

fn cases() -> Result<(Vec<Case>, usize), serde_json::Error> {
    let mut boards = 0;
    let mut cases = Vec::new();
    for line in RECORDING.lines() {
        match serde_json::from_str::<Record>(line)? {
            Record::Meta { boards: n } => boards = n,
            Record::Drawing(c) | Record::Test(c) | Record::Extra(c) | Record::Seeded(c) => {
                cases.push(c);
            }
        }
    }
    Ok((cases, boards))
}

#[test]
fn every_recorded_board_is_tidied_to_the_recorded_moves() {
    let (cases, boards) = cases().expect("the recording is read");
    assert!(cases.len() > 2200, "the recording holds {} cases", cases.len());
    assert_eq!(cases.iter().filter(|c| c.id.starts_with("seeded/")).count(), boards);
    let mut differing: Vec<&str> = Vec::new();
    for case in &cases {
        let got = answered(&tidy_nodes(&case.nodes(), &case.options()));
        if got != case.recorded() {
            differing.push(&case.id);
        }
    }
    assert_eq!(differing, CORRECTED_SCOOP_BUDGET, "boards answering other than recorded");
    assert_eq!(differing.len(), 1);
}
