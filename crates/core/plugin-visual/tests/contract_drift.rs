//! Every contract file the repository ships, compiled by the interpreter.
//!
//! The facet and plugin contracts are the interpreter's own: each must
//! compile, because a manifest's payload schemas are those files. The model's
//! contracts use constructs only the model port implements, so each must be
//! refused by naming one, with every matcher, check and external it names
//! supplied, so that nothing else can be the reason. A new construct in a
//! contract that the interpreter does not know turns a green compile into a
//! named refusal here, instead of a payload that is judged by a schema with a
//! rule quietly missing.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::plugin::ENGINE_HOST;
use whiteboard_facet_engine::schema::{Contracts, External, Host, Predicate, Refusal};
use whiteboard_model::Value;
use whiteboard_model::json;
use whiteboard_plugin_visual::host::VISUAL_HOST;

const CONTRACTS: [(&str, &str); 6] = [
    (
        "facets/engine/engine.schema.json",
        include_str!("../../../../contracts/facets/engine/engine.schema.json"),
    ),
    (
        "facets/visual/visual.schema.json",
        include_str!("../../../../contracts/facets/visual/visual.schema.json"),
    ),
    (
        "plugin/plugin-manifest.schema.json",
        include_str!("../../../../contracts/plugin/plugin-manifest.schema.json"),
    ),
    (
        "geometry/geometry.schema.json",
        include_str!("../../../../contracts/geometry/geometry.schema.json"),
    ),
    ("model/okf.schema.json", include_str!("../../../../contracts/model/okf.schema.json")),
    ("model/spatial.schema.json", include_str!("../../../../contracts/model/spatial.schema.json")),
];

/// Every string under `key`, at any depth, in the order the contract reads.
fn named(node: &Value, key: &str, out: &mut Vec<String>) {
    match node {
        Value::Map(entries) => {
            for (name, value) in entries {
                match value {
                    Value::String(text) if name == key => out.push(text.clone()),
                    other => named(other, key, out),
                }
            }
        }
        Value::Seq(items) => items.iter().for_each(|item| named(item, key, out)),
        _ => {}
    }
}

/// The names of the definitions that carry `x-wb-external`.
fn externals(contract: &Value) -> Vec<String> {
    let Value::Map(top) = contract else { return Vec::new() };
    let Some((_, Value::Map(defs))) = top.iter().find(|(name, _)| name == "$defs") else {
        return Vec::new();
    };
    let carries =
        |def: &Value| matches!(def, Value::Map(m) if m.iter().any(|(k, _)| k == "x-wb-external"));
    defs.iter().filter(|(_, def)| carries(def)).map(|(name, _)| name.clone()).collect()
}

#[test]
fn the_facet_and_plugin_contracts_compile_with_what_their_hosts_supply() {
    let matchers = [ENGINE_HOST.matchers, VISUAL_HOST.matchers].concat();
    let host =
        Host { matchers: &matchers, checks: VISUAL_HOST.checks, externals: VISUAL_HOST.externals };
    let owned: Vec<(&str, Value)> = CONTRACTS
        .iter()
        .take(4)
        .map(|(path, text)| (*path, json::parse(text).expect("a contract is JSON")))
        .collect();
    let loaded: Vec<(&str, &Value)> = owned.iter().map(|(path, value)| (*path, value)).collect();
    let set = Contracts::load(&loaded, &host);
    assert!(set.is_ok(), "{:?}", set.err());
    let set = set.expect("compiled");
    for pointer in [
        "facets/engine/engine.schema.json#/$defs/ThemeTokens",
        "facets/visual/visual.schema.json#/$defs/VisualSymbolFacet",
        "plugin/plugin-manifest.schema.json#/$defs/PluginManifest",
        "geometry/geometry.schema.json#/$defs/Point",
    ] {
        assert!(set.resolve(pointer).is_some(), "{pointer}");
    }
}

#[test]
fn each_model_contract_is_refused_by_the_construct_only_the_model_port_has() {
    for (path, text) in &CONTRACTS[4..] {
        let contract = json::parse(text).expect("a contract is JSON");
        let (mut matchers, mut checks) = (Vec::new(), Vec::new());
        named(&contract, "x-wb-matcher", &mut matchers);
        named(&contract, "x-wb-check", &mut checks);
        let accept: Predicate = |_| true;
        let matchers: Vec<(&str, Predicate)> =
            matchers.iter().map(|m| (m.as_str(), accept)).collect();
        let checks: Vec<(&str, Predicate)> = checks.iter().map(|c| (c.as_str(), accept)).collect();
        let supplied = externals(&contract);
        let externals: Vec<(&str, External)> =
            supplied.iter().map(|n| (n.as_str(), External::AsWritten)).collect();
        let host = Host { matchers: &matchers, checks: &checks, externals: &externals };
        let refused = Contracts::load(&[(path, &contract)], &host).err();
        let reason = refused.as_ref().map(|error| error.refusal.clone());
        assert!(matches!(reason, Some(Refusal::ModelOnly(_))), "{path}: {refused:?}");
    }
}
