//! The facet write export against the recorded TypeScript answers.
//!
//! `packages/plugin-visual/src/oracle/facet-write.jsonl` is what the bundled
//! registry's `validateFacetWrite` answered; `crates/core/plugin-visual`
//! holds the registry to it, and this holds the export built over the same
//! registry to it, one recorded write at a time as a bucket of one key. Each
//! write targets a place its facet attaches to, so the registry is what
//! answers; the answer is the stage the TypeScript refused at (the key's
//! grammar, its version, the schema's issues in path and code and order, the
//! asset), or the stored value bit for bit, unless the payload held a key the
//! schema stripped, which the write path refuses. Whether the stripped key is
//! found is judged here from the recording alone, by a walk of the recorded
//! input against the recorded output.

use serde_json::{Value as Json, json};
use whiteboard_wasm::facet_write::facet_bucket_check;

const RECORDING: &str =
    include_str!("../../../../packages/plugin-visual/src/oracle/facet-write.jsonl");

/// The names a JavaScript `key in object` finds in any plain object.
const INHERITED: [&str; 12] = [
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

fn lines() -> Vec<Json> {
    RECORDING.lines().map(|line| serde_json::from_str(line).unwrap_or(Json::Null)).collect()
}

/// The export's wire for a recorded value: an integer or `{"f": hex}` is a
/// double's bits, a list is `["s", ...]` and `{"m": pairs}` is `["m", ...]`.
fn wire(recorded: &Json) -> Json {
    match recorded {
        Json::Number(n) => {
            json!(["f", format!("{:016x}", n.as_f64().unwrap_or(f64::NAN).to_bits())])
        }
        Json::Array(items) => {
            Json::Array(std::iter::once(json!("s")).chain(items.iter().map(wire)).collect())
        }
        Json::Object(object) => {
            if let Some(bits) = object.get("f") {
                return json!(["f", bits]);
            }
            let pairs = object["m"].as_array().map_or(&[][..], Vec::as_slice);
            let flat = pairs.iter().flat_map(|pair| [pair[0].clone(), wire(&pair[1])]);
            Json::Array(std::iter::once(json!("m")).chain(flat).collect())
        }
        scalar => scalar.clone(),
    }
}

fn pairs(recorded: &Json) -> Option<&Vec<Json>> {
    recorded.get("m")?.as_array()
}

/// The first key of `sent` that `kept` lost, as a path and a key, walking the
/// two recordings together in the sender's order.
fn stray(sent: &Json, kept: &Json, path: &mut Vec<String>) -> Option<(Vec<String>, String)> {
    if let (Some(sent), Some(kept)) = (sent.as_array(), kept.as_array()) {
        for (index, item) in sent.iter().enumerate() {
            let Some(counterpart) = kept.get(index) else { continue };
            path.push(index.to_string());
            let found = stray(item, counterpart, path);
            path.pop();
            if found.is_some() {
                return found;
            }
        }
        return None;
    }
    let (Some(sent), Some(kept)) = (pairs(sent), pairs(kept)) else { return None };
    for pair in sent {
        let key = pair[0].as_str().unwrap_or_default();
        let counterpart = kept.iter().find(|held| held[0] == pair[0]);
        let Some(counterpart) = counterpart else {
            if INHERITED.contains(&key) {
                continue;
            }
            return Some((path.clone(), key.to_owned()));
        };
        path.push(key.to_owned());
        let found = stray(&pair[1], &counterpart[1], path);
        path.pop();
        if found.is_some() {
            return found;
        }
    }
    None
}

/// An issue in the recording's detail spelling, as the export spells it.
fn issues(recorded: &Json) -> Json {
    Json::Array(
        recorded
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|issue| {
                let detail = &issue[2];
                let detail = if let Some(keys) = detail.get("keys") {
                    json!(["keys", keys])
                } else if let Some(arms) = detail.get("arms") {
                    let arms: Vec<Json> =
                        arms.as_array().map_or(&[][..], Vec::as_slice).iter().map(issues).collect();
                    json!(["arms", arms])
                } else if let Some(inner) = detail.get("key") {
                    json!(["key", issues(inner)])
                } else {
                    Json::Null
                };
                json!([issue[0], issue[1], detail])
            })
            .collect(),
    )
}

