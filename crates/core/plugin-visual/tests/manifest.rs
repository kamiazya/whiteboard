//! The bundled plugin's manifest instance, read as the data it is: it parses,
//! it is the `visual` plugin, and every schema it points at is a definition of
//! the contract it names. Runs on both targets, so the Rust core and the
//! TypeScript read the same file.

use serde_json::Value;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::checks::{facet_segment, namespaced_id, schema_ref, version_tag};
use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetTarget, PickerLayout};

const MANIFEST: &str = include_str!("../../../../packages/plugin-visual/src/visual.manifest.json");
const CONTRACT: &str = include_str!("../../../../contracts/facets/visual/visual.schema.json");
const CONTRACT_PATH: &str = "facets/visual/visual.schema.json";

/// A file that is not JSON reads as null, which every test below refuses.
fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

fn facets(manifest: &Value) -> &[Value] {
    manifest["facets"].as_array().map_or(&[], Vec::as_slice)
}

/// The definition a pointer names, provided it points into the visual contract.
fn definition_of(pointer: &str) -> Option<&str> {
    pointer.strip_prefix(CONTRACT_PATH)?.strip_prefix("#/$defs/")
}

#[test]
fn the_manifest_is_the_visual_plugin_with_eleven_facets() {
    let manifest = parse(MANIFEST);
    assert_eq!(manifest["id"], "visual");
    assert_eq!(manifest["displayName"], "Visual style");
    assert_eq!(facets(&manifest).len(), 11);
}

#[test]
fn every_facet_is_named_versioned_and_attached_in_the_contract_grammar() {
    let manifest = parse(MANIFEST);
    assert!(facet_segment(manifest["id"].as_str().expect("an id")));
    let mut seen = Vec::new();
    for facet in facets(&manifest) {
        let name = facet["name"].as_str().expect("a name");
        assert!(facet_segment(name), "{name}");
        assert!(!seen.contains(&name), "{name} is declared twice");
        seen.push(name);
        assert!(version_tag(facet["version"].as_str().expect("a version")), "{name}");
        let targets = facet["targets"].as_array().expect("targets");
        assert!(!targets.is_empty(), "{name}");
        for target in targets {
            let target = target.as_str().expect("a target");
            assert!(FacetTarget::from_wire(target).is_some(), "{name}: {target}");
        }
        for kind in facet["assetRefs"].as_object().into_iter().flat_map(|refs| refs.values()) {
            assert!(AssetKind::from_wire(kind.as_str().expect("a kind")).is_some(), "{name}");
        }
        let layout = &facet["editor"]["picker"]["layout"];
        if let Some(layout) = layout.as_str() {
            assert!(PickerLayout::from_wire(layout).is_some(), "{name}: {layout}");
        }
    }
}

#[test]
fn every_schema_pointer_names_a_definition_of_the_visual_contract() {
    let manifest = parse(MANIFEST);
    let contract = parse(CONTRACT);
    let defs = contract["$defs"].as_object().expect("the contract has definitions");
    let mut pointers = 0_usize;
    for facet in facets(&manifest) {
        let compat = facet["compat"].as_object().into_iter().flat_map(|entries| entries.values());
        for entry in std::iter::once(facet).chain(compat) {
            let pointer = entry["schema"].as_str().expect("a schema pointer");
            assert!(schema_ref(pointer), "{pointer}");
            let definition = definition_of(pointer).expect("points into the visual contract");
            assert!(defs.contains_key(definition), "{pointer}");
            pointers = pointers.saturating_add(1);
        }
    }
    assert!(pointers >= 11, "only {pointers} pointers were read");
}

#[test]
fn the_pointer_helper_refuses_a_pointer_outside_the_visual_contract() {
    assert_eq!(definition_of("facets/visual/visual.schema.json#/$defs/X"), Some("X"));
    assert_eq!(definition_of("facets/demo/demo.schema.json#/$defs/X"), None);
    assert_eq!(definition_of("facets/visual/visual.schema.json#/defs/X"), None);
}

#[test]
fn the_assets_name_host_tables_and_the_catalog_names_its_loader() {
    let manifest = parse(MANIFEST);
    let assets = manifest["assets"].as_object().expect("assets");
    for kind in ["themes", "icons", "stencils"] {
        let name = assets[kind].as_str().expect("a table name");
        assert!(namespaced_id(name), "{kind}: {name}");
    }
    let symbol =
        facets(&manifest).iter().find(|facet| facet["name"] == "symbol").expect("the symbol facet");
    let source = symbol["editor"]["picker"]["catalog"]["source"].as_str().expect("a source");
    assert!(namespaced_id(source));
}
