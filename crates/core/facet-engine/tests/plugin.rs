//! A plugin loaded from its files: what the manifest reader decodes, what the
//! registry then says, and every way a load is refused, stage by stage.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::manifest;
use whiteboard_facet_engine::plugin::{
    ENGINE_HOST, LoadError, PluginSources, build, engine_contracts,
};
use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetTarget};
use whiteboard_facet_engine::registry::BuildError;
use whiteboard_facet_engine::schema::{Code, Contracts, Host};
use whiteboard_model::json::{self, Refusal};

const THEMES: &str = include_str!("../../../../packages/plugin-visual/src/assets/themes.json");
const ICONS: &str = r#"{"star": {"geometry": [{"tag": "path", "d": "M0 0"}]}}"#;
const MORE_ICONS: &str = r#"{"arrow": {"viewBox": "0 0 8 8", "geometry": [{"tag": "circle", "cx": 1, "cy": 1, "r": 1}]}}"#;
const STENCILS: &str =
    r#"{"box": {"displayName": "Box", "facets": {"demo.mark/v0": {"theme": "demo.sketch"}}}}"#;

const CONTRACT: &str = r#"{
  "$schema": "x",
  "$defs": { "Mark": {
    "type": "object",
    "properties": { "theme": { "type": "string" } },
    "required": ["theme"],
    "x-wb-order": ["theme"],
    "x-wb-unknownKeys": "strip"
  } }
}"#;

const MANIFEST: &str = r#"{
  "id": "demo",
  "displayName": "Demo",
  "facets": [{
    "name": "mark", "displayName": "Mark", "version": "v0", "targets": ["node", "edge"],
    "schema": "facets/demo/demo.schema.json#/$defs/Mark",
    "assetRefs": { "theme": "themes" },
    "editor": { "fields": { "theme": { "widget": "text" } } }
  }],
  "assets": { "themes": "demo.themes", "icons": "demo.icons", "stencils": "demo.stencils" }
}"#;

const NO_HOST: Host<'static> = Host { matchers: &[], checks: &[], externals: &[] };

fn load(
    manifest: &str,
    contract: &str,
    tables: &[(&str, &str)],
) -> Result<whiteboard_facet_engine::registry::Registry, LoadError> {
    let contracts = [("facets/demo/demo.schema.json", contract)];
    build(&PluginSources { manifest, contracts: &contracts, tables }, &NO_HOST)
}

fn tables() -> Vec<(&'static str, &'static str)> {
    vec![
        ("demo.themes", THEMES),
        ("demo.icons", ICONS),
        ("demo.icons", MORE_ICONS),
        ("demo.stencils", STENCILS),
    ]
}

fn refusal(manifest: &str, contract: &str, tables: &[(&str, &str)]) -> Option<LoadError> {
    load(manifest, contract, tables).err()
}

#[test]
fn a_plugin_loads_into_a_registry_that_knows_its_facets_and_assets() {
    let registry = load(MANIFEST, CONTRACT, &tables()).expect("it loads");
    assert_eq!(registry.registered(AssetKind::Themes), ["demo.sketch", "demo.neon"]);
    assert_eq!(registry.registered(AssetKind::Icons), ["demo.star", "demo.arrow"]);
    assert_eq!(registry.registered(AssetKind::Stencils), ["demo.box"]);
    assert_eq!(
        registry.targets_of("demo.mark/v0"),
        Some(&[FacetTarget::Node, FacetTarget::Edge][..])
    );
    assert_eq!(
        registry.asset_refs_of("demo.mark/v0"),
        Some(&[("theme".to_owned(), AssetKind::Themes)][..])
    );
}

#[test]
fn a_manifest_without_assets_registers_none() {
    let bare = r#"{"id": "demo", "displayName": "Demo", "facets": []}"#;
    let registry = load(bare, CONTRACT, &[]).expect("it loads");
    for kind in [AssetKind::Themes, AssetKind::Icons, AssetKind::Stencils] {
        assert!(registry.registered(kind).is_empty());
    }
}

#[test]
fn the_reader_decodes_what_the_registry_reads_and_leaves_the_editor_and_compat_out() {
    let contracts = engine_contracts().map(|(path, text)| (path, json::parse(text).expect("JSON")));
    let loaded: Vec<(&str, &_)> = contracts.iter().map(|(path, value)| (*path, value)).collect();
    let set = Contracts::load(&loaded, &ENGINE_HOST).expect("the engine's contracts compile");
    let read = manifest::read(&set, &json::parse(MANIFEST).expect("JSON")).expect("a manifest");
    assert_eq!((read.id.as_str(), read.display_name.as_str()), ("demo", "Demo"));
    let facet = read.facets.first().expect("a facet");
    assert_eq!(facet.name, "mark");
    assert_eq!(facet.version, "v0");
    assert_eq!(facet.schema, "facets/demo/demo.schema.json#/$defs/Mark");
    assert_eq!(facet.targets, [FacetTarget::Node, FacetTarget::Edge]);
    assert_eq!(facet.asset_refs, Some(vec![("theme".to_owned(), AssetKind::Themes)]));
    assert_eq!((facet.editor.clone(), facet.compat.clone()), (None, None));
    let assets = read.assets.expect("assets");
    assert_eq!(assets.themes.as_deref(), Some("demo.themes"));
    assert_eq!(assets.icons.as_deref(), Some("demo.icons"));
    assert_eq!(assets.stencils.as_deref(), Some("demo.stencils"));
}

