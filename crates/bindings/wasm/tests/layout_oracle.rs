//! `layout_spatial_canvas` against the recorded TypeScript answers.
//!
//! canvas-render's `layout-recorded-oracle.test.ts` writes one file per topic,
//! `packages/canvas-render/src/test-utils/wasm/oracle/layout-spatial-canvas.<topic>.jsonl`:
//! per layout, the request as the shim sends it and what the TypeScript composer
//! laid out for it, spelled as the core spells an answer. This replays every
//! request of every topic file through the export, so the request decoder, the
//! reference host, the composer and the answer's writer are judged natively by
//! the TypeScript's answers (QR-17). Compared as JSON values, every double read
//! back exactly.

use std::path::Path;

use serde_json::Value;
use whiteboard_wasm::spatial_layout::layout_spatial_canvas;

/// The first place two values part, as a JSON pointer.
fn first_difference(a: &Value, b: &Value, at: &str) -> Option<String> {
    match (a, b) {
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (p, q))| first_difference(p, q, &format!("{at}/{i}"))),
        (Value::Object(x), Value::Object(y)) if x.len() == y.len() => {
            x.iter().find_map(|(k, p)| {
                y.get(k).map_or_else(
                    || Some(format!("{at}/{k}")),
                    |q| first_difference(p, q, &format!("{at}/{k}")),
                )
            })
        }
        _ => (a != b).then(|| at.to_owned()),
    }
}

#[test]
fn every_recorded_layout_is_answered_as_the_typescript_answered_it() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/canvas-render/src/test-utils/wasm/oracle");
    let entries = std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            name.strip_prefix("layout-spatial-canvas.")
                .and_then(|rest| rest.strip_suffix(".jsonl"))
                .is_some()
        })
        .collect();
    names.sort();
    let files: Vec<String> = names
        .iter()
        .map(|name| {
            std::fs::read_to_string(dir.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
        })
        .collect();
    assert!(files.len() > 1, "{} topic files", files.len());
    let mut failures = Vec::new();
    let mut compared = 0_usize;
    for line in files.iter().flat_map(|text| text.lines()) {
        let record: Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}"));
        let field = |key: &str| record.get(key).and_then(Value::as_str).unwrap_or_default();
        let got: Value = serde_json::from_str(&layout_spatial_canvas(field("request"), &[]))
            .unwrap_or(Value::Null);
        let want: Value = serde_json::from_str(field("answer")).unwrap_or(Value::Null);
        compared += usize::from(want.get(0) == Some(&Value::from("ok")));
        if let Some(at) = first_difference(&got, &want, "") {
            let part = |v: &Value| v.pointer(&at).map(ToString::to_string).unwrap_or_default();
            failures.push(format!(
                "{} at {at}: got {} recorded {}",
                field("id"),
                part(&got),
                part(&want)
            ));
        }
    }
    assert!(compared > 60, "{compared} layouts answered");
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
}
