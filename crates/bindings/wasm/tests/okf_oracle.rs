//! The OKF exports against the recorded TypeScript answers.
//!
//! `packages/codec/src/okf/oracle/okf.jsonl` is what `parseOkf` and
//! `serializeOkf` answered; `crates/core/codec/tests/okf_oracle.rs` holds the
//! codec to it, and this holds the exports' wire to it: the frontmatter as
//! the exports spell it, the body offset in UTF-16 units, the text before the
//! body. A case holding a lone surrogate cannot cross into a Rust string and
//! is skipped here; the shim refuses one before calling, and
//! `packages/codec`'s wasm differential holds that.

use serde_json::{Value as Json, json};
use whiteboard_wasm::okf::{okf_parse, okf_serialize};

fn recording() -> Vec<Json> {
    let text = include_str!("../../../../packages/codec/src/okf/oracle/okf.jsonl");
    text.lines().map(|l| serde_json::from_str(l).unwrap_or(Json::Null)).collect()
}

/// The recording's encoding of a value as the exports' wire, or `None` when
/// it holds a lone surrogate.
fn wire(recorded: &Json) -> Option<Json> {
    Some(match recorded {
        Json::Array(items) => {
            let items: Option<Vec<Json>> = items.iter().map(wire).collect();
            Json::Array(std::iter::once(json!("s")).chain(items?).collect())
        }
        Json::Object(object) => {
            if object.contains_key("u") {
                return None;
            }
            if let Some(hex) = object.get("f") {
                return Some(json!(["f", hex]));
            }
            if let Some(digits) = object.get("big") {
                return Some(json!(["b", digits]));
            }
            let mut out = vec![json!("m")];
            for pair in object["m"].as_array()? {
                out.push(pair[0].as_str().map(|k| json!(k))?);
                out.push(wire(&pair[1])?);
            }
            Json::Array(out)
        }
        scalar => scalar.clone(),
    })
}

fn field<'a>(object: &'a Json, name: &str) -> &'a Json {
    let pairs = object["m"].as_array().map_or(&[][..], Vec::as_slice);
    pairs.iter().find(|p| p[0] == name).map_or(&Json::Null, |p| &p[1])
}

fn issues(err: &Json) -> Json {
    err.get("issues").cloned().unwrap_or(json!([]))
}

/// The recording holds an issue's path and code; the words Zod gives it are
/// held by the shim's own test against the artifact, so what follows the code
/// on the wire is dropped before the comparison.
fn without_detail(mut answer: Json) -> Json {
    if let Some(issues) = answer.get_mut(3).and_then(Json::as_array_mut) {
        for issue in issues {
            if let Some(parts) = issue.as_array_mut() {
                parts.truncate(2);
            }
        }
    }
    answer
}

#[test]
fn every_recorded_text_is_read_as_the_typescript_read_it() {
    let (mut read, mut refused, mut problems) = (0usize, 0usize, Vec::new());
    for case in recording().iter().filter(|c| c["k"] == "r" && c.get("lone").is_none()) {
        let text = case["t"].as_str().unwrap_or_default();
        let answer: Json = serde_json::from_str(&okf_parse(text, 0)).unwrap_or(Json::Null);
        let answer = without_detail(answer);
        if let Some(ok) = case.get("ok") {
            let body = field(ok, "body").as_str().unwrap_or_default();
            let offset = answer[1].as_u64().unwrap_or(u64::MAX);
            let units: Vec<u16> =
                text.encode_utf16().skip(usize::try_from(offset).unwrap_or(usize::MAX)).collect();
            let expected = wire(field(ok, "frontmatter"));
            if answer[0] != "ok"
                || String::from_utf16_lossy(&units) != body
                || Some(&answer[2]) != expected.as_ref()
            {
                problems.push(format!("read {answer} for {text:?}"));
            }
            read += 1;
        } else {
            let err = &case["err"];
            let expected = json!(["err", err["stage"], err["class"], issues(err)]);
            if answer != expected {
                problems.push(format!("refused as {answer}, expected {expected}, for {text:?}"));
            }
            refused += 1;
        }
    }
    assert!(
        problems.is_empty(),
        "{} disagree, the first: {:#?}",
        problems.len(),
        &problems[..problems.len().min(5)]
    );
    assert!(read > 250 && refused > 700, "{read} read, {refused} refused");
}

#[test]
fn every_recorded_document_is_written_as_the_typescript_wrote_it() {
    let (mut written, mut unwritable, mut declined, mut problems) =
        (0usize, 0usize, 0usize, Vec::new());
    for case in recording().iter().filter(|c| c["k"] == "w") {
        let Some(frontmatter) = wire(field(&case["d"], "frontmatter")) else { continue };
        let answer: Json =
            serde_json::from_str(&okf_serialize(&frontmatter.to_string())).unwrap_or(Json::Null);
        // Recorded documents the schema would not hold, or built in another key
        // order, are not this wire's to write; the shim answers them from the
        // TypeScript.
        if answer == json!(["refused", "malformed"]) {
            declined += 1;
            continue;
        }
        if let Some(y) = case.get("y").and_then(Json::as_str) {
            let body = field(&case["d"], "body").as_str().unwrap_or_default();
            let text = format!("{}{body}", answer[1].as_str().unwrap_or_default());
            if answer[0] != "ok" || text != y {
                problems.push(format!("wrote {answer}, expected {y:?}"));
            }
            written += 1;
        } else {
            if answer[0] != "unwritable" {
                problems.push(format!("wrote {answer}, the TypeScript refused: {}", case["d"]));
            }
            unwritable += 1;
        }
    }
    assert!(
        problems.is_empty(),
        "{} disagree, the first: {:#?}",
        problems.len(),
        &problems[..problems.len().min(5)]
    );
    assert!(written > 420 && unwritable > 25, "{written} written, {unwritable} refused");
    assert!((1..30).contains(&declined), "{declined} documents declined");
}
