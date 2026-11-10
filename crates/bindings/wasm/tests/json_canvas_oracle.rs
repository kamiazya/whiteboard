//! The JSON Canvas exports against the recorded TypeScript answers.
//!
//! `packages/codec/src/spatial/oracle/json-canvas.jsonl` is what `parseSpatial`
//! and `serializeSpatial` answered; `crates/core/codec/tests/json_canvas_oracle.rs`
//! holds the codec to it, and this holds the exports' wire to it: the canvas as
//! the exports spell it, the issues of a refusal, the text of a write. A case
//! the codec declines is answered with a refusal here, and each is checked to
//! be an input that earns one.

use serde_json::{Value as Json, json};
use whiteboard_wasm::json_canvas::{json_canvas_parse, json_canvas_serialize};

fn recording() -> Vec<Json> {
    let text = include_str!("../../../../packages/codec/src/spatial/oracle/json-canvas.jsonl");
    text.lines().map(|l| serde_json::from_str(l).unwrap_or(Json::Null)).collect()
}

/// The recording's encoding of a value as the exports' wire.
fn wire(recorded: &Json) -> Json {
    match recorded {
        Json::Array(items) => {
            Json::Array(std::iter::once(json!("s")).chain(items.iter().map(wire)).collect())
        }
        Json::Object(object) => {
            if let Some(hex) = object.get("f") {
                return json!(["f", hex]);
            }
            if let Some(digits) = object.get("big") {
                return json!(["b", digits]);
            }
            let mut out = vec![json!("m")];
            for pair in object["m"].as_array().map_or(&[][..], Vec::as_slice) {
                out.push(pair[0].clone());
                out.push(wire(&pair[1]));
            }
            Json::Array(out)
        }
        scalar => scalar.clone(),
    }
}

/// A recorded canvas as a read answers it: the recording holds every object in
/// the contract's field order, and the TypeScript lifts an edge with its
/// `bends` after its `tags`, which the answer follows.
fn as_lifted(canvas: &Json) -> Json {
    let mut out = wire(canvas);
    let Some(parts) = out.as_array_mut() else { return out };
    let at = parts.iter().position(|p| p == "edges").map_or(0, |i| i + 1);
    let Some(edges) = parts.get_mut(at).and_then(Json::as_array_mut) else { return out };
    for edge in edges.iter_mut().skip(1) {
        let Some(pairs) = edge.as_array_mut() else { continue };
        if let Some(bends) = pairs.iter().position(|p| p == "bends") {
            let moved: Vec<Json> = pairs.drain(bends..bends + 2).collect();
            pairs.extend(moved);
        }
    }
    out
}

/// An answer's issues as the recording holds them, without a refinement's message.
fn bare(issues: &Json) -> Json {
    Json::Array(
        issues
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|issue| json!([issue[0], issue[1]]))
            .collect(),
    )
}

fn answer(text: &str) -> Json {
    serde_json::from_str(text).unwrap_or(Json::Null)
}

fn spells_surrogate(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["d8", "d9", "da", "db", "dc", "dd", "de", "df"]
        .iter()
        .any(|u| lower.contains(&format!("\\u{u}")))
}

/// The deepest `[` or `{` nesting of a text, ignoring what sits inside strings.
fn nesting(text: &str) -> usize {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for c in text.chars() {
        if in_string {
            match (escaped, c) {
                (true, _) => escaped = false,
                (false, '\\') => escaped = true,
                (false, '"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '[' | '{' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

#[test]
fn every_recorded_text_is_read_as_the_typescript_read_it() {
    let (mut read, mut refused, mut declined, mut problems) = (0usize, 0usize, 0usize, Vec::new());
    for case in recording().iter().filter(|c| c["k"] == "r") {
        let text = case["t"].as_str().unwrap_or_default();
        let got = answer(&json_canvas_parse(text));
        if got[0] == "refused" {
            // Only a surrogate escape or a deep nesting is declined; a link is judged.
            let earned = match got[2].as_str() {
                Some("lone-surrogate") => spells_surrogate(text),
                Some("too-deep") => nesting(text) > whiteboard_codec::json_canvas::MAX_DEPTH,
                _ => false,
            };
            if !earned {
                problems.push(format!("declined as {got} for {text:?}"));
            }
            declined += 1;
        } else if let Some(ok) = case.get("ok") {
            if got != json!(["ok", as_lifted(ok)]) {
                problems.push(format!("read {got} for {text:?}"));
            }
            read += 1;
        } else {
            let err = &case["err"];
            let class = err.get("class").cloned().unwrap_or(json!("syntax"));
            let issues = err.get("issues").cloned().unwrap_or(json!([]));
            let expected = json!(["err", err["stage"], class, issues]);
            let got =
                if got[0] == "err" { json!([got[0], got[1], got[2], bare(&got[3])]) } else { got };
            if got != expected {
                problems.push(format!("refused as {got}, expected {expected}, for {text:?}"));
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
    assert!(
        read > 650 && refused > 550 && (15..40).contains(&declined),
        "{read} {refused} {declined}"
    );
}

#[test]
fn every_recorded_canvas_is_written_as_the_typescript_wrote_it() {
    let (mut written, mut refused, mut problems) = (0usize, 0usize, Vec::new());
    for case in recording().iter().filter(|c| c["k"] == "w") {
        let canvas = wire(&case["c"]).to_string();
        let got = json_canvas_serialize(&canvas, case["m"] == "strict");
        if let Some(y) = case.get("y").and_then(Json::as_str) {
            if got == y {
                written += 1;
            } else {
                problems.push(format!("wrote {got:.200}, expected {y:.200}"));
            }
        } else if answer(&got)[0] == "schema" && bare(&answer(&got)[1]) == case["err"]["issues"] {
            refused += 1;
        } else {
            problems.push(format!("wrote {got:.200}, the strict mode refused {}", case["err"]));
        }
    }
    assert!(
        problems.is_empty(),
        "{} disagree, the first: {:#?}",
        problems.len(),
        &problems[..problems.len().min(5)]
    );
    assert!(written > 400 && refused > 80, "{written} {refused}");
}
