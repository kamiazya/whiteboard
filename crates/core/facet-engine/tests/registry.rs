//! The registry over a small plugin: what it refuses to build, what it says of
//! a key, and each stage of a write in the order the TypeScript registry has
//! them.

use serde_json::{Value as Json, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetDecl, FacetTarget, PluginManifest};
use whiteboard_facet_engine::registry::{BuildError, Registry, WriteRefusal};
use whiteboard_facet_engine::schema::{Code, Contracts, Host};
use whiteboard_model::Value;

const PATH: &str = "facets/demo/demo.schema.json";

fn from_json(text: &str) -> Option<Value> {
    fn convert(json: &Json) -> Value {
        match json {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::String(s) => Value::String(s.clone()),
            Json::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
            Json::Array(items) => Value::Seq(items.iter().map(convert).collect()),
            Json::Object(o) => Value::Map(o.iter().map(|(k, v)| (k.clone(), convert(v))).collect()),
        }
    }
    serde_json::from_str(text).ok().map(|json| convert(&json))
}

fn contracts() -> Option<Contracts> {
    let contract = json!({
        "$schema": "x",
        "$defs": {
            "Mark": { "type": "object", "properties": {
                "theme": { "type": "string" }, "icon": { "type": "string" }, "size": { "type": "number" },
            }, "required": ["theme"], "x-wb-order": ["theme", "icon", "size"], "x-wb-unknownKeys": "strip" },
            "Tone": { "type": "string", "enum": ["calm", "loud"] },
        },
    });
    let contract = from_json(&contract.to_string()).unwrap_or_default();
    let host = Host { matchers: &[], checks: &[], externals: &[] };
    Contracts::load(&[(PATH, &contract)], &host).ok()
}

fn facet(name: &str, version: &str, def: &str, refs: &[(&str, AssetKind)]) -> FacetDecl {
    FacetDecl {
        name: name.to_owned(),
        version: version.to_owned(),
        targets: vec![FacetTarget::Node, FacetTarget::Edge],
        schema: format!("{PATH}#/$defs/{def}"),
        asset_refs: Some(refs.iter().map(|(f, k)| ((*f).to_owned(), *k)).collect()),
        ..FacetDecl::default()
    }
}

fn plugin(id: &str, facets: Vec<FacetDecl>) -> PluginManifest {
    PluginManifest { id: id.to_owned(), facets, ..PluginManifest::default() }
}

fn assets(kind: AssetKind) -> Vec<String> {
    match kind {
        AssetKind::Themes => vec!["demo.sketch".to_owned(), "demo.neon".to_owned()],
        AssetKind::Icons => vec!["demo.star".to_owned()],
        AssetKind::Stencils => Vec::new(),
    }
}

fn registry() -> Option<Registry> {
    let facets = vec![
        facet("mark", "v1", "Mark", &[("theme", AssetKind::Themes), ("icon", AssetKind::Icons)]),
        facet("tone", "v0", "Tone", &[]),
    ];
    Registry::build(&[plugin("demo", facets)], contracts()?, assets, &[]).ok()
}

fn value(json: &Json) -> Value {
    from_json(&json.to_string()).unwrap_or_default()
}

