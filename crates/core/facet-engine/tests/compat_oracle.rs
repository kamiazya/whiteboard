//! The registry's read path against the recorded answers of the TypeScript.
//!
//! `packages/facet-engine/src/oracle/compat-recorded-oracle.test.ts` writes
//! `compat.jsonl` from a small plugin whose facets carry compat chains, and
//! fails when the file no longer equals what `resolveFacetPayload` answers. This
//! loads the same manifest, its payload schemas as a contract and the same
//! migrations, and replays every line exactly: the outcome and the value.

#[path = "common/value.rs"]
mod value;

use serde_json::Value as Json;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::plugin::{PluginSources, build};
use whiteboard_facet_engine::registry::{BuildError, Migration, Registry, Resolution};
use whiteboard_facet_engine::schema::Host;
use whiteboard_model::Value;

const RECORDING: &str = include_str!("../../../../packages/facet-engine/src/oracle/compat.jsonl");
const MANIFEST: &str = include_str!(
    "../../../../packages/facet-engine/src/test-utils/compat-oracle/demo.manifest.json"
);
const CONTRACT: &str = include_str!(
    "../../../../packages/facet-engine/src/test-utils/compat-oracle/demo.contract.json"
);

const NO_HOST: Host<'static> = Host { matchers: &[], checks: &[], externals: &[] };

fn get<'v>(value: &'v Value, name: &str) -> Option<&'v Value> {
    let Value::Map(entries) = value else { return None };
    entries.iter().find(|(key, _)| key == name).map(|(_, found)| found)
}

fn map(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn note_first(old: &Value) -> Value {
    map(vec![("title", get(old, "body").cloned().unwrap_or_default())])
}

fn note_second(old: &Value) -> Value {
    let title = get(old, "title").cloned().unwrap_or_default();
    let text = if title == Value::String("x".to_owned()) { Value::Number(1.0) } else { title };
    map(vec![("text", text), ("size", Value::Number(1.0)), ("extra", Value::Bool(true))])
}

fn gap_old(old: &Value) -> Value {
    map(vec![("k", get(old, "old").cloned().unwrap_or_default())])
}

const MIGRATIONS: &[(&str, Migration)] =
    &[("demo.note-v1", note_first), ("demo.note-v2", note_second), ("demo.gap-v0", gap_old)];

fn registry_with(manifest: &str, migrations: &[(&str, Migration)]) -> Result<Registry, String> {
    let contracts = [("facets/demo/demo.schema.json", CONTRACT)];
    build(&PluginSources { manifest, contracts: &contracts, tables: &[], migrations }, &NO_HOST)
        .map_err(|e| format!("{e:?}"))
}

fn answer(resolution: &Resolution) -> (&'static str, Option<&Value>) {
    match resolution {
        Resolution::Resolved(value) => ("resolved", Some(value)),
        Resolution::Dropped => ("dropped", None),
        Resolution::Preserved(payload) => ("preserved", Some(payload)),
        Resolution::Passthrough(payload) => ("passthrough", Some(payload)),
    }
}

#[test]
fn every_recorded_read_resolves_as_the_typescript_resolved_it() {
    let registry = registry_with(MANIFEST, MIGRATIONS).expect("the demo plugin loads");
    let mut replayed = 0;
    for line in RECORDING.lines() {
        let line: Json = serde_json::from_str(line).expect("a recorded line");
        let key = line["key"].as_str().expect("a key");
        let payload = value::decode(&line["in"]).expect("a payload");
        let expected = line.get("value").map(|value| value::decode(value).expect("a value"));
        let resolution = registry.resolve_facet_payload(key, &payload);
        let (out, value) = answer(&resolution);
        assert_eq!(out, line["out"].as_str().expect("an outcome"), "{line}");
        assert_eq!(value, expected.as_ref(), "{line}");
        replayed += 1;
    }
    assert_eq!(replayed, 260, "every recorded line replayed");
}

#[test]
fn a_migration_the_host_does_not_supply_refuses_the_plugin() {
    let without = &MIGRATIONS[..2];
    let expected = BuildError::MissingMigration {
        plugin: "demo".to_owned(),
        facet: "gap".to_owned(),
        name: "demo.gap-v0".to_owned(),
    };
    assert_eq!(registry_with(MANIFEST, without).err(), Some(format!("Registry({expected:?})")));
}

#[test]
fn a_retained_schema_no_contract_holds_refuses_the_plugin() {
    let manifest = MANIFEST.replacen("$defs/GapOld", "$defs/Absent", 1);
    let expected = BuildError::UnresolvedSchema {
        plugin: "demo".to_owned(),
        facet: "gap".to_owned(),
        pointer: "facets/demo/demo.schema.json#/$defs/Absent".to_owned(),
    };
    assert_eq!(registry_with(&manifest, MIGRATIONS).err(), Some(format!("Registry({expected:?})")));
}

/// Past 2^53 adding one to a version changes nothing, so the TypeScript's walk
/// from such a version never ends; the port stops after one step per entry.
#[test]
fn a_walk_that_cannot_advance_is_dropped() {
    let manifest = MANIFEST
        .replacen("\"version\": \"v2\"", "\"version\": \"v9007199254740994\"", 1)
        .replacen("\"v0\": {", "\"v9007199254740992\": {", 1);
    let registry = registry_with(&manifest, MIGRATIONS).expect("it loads");
    let payload = map(vec![("old", Value::String("o".to_owned()))]);
    let key = "demo.gap/v9007199254740992";
    assert_eq!(registry.resolve_facet_payload(key, &payload), Resolution::Dropped);
    let current = map(vec![("k", Value::String("k".to_owned()))]);
    assert_eq!(
        registry.resolve_facet_payload("demo.gap/v9007199254740994", &current),
        Resolution::Resolved(current.clone())
    );
}
