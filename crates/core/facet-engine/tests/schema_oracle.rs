//! The interpreter against the recorded answers of the generated Zod.
//!
//! `packages/facet-engine/src/oracle/contract-schemas-recorded-oracle.test.ts`
//! writes `contract-schemas.jsonl` from the engine contract's asset schemas
//! and the plugin manifest, and fails when the file no longer equals what Zod
//! answers; this replays it. A case is `"s"`, the definition, `"in"`, the
//! input as `common` encodes a value, and `"ok"`, the value Zod parses it to,
//! or `"err"`, its issues as `[path, code, detail]`.
//!
//! The message is not recorded: the interpreter agrees with Zod on where and
//! why a value is refused, in order, and not on the sentence (owner decision
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
use whiteboard_facet_engine::checks;
use whiteboard_facet_engine::schema::{Contracts, Host};
use whiteboard_model::enumeration_order;

const RECORDING: &str =
    include_str!("../../../../packages/facet-engine/src/oracle/contract-schemas.jsonl");
const ENGINE: &str = include_str!("../../../../contracts/facets/engine/engine.schema.json");
const MANIFEST: &str = include_str!("../../../../contracts/plugin/plugin-manifest.schema.json");

/// The matchers the engine's own contracts name, which this crate holds.
fn host() -> Host<'static> {
    Host {
        matchers: &[
            ("namespaced_id", checks::namespaced_id),
            ("facet_key", checks::facet_key),
            ("hex_color", checks::hex_color),
            ("facet_segment", checks::facet_segment),
            ("version_tag", checks::version_tag),
            ("schema_ref", checks::schema_ref),
        ],
        checks: &[],
        externals: &[],
    }
}

#[test]
fn the_interpreter_answers_every_recorded_case_as_zod_did() {
    let engine = from_json(ENGINE).expect("the engine contract is JSON");
    let manifest = from_json(MANIFEST).expect("the manifest contract is JSON");
    let contracts = Contracts::load(
        &[
            ("facets/engine/engine.schema.json", &engine),
            ("plugin/plugin-manifest.schema.json", &manifest),
        ],
        &host(),
    )
    .expect("both contracts compile");
    let mut cases = 0_usize;
    let mut refused = 0_usize;
    for line in RECORDING.lines() {
        let case: Json = serde_json::from_str(line).expect("one JSON value per line");
        let name = case["s"].as_str().expect("a schema name");
        let file = if name == "PluginManifest" {
            "plugin/plugin-manifest.schema.json"
        } else {
            "facets/engine/engine.schema.json"
        };
        let def = contracts.resolve(&format!("{file}#/$defs/{name}")).expect("a definition");
        let input = decode(&case["in"]).expect("a recorded input");
        let answer = contracts.validate(def, &input);
        cases += 1;
        if let Some(expected) = case.get("ok") {
            let value =
                answer.unwrap_or_else(|issues| panic!("{line}\nrefused: {}", issues_json(&issues)));
            assert!(
                same(&enumeration_order(value), &decode(expected).expect("a recorded value")),
                "{line}"
            );
        } else {
            let issues = answer.expect_err(line);
            assert_eq!(issues_json(&issues), case["err"], "{line}");
            refused += 1;
        }
    }
    assert!(cases > 700, "only {cases} cases were replayed");
    assert!(refused > 200, "only {refused} refusals were replayed");
}
