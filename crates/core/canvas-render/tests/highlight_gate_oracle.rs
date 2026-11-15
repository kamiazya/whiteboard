//! `would_colour` against the recorded TypeScript answers: for each fence's
//! language and value, and the tokenizer account it is called against,
//! whether the default highlighter colours it and what the account holds
//! after (`highlight-gate.jsonl`).

use serde::Deserialize;
use whiteboard_canvas_render::highlight::would_colour;
use whiteboard_canvas_render::typeset::NestedLayoutBudget;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(deny_unknown_fields)]
struct Account {
    word: u64,
    line: u64,
    refused: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    lang: String,
    value: Vec<(String, usize)>,
    budget: Option<Account>,
    colours: bool,
    after: Option<Account>,
}

fn account_of(budget: &NestedLayoutBudget) -> Account {
    let (word, line) = budget.tokenizer_remaining();
    Account { word, line, refused: budget.refused() }
}

/// What differs for one record, or nothing.
fn replay(record: &Record) -> Result<(), String> {
    let value: String = record.value.iter().map(|(piece, n)| piece.repeat(*n)).collect();
    let budget =
        record.budget.map(|a| NestedLayoutBudget::new().with_tokenizer(a.word, a.line, a.refused));
    let colours = would_colour(&record.lang, &value, budget.as_ref());
    let after = budget.as_ref().map(account_of);
    if (colours, after) == (record.colours, record.after) {
        return Ok(());
    }
    Err(format!(
        "{}: colours {colours} after {after:?}, recorded {} {:?}",
        record.id, record.colours, record.after
    ))
}

#[test]
fn every_recorded_fence_is_gated_as_the_typescript_gated_it() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/highlight-gate.jsonl");
    let records: Vec<Record> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    assert!(records.len() > 500, "the recording holds {} records", records.len());
    let failures: Vec<String> = records.iter().filter_map(|r| replay(r).err()).collect();
    assert!(failures.is_empty(), "{} differ; first: {:?}", failures.len(), failures.first());
}