fn map(entries: &[(&str, Value)]) -> Value {
    Value::Map(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
}

fn text(s: &str) -> Value {
    Value::String(s.to_owned())
}

#[test]
fn a_registry_is_refused_where_a_plugin_cannot_be_registered() {
    let mark = || facet("mark", "v1", "Mark", &[]);
    let build = |plugins: &[PluginManifest]| {
        Registry::build(plugins, contracts().expect("it compiles"), assets, &[]).err()
    };
    assert_eq!(
        build(&[plugin("demo", vec![mark()]), plugin("demo", vec![])]),
        Some(BuildError::DuplicatePlugin("demo".into()))
    );
    assert_eq!(
        build(&[plugin("workspace", vec![])]),
        Some(BuildError::ReservedPlugin("workspace".into()))
    );
    assert_eq!(
        build(&[plugin("demo", vec![mark(), mark()])]),
        Some(BuildError::DuplicateFacet { plugin: "demo".into(), facet: "mark".into() })
    );
    // The same facet name under another plugin is no duplicate.
    assert_eq!(build(&[plugin("demo", vec![mark()]), plugin("other", vec![mark()])]), None);
    let missing = facet("mark", "v1", "Missing", &[]);
    assert_eq!(
        build(&[plugin("demo", vec![missing])]),
        Some(BuildError::UnresolvedSchema {
            plugin: "demo".into(),
            facet: "mark".into(),
            pointer: format!("{PATH}#/$defs/Missing"),
        })
    );
    let undeclared =
        facet("mark", "v1", "Mark", &[("theme", AssetKind::Themes), ("colour", AssetKind::Themes)]);
    assert_eq!(
        build(&[plugin("demo", vec![undeclared])]),
        Some(BuildError::UndeclaredAssetField {
            plugin: "demo".into(),
            facet: "mark".into(),
            field: "colour".into(),
        })
    );
    let on_a_string = facet("tone", "v0", "Tone", &[("theme", AssetKind::Themes)]);
    assert!(matches!(
        build(&[plugin("demo", vec![on_a_string])]),
        Some(BuildError::UndeclaredAssetField { .. })
    ));
}

#[test]
fn a_key_says_where_it_attaches_and_which_fields_name_assets_whatever_its_version() {
    let registry = registry().expect("it builds");
    for key in ["demo.mark/v1", "demo.mark/v0", "demo.mark/v9"] {
        assert_eq!(
            registry.targets_of(key),
            Some(&[FacetTarget::Node, FacetTarget::Edge][..]),
            "{key}"
        );
        let refs = registry.asset_refs_of(key).expect("registered");
        assert_eq!(
            refs,
            &[("theme".to_owned(), AssetKind::Themes), ("icon".to_owned(), AssetKind::Icons)][..]
        );
    }
    assert_eq!(registry.asset_refs_of("demo.tone/v0"), Some(&[][..]));
    for key in ["demo.nothing/v1", "other.mark/v1", "demo.mark", "demo.mark/v", "Demo.mark/v1", ""]
    {
        assert_eq!(
            (registry.targets_of(key), registry.asset_refs_of(key)),
            (None, None),
            "{key:?}"
        );
    }
}

#[test]
fn a_write_is_refused_by_the_first_stage_that_objects() {
    let registry = registry().expect("it builds");
    let payload = map(&[("theme", text("demo.sketch"))]);
    assert_eq!(
        registry.validate_facet_write("demo.mark", &payload),
        Err(WriteRefusal::MalformedKey)
    );
    assert_eq!(
        registry.validate_facet_write("demo.mark/v0", &payload),
        Err(WriteRefusal::NotCurrentVersion { current: "demo.mark/v1".into() })
    );
    // A malformed key is refused before a version is compared.
    assert_eq!(
        registry.validate_facet_write("demo.mark/", &payload),
        Err(WriteRefusal::MalformedKey)
    );
    let Err(WriteRefusal::Invalid(issues)) =
        registry.validate_facet_write("demo.mark/v1", &map(&[("theme", Value::Number(1.0))]))
    else {
        panic!("the schema refuses a number for a theme");
    };
    assert_eq!(issues[0].code, Code::InvalidType);
    // The schema is judged before any asset is looked up.
    let refused = registry.validate_facet_write(
        "demo.mark/v1",
        &map(&[("theme", text("demo.gone")), ("size", text("x"))]),
    );
    assert!(matches!(refused, Err(WriteRefusal::Invalid(_))));
}

#[test]
fn a_write_names_the_first_asset_no_plugin_registered_with_what_is() {
    let registry = registry().expect("it builds");
    let refused = registry.validate_facet_write(
        "demo.mark/v1",
        &map(&[("theme", text("demo.sketch")), ("icon", text("demo.gone"))]),
    );
    assert_eq!(
        refused,
        Err(WriteRefusal::UnregisteredAsset {
            field: "icon".into(),
            id: "demo.gone".into(),
            kind: AssetKind::Icons,
            registered: vec!["demo.star".into()],
        })
    );
    let both = registry.validate_facet_write(
        "demo.mark/v1",
        &map(&[("icon", text("demo.gone")), ("theme", text("demo.gone"))]),
    );
    assert!(
        matches!(both, Err(WriteRefusal::UnregisteredAsset { ref field, .. }) if field == "theme")
    );
}

#[test]
fn an_accepted_write_stores_the_payload_as_its_schema_parses_it() {
    let registry = registry().expect("it builds");
    let written =
        map(&[("zz", Value::Null), ("icon", text("demo.star")), ("theme", text("demo.neon"))]);
    assert_eq!(
        registry.validate_facet_write("demo.mark/v1", &written),
        Ok(map(&[("theme", text("demo.neon")), ("icon", text("demo.star"))]))
    );
    // An asset field that is left out names nothing, and one that is not a string is the schema's to refuse.
    let bare = map(&[("theme", text("demo.sketch"))]);
    assert_eq!(registry.validate_facet_write("demo.mark/v1", &bare), Ok(bare.clone()));
    assert_eq!(registry.validate_facet_write("demo.tone/v0", &text("calm")), Ok(text("calm")));
    assert!(matches!(
        registry.validate_facet_write("demo.tone/v0", &text("quiet")),
        Err(WriteRefusal::Invalid(_))
    ));
}

#[test]
fn a_key_no_plugin_registered_is_someone_elses_and_is_stored_as_it_came() {
    let registry = registry().expect("it builds");
    let payload = value(&json!({ "anything": [1, null, { "k": "v" }] }));
    for key in ["other.thing/v3", "demo.nothing/v0", "demo.mark2/v1"] {
        assert_eq!(registry.validate_facet_write(key, &payload), Ok(payload.clone()), "{key}");
    }
}

/// Two plugins, each facet listed in manifest order under its own plugin's
/// name; a plugin built from no manifest name shows none.
#[test]
fn every_facet_is_listed_in_manifest_order_under_its_plugins_name() {
    let named = |id: &str, name: &str, facets| PluginManifest {
        display_name: name.to_owned(),
        ..plugin(id, facets)
    };
    let plugins = [
        named("zeta", "Zeta", vec![facet("tone", "v0", "Tone", &[])]),
        named(
            "alpha",
            "Alpha",
            vec![facet("mark", "v1", "Mark", &[]), facet("b", "v2", "Tone", &[])],
        ),
    ];
    let registry =
        Registry::build(&plugins, contracts().expect("it compiles"), assets, &[]).expect("built");
    let listed: Vec<_> = registry
        .listed_facets()
        .iter()
        .map(|f| (f.namespace, f.display_name, f.name, f.version))
        .collect();
    assert_eq!(
        listed,
        [
            ("zeta", "Zeta", "tone", "v0"),
            ("alpha", "Alpha", "mark", "v1"),
            ("alpha", "Alpha", "b", "v2"),
        ]
    );
    assert_eq!(registry.stencil_display_name("demo.sketch"), None);
}

/// A definition published as Zod writes it: a reference replaced by the
/// definition it names in its own contract, never by the same name in another
/// loaded contract, and a description the generator does not write dropped.
#[test]
fn a_published_definition_inlines_its_own_contracts_references() {
    let parse = |text: &str| whiteboard_model::json::parse(text).expect("JSON");
    let other = parse(r#"{"$schema": "x", "$defs": {"Id": {"type": "number"}}}"#);
    let contract = parse(
        r##"{"$schema": "x", "$defs": {
            "Id": {"type": "string", "x-wb-minUtf16": 1, "description": "an id"},
            "Pair": {"type": "object", "description": "#/$defs/Id",
                "properties": {"id": {"$ref": "#/$defs/Id"},
                    "ids": {"type": "array", "items": {"$ref": "#/$defs/Id"}}},
                "required": ["id"], "x-wb-order": ["id", "ids"], "x-wb-unknownKeys": "strip"}
        }}"##,
    );
    let host = Host { matchers: &[], checks: &[], externals: &[] };
    let loaded = [("facets/other.schema.json", &other), (PATH, &contract)];
    let contracts = Contracts::load(&loaded, &host).expect("it compiles");
    let pair = contracts.resolve(&format!("{PATH}#/$defs/Pair")).expect("Pair");
    let dialect = r#""$schema": "https://json-schema.org/draft/2020-12/schema""#;
    let published = parse(&format!(
        r#"{{{dialect}, "type": "object",
            "properties": {{"id": {{"type": "string", "minLength": 1}},
                "ids": {{"type": "array", "items": {{"type": "string", "minLength": 1}}}}}},
            "required": ["id"], "additionalProperties": false}}"#
    ));
    assert_eq!(contracts.published(pair), Some(published));
    let other_id = contracts.resolve("facets/other.schema.json#/$defs/Id").expect("Id");
    let number = parse(&format!(r#"{{{dialect}, "type": "number"}}"#));
    assert_eq!(contracts.published(other_id), Some(number));
    let foreign = Contracts::load(&[], &host).expect("nothing loads");
    assert_eq!(foreign.published(pair), None);
}
