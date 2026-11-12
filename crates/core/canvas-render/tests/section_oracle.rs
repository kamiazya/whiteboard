//! `select_markdown_section` against the recorded TypeScript answers: for each
//! document and fragment, which blocks of the root the section keeps, or none
//! (`section.jsonl`).

#[path = "typeset_support/model.rs"]
mod model;

use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::typeset::select_markdown_section;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    root: Value,
    fragment: String,
    range: Option<(usize, usize)>,
}

/// What differs for one record, or nothing.
fn replay(record: &Record) -> Result<(), String> {
    let root = model::root(&record.root)?;
    let got = select_markdown_section(&root, &record.fragment);
    let want = record.range.map(|(from, to)| root.children.get(from..to).unwrap_or_default());
    match (got.as_ref().map(|r| r.children.as_slice()), want) {
        (None, None) => Ok(()),
        (Some(got), Some(want)) if got == want => Ok(()),
        (got, want) => Err(format!(
            "{}: kept {:?} blocks, recorded {:?}",
            record.id,
            got.map(<[_]>::len),
            want.map(<[_]>::len)
        )),
    }
}

#[test]
fn every_recorded_fragment_names_the_section_the_typescript_named() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/section.jsonl");
    let records: Vec<Record> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    assert!(records.len() > 500, "the recording holds {} records", records.len());
    let failures: Vec<String> = records.iter().filter_map(|r| replay(r).err()).collect();
    assert!(failures.is_empty(), "{} differ; first: {:?}", failures.len(), failures.first());
}