fn ids(header: &Json, kind: &str) -> Json {
    header["assets"][kind].clone()
}

/// What the export must answer for a recorded write.
fn expected(header: &Json, line: &Json) -> Json {
    let key = &line["key"];
    // A null payload is how a bucket deletes a key; no registry check is asked.
    if line["in"].is_null() {
        return json!(["ok", ["m"], ["s", key]]);
    }
    if let Some(stored) = line.get("ok") {
        return match stray(&line["in"], stored, &mut Vec::new()) {
            Some((path, stray)) => json!(["refused", key, "unrecognized-key", path, stray]),
            None => json!(["ok", ["m", key, wire(stored)], ["s"]]),
        };
    }
    let err = &line["err"];
    match err["stage"].as_str().unwrap_or_default() {
        "key" => json!(["refused", key, "malformed-key"]),
        "version" => json!(["refused", key, "not-current", err["current"]]),
        "schema" => json!(["refused", key, "invalid", issues(&err["issues"])]),
        _ => json!([
            "refused",
            key,
            "unregistered-asset",
            err["field"],
            err["id"],
            err["kind"],
            ids(header, err["kind"].as_str().unwrap_or_default())
        ]),
    }
}

/// A place the key's facet attaches to, whatever version the key names; any,
/// for a key the registry does not know.
fn target_of<'a>(lines: &'a [Json], key: &Json) -> &'a str {
    let facet = |key: &Json| key.as_str().and_then(|k| k.split('/').next()).map(str::to_owned);
    let declared = lines.iter().find(|line| {
        line["k"] == "t" && line["targets"].is_array() && facet(&line["key"]) == facet(key)
    });
    let first = declared.and_then(|line| line["targets"].get(0));
    first.and_then(Json::as_str).unwrap_or("node")
}

#[test]
fn the_export_answers_every_recorded_write_as_the_typescript_did() {
    let lines = lines();
    assert_eq!(lines.len(), RECORDING.lines().count(), "one JSON value per line");
    let header = lines.first().cloned().unwrap_or(Json::Null);
    assert_eq!(header["k"], "h");
    let (mut writes, mut refused, mut stripped, mut changed) = (0_usize, 0_usize, 0_usize, 0_usize);
    let (mut deleted, mut spelt) = (0_usize, String::new());
    for line in lines.iter().filter(|line| line["k"] == "w") {
        let bucket = json!(["m", line["key"], wire(&line["in"])]).to_string();
        let answer = facet_bucket_check(target_of(&lines, &line["key"]), &bucket, "[\"m\"]");
        spelt.push_str(&answer);
        let answer: Json = serde_json::from_str(&answer).unwrap_or(Json::Null);
        let want = expected(&header, line);
        assert_eq!(answer, want, "{line}");
        writes += 1;
        refused += usize::from(answer[0] == "refused");
        deleted += usize::from(line["in"].is_null());
        stripped += usize::from(answer[2] == "unrecognized-key");
        changed += usize::from(
            answer[0] == "ok" && answer[1] != json!(["m", line["key"], wire(&line["in"])]),
        );
    }
    for detail in ["[\"arms\",[[[", "[\"keys\",[", "[\"key\",[["] {
        assert!(spelt.contains(detail), "no answer carried an issue detail {detail}");
    }
    assert!(writes > 2000, "only {writes} writes were replayed");
    assert!(refused > 600, "only {refused} refusals were replayed");
    assert!(stripped > 20, "only {stripped} writes held a key the schema strips");
    assert!(deleted > 2, "only {deleted} writes were deletions");
    assert!(
        changed > 2,
        "only {changed} accepted writes were changed by their schema (a default filled)"
    );
}

#[test]
fn the_registrys_declarations_are_what_the_replay_targets() {
    // The replay trusts the recording's declarations to pick a target, so a
    // facet declared nowhere would be written to a target it may refuse.
    let lines = lines();
    let declared = lines.iter().filter(|line| line["k"] == "t" && line["targets"].is_array());
    assert!(declared.count() >= 11, "the bundled plugin's facets are all declared");
}