#[test]
fn the_reader_refuses_a_value_that_is_no_manifest_and_a_set_without_the_contract() {
    let contracts = engine_contracts().map(|(path, text)| (path, json::parse(text).expect("JSON")));
    let loaded: Vec<(&str, &_)> = contracts.iter().map(|(path, value)| (*path, value)).collect();
    let set = Contracts::load(&loaded, &ENGINE_HOST).expect("the engine's contracts compile");
    let wrong = manifest::read(&set, &json::parse("{}").expect("JSON")).err();
    assert!(matches!(wrong, Some(LoadError::Manifest(issues)) if !issues.is_empty()));
    let only_engine = Contracts::load(&loaded[..1], &ENGINE_HOST).expect("compiles");
    let missing = manifest::read(&only_engine, &json::parse(MANIFEST).expect("JSON")).err();
    assert_eq!(
        missing,
        Some(LoadError::MissingDefinition(
            "plugin/plugin-manifest.schema.json#/$defs/PluginManifest".to_owned()
        ))
    );
}

#[test]
fn a_source_that_is_not_json_is_named() {
    let not_json =
        |source: &str| LoadError::NotJson { source: source.to_owned(), refusal: Refusal::Syntax };
    assert_eq!(refusal("{", CONTRACT, &tables()), Some(not_json("manifest")));
    assert_eq!(refusal(MANIFEST, "[", &tables()), Some(not_json("facets/demo/demo.schema.json")));
    let mut broken = tables();
    broken.push(("demo.icons", "{"));
    assert_eq!(refusal(MANIFEST, CONTRACT, &broken), Some(not_json("demo.icons")));
}

#[test]
fn a_contract_the_interpreter_refuses_is_a_load_error() {
    let unknown = r#"{"$defs": {"Mark": {"type": "object", "bogus": 1}}}"#;
    assert!(matches!(refusal(MANIFEST, unknown, &tables()), Some(LoadError::Contract(_))));
}

#[test]
fn a_manifest_that_is_not_one_is_refused_with_its_issues() {
    let error = refusal(r#"{"id": "Demo"}"#, CONTRACT, &tables()).expect("refused");
    assert!(matches!(error, LoadError::Manifest(issues) if !issues.is_empty()));
}

#[test]
fn a_table_the_manifest_names_must_be_supplied_and_be_an_object() {
    let without: Vec<_> = tables().into_iter().filter(|(name, _)| *name != "demo.themes").collect();
    assert_eq!(
        refusal(MANIFEST, CONTRACT, &without),
        Some(LoadError::UnsuppliedTable("demo.themes".to_owned()))
    );
    let mut array = tables();
    array.push(("demo.stencils", "[]"));
    assert_eq!(
        refusal(MANIFEST, CONTRACT, &array),
        Some(LoadError::TableNotObject("demo.stencils".to_owned()))
    );
}

#[test]
fn an_asset_is_named_a_facet_segment_and_held_once() {
    let mut misnamed = tables();
    misnamed.push(("demo.icons", r#"{"Star": {"geometry": [{"tag": "path", "d": "M"}]}}"#));
    assert_eq!(
        refusal(MANIFEST, CONTRACT, &misnamed),
        Some(LoadError::AssetName { kind: AssetKind::Icons, name: "Star".to_owned() })
    );
    let mut twice = tables();
    twice.push(("demo.icons", ICONS));
    assert_eq!(
        refusal(MANIFEST, CONTRACT, &twice),
        Some(LoadError::DuplicateAsset { kind: AssetKind::Icons, name: "star".to_owned() })
    );
}

#[test]
fn an_asset_its_shape_refuses_is_named_with_its_issues() {
    let mut empty = tables();
    empty.push(("demo.icons", r#"{"hollow": {"geometry": []}}"#));
    let error = refusal(MANIFEST, CONTRACT, &empty).expect("refused");
    let LoadError::Asset { kind, name, issues } = error else { panic!("{error:?}") };
    assert_eq!((kind, name.as_str()), (AssetKind::Icons, "hollow"));
    assert_eq!(issues.first().map(|issue| issue.code), Some(Code::TooSmall));
}

#[test]
fn a_registry_that_cannot_be_built_says_why() {
    let dangling = MANIFEST.replace("$defs/Mark", "$defs/Missing");
    let error = refusal(&dangling, CONTRACT, &tables()).expect("refused");
    assert!(matches!(error, LoadError::Registry(BuildError::UnresolvedSchema { .. })));
}

#[test]
fn a_bundled_stencil_is_held_to_the_facet_it_names() {
    let with = |stencils: &str| {
        let mut set: Vec<_> = tables().into_iter().filter(|(n, _)| *n != "demo.stencils").collect();
        set.push(("demo.stencils", stencils));
        refusal(MANIFEST, CONTRACT, &set).expect("refused")
    };
    let stencil = |key: &str, payload: &str| {
        format!(r#"{{"box": {{"displayName": "Box", "facets": {{"{key}": {payload}}}}}}}"#)
    };
    assert_eq!(
        with(&stencil("demo.nothing/v0", "{}")),
        LoadError::StencilFacetUnregistered {
            stencil: "demo.box".to_owned(),
            key: "demo.nothing/v0".to_owned(),
        }
    );
    assert_eq!(
        with(&stencil("demo.mark/v3", r#"{"theme": "x"}"#)),
        LoadError::StencilFacetNotCurrent {
            stencil: "demo.box".to_owned(),
            key: "demo.mark/v3".to_owned(),
            current: "demo.mark/v0".to_owned(),
        }
    );
    let invalid = with(&stencil("demo.mark/v0", "{}"));
    let LoadError::StencilPayloadInvalid { stencil, key, issues } = invalid else {
        panic!("{invalid:?}")
    };
    assert_eq!((stencil.as_str(), key.as_str()), ("demo.box", "demo.mark/v0"));
    assert_eq!(issues.first().map(|issue| issue.code), Some(Code::InvalidType));
}
