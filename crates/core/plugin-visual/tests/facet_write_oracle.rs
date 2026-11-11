//! The registry's write path against the recorded answers of the TypeScript.
//!
//! `packages/plugin-visual/src/oracle/facet-write-recorded-oracle.test.ts`
//! writes `facet-write.jsonl` from the bundled registry and fails when the
//! file no longer equals what the TypeScript answers; this replays it against
//! the registry the crate loads from the same files (`visual_registry`). The
//! first line is the registered asset ids, which the loaded registry must
//! hold exactly, a `"t"` line is what the registry
//! says of a key (where it attaches, which fields name assets), and a `"w"`
//! line is a write: `"key"`, `"in"` as `common` encodes a value, and `"ok"`,
//! the value stored, or `"err"` naming the `stage` that refused it: `key`,
//! `version` (and the `current` key), `schema` (each issue as
//! `[path, code, detail]`) or `asset` (the `field`, `id` and `kind`).
//!
//! The message is not recorded: the Rust registry agrees with Zod on where and
//! why a payload is refused, in order, and not on the sentence (owner decision
//! q43, `docs/contributing/parity/facet-engine.md`).

#[path = "common/compare.rs"]
mod compare;

#[path = "common/value.rs"]
mod value;

use compare::{issues_json, same};
use serde_json::Value as Json;
use value::decode;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::plugin_manifest::AssetKind;
use whiteboard_facet_engine::registry::{Registry, WriteRefusal};
use whiteboard_model::enumeration_order;
use whiteboard_plugin_visual::host::visual_registry;

const RECORDING: &str =
    include_str!("../../../../packages/plugin-visual/src/oracle/facet-write.jsonl");

fn text(json: &Json) -> String {
    json.as_str().unwrap_or_default().to_owned()
}

fn ids(header: &Json, kind: AssetKind) -> Vec<String> {
    header["assets"][kind.as_str()]
        .as_array()
        .map_or(Vec::new(), |list| list.iter().map(text).collect())
}

fn lines() -> Vec<Json> {
    RECORDING.lines().filter_map(|line| serde_json::from_str(line).ok()).collect()
}

fn check_declaration(registry: &Registry, line: &Json) {
    let key = line["key"].as_str().unwrap_or_default();
    let targets =
        registry.targets_of(key).map(|t| t.iter().map(|t| t.as_str()).collect::<Vec<_>>());
    let expected: Option<Vec<&str>> =
        line["targets"].as_array().map(|list| list.iter().filter_map(Json::as_str).collect());
    assert_eq!(targets, expected, "{line}");
    let refs: Vec<(&str, &str)> = registry
        .asset_refs_of(key)
        .unwrap_or_default()
        .iter()
        .map(|(field, kind)| (field.as_str(), kind.as_str()))
        .collect();
    let expected: Vec<(&str, &str)> = line["refs"].as_array().map_or(Vec::new(), |pairs| {
        pairs.iter().filter_map(|pair| Some((pair[0].as_str()?, pair[1].as_str()?))).collect()
    });
    assert_eq!(refs, expected, "{line}");
}

/// Why a write's answer is not the recorded one, or `Ok` when it is.
fn check_write(registry: &Registry, header: &Json, line: &Json) -> Result<(), String> {
    let key = line["key"].as_str().unwrap_or_default();
    let payload = decode(&line["in"]).ok_or("an undecodable input")?;
    let answer = registry.validate_facet_write(key, &payload);
    if let Some(expected) = line.get("ok") {
        let stored = answer.map_err(|refusal| format!("refused: {refusal:?}"))?;
        let expected = decode(expected).ok_or("an undecodable value")?;
        return same(&enumeration_order(stored), &expected)
            .then_some(())
            .ok_or("another value".into());
    }
    let refusal = answer.err().ok_or("accepted")?;
    let err = &line["err"];
    let agreed = match (err["stage"].as_str().unwrap_or_default(), &refusal) {
        ("key", WriteRefusal::MalformedKey) => true,
        ("version", WriteRefusal::NotCurrentVersion { current }) => {
            err["current"] == current.as_str()
        }
        ("schema", WriteRefusal::Invalid(issues)) => issues_json(issues) == err["issues"],
        ("asset", WriteRefusal::UnregisteredAsset { field, id, kind, registered }) => {
            err["field"] == field.as_str()
                && err["id"] == id.as_str()
                && err["kind"] == kind.as_str()
                && *registered == ids(header, *kind)
        }
        _ => false,
    };
    agreed.then_some(()).ok_or(format!("refused as {refusal:?}"))
}

#[test]
fn the_registry_answers_every_recorded_key_and_write_as_the_typescript_did() {
    let lines = lines();
    assert_eq!(lines.len(), RECORDING.lines().count(), "one JSON value per line");
    let header = lines.first().expect("a header").clone();
    assert_eq!(header["k"], "h");
    let registry = visual_registry().expect("the bundled plugin loads");
    for kind in [AssetKind::Themes, AssetKind::Icons, AssetKind::Stencils] {
        assert_eq!(registry.registered(kind), ids(&header, kind), "{}", kind.as_str());
    }
    let (mut declarations, mut writes, mut refused) = (0_usize, 0_usize, 0_usize);
    for line in &lines {
        match line["k"].as_str() {
            Some("t") => {
                check_declaration(&registry, line);
                declarations += 1;
            }
            Some("w") => {
                let verdict = check_write(&registry, &header, line);
                assert!(verdict.is_ok(), "{line}\n{verdict:?}");
                writes += 1;
                refused += usize::from(line.get("err").is_some());
            }
            _ => {}
        }
    }
    assert!(declarations > 10, "only {declarations} declarations were replayed");
    assert!(writes > 2000, "only {writes} writes were replayed");
    assert!(refused > 600, "only {refused} refusals were replayed");
}
