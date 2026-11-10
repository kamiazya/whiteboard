//! The registry's write path against the recorded answers of the TypeScript.
//!
//! `packages/plugin-visual/src/oracle/facet-write-recorded-oracle.test.ts`
//! writes `facet-write.jsonl` from the bundled registry and fails when the
//! file no longer equals what the TypeScript answers; this replays it. The
//! first line is the registered asset ids, a `"t"` line is what the registry
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

#[path = "common/contract.rs"]
mod contract;
#[path = "common/value.rs"]
mod value;

use compare::{issues_json, same};
use contract::from_json;
use serde_json::Value as Json;
use value::decode;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetDecl, FacetTarget, PluginManifest};
use whiteboard_facet_engine::registry::{Registry, WriteRefusal};
use whiteboard_facet_engine::schema::{Code, Contracts, Detail, External, Host, Issue};
use whiteboard_model::{Value, enumeration_order};
use whiteboard_plugin_visual::checks;

const RECORDING: &str =
    include_str!("../../../../packages/plugin-visual/src/oracle/facet-write.jsonl");
const MANIFEST: &str = include_str!("../../../../packages/plugin-visual/src/visual.manifest.json");
const CONTRACT: &str = include_str!("../../../../contracts/facets/visual/visual.schema.json");
const CONTRACT_PATH: &str = "facets/visual/visual.schema.json";

/// The model's `CanvasColor`, as its union answers: a preset or a six-digit
/// hex string. A string that is neither is refused by the hex arm alone (the
/// preset arm's refusal stops, the hex arm's does not, and a union whose one
/// live arm is unambiguous speaks with that arm's issues); anything else is
/// refused by both.
fn canvas_color(value: &Value) -> Result<Value, Vec<Issue>> {
    match value {
        Value::String(text) if checks::canvas_color(text) => Ok(value.clone()),
        Value::String(_) => Err(vec![Issue {
            path: Vec::new(),
            code: Code::InvalidFormat,
            detail: Detail::None,
            continues: true,
        }]),
        _ => {
            let arm = |code| {
                vec![Issue { path: Vec::new(), code, detail: Detail::None, continues: false }]
            };
            let arms = vec![arm(Code::InvalidValue), arm(Code::InvalidType)];
            Err(vec![Issue {
                path: Vec::new(),
                code: Code::InvalidUnion,
                detail: Detail::Arms(arms),
                continues: false,
            }])
        }
    }
}

fn host() -> Host<'static> {
    Host {
        matchers: &[
            ("namespaced_id", checks::namespaced_id),
            ("facet_key", checks::facet_key),
            ("tag_identifier", checks::tag_identifier),
            ("facet_segment", checks::facet_segment),
        ],
        checks: &[
            ("single_grapheme", checks::single_grapheme),
            ("canvas_color", checks::canvas_color),
        ],
        externals: &[
            ("EdgeRoutingStyle", External::AsWritten),
            ("LineJumps", External::AsWritten),
            ("CanvasColor", External::Validator(canvas_color)),
        ],
    }
}

fn text(json: &Json) -> String {
    json.as_str().unwrap_or_default().to_owned()
}

/// The plugin manifest as the registry reads it: what a facet is called,
/// where it attaches, which payload schema judges it and which fields name
/// assets. The editor and the compat chain are the derived form's.
fn manifest() -> PluginManifest {
    let json: Json = serde_json::from_str(MANIFEST).unwrap_or_default();
    let list = |value: &Json| value.as_array().map_or(Vec::new(), Clone::clone);
    let facet = |decl: &Json| FacetDecl {
        name: text(&decl["name"]),
        display_name: text(&decl["displayName"]),
        version: text(&decl["version"]),
        targets: list(&decl["targets"])
            .iter()
            .filter_map(|t| FacetTarget::from_wire(t.as_str()?))
            .collect(),
        schema: text(&decl["schema"]),
        asset_refs: decl["assetRefs"].as_object().map(|refs| {
            refs.iter()
                .filter_map(|(field, kind)| {
                    Some((field.clone(), AssetKind::from_wire(kind.as_str()?)?))
                })
                .collect()
        }),
        ..FacetDecl::default()
    };
    PluginManifest {
        id: text(&json["id"]),
        display_name: text(&json["displayName"]),
        facets: list(&json["facets"]).iter().map(facet).collect(),
        assets: None,
    }
}

fn ids(header: &Json, kind: AssetKind) -> Vec<String> {
    header["assets"][kind.as_str()]
        .as_array()
        .map_or(Vec::new(), |list| list.iter().map(text).collect())
}

fn registry(header: &Json) -> Option<Registry> {
    let contract = from_json(CONTRACT)?;
    let contracts = Contracts::load(&[(CONTRACT_PATH, &contract)], &host()).ok()?;
    Registry::build(&[manifest()], contracts, |kind| ids(header, kind)).ok()
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
    let registry = registry(&header).expect("the registry builds over the visual contract");
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
