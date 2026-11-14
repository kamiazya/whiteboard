//! A bucket judged for a write, and a library composed beside the registry,
//! over a small plugin whose facets cover each way a write is refused.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::partition::{
    Composition, Refusal, Refused, Stray, Writes, compose_library, first_unrecognized_key,
    partition,
};
use whiteboard_facet_engine::plugin::{PluginSources, build};
use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetTarget};
use whiteboard_facet_engine::registry::{PayloadRefusal, Registry, StencilRefusal, WriteRefusal};
use whiteboard_facet_engine::schema::{Code, Contracts, Host};
use whiteboard_model::Value;
use whiteboard_model::json;

const THEMES: &str = include_str!("../../../../packages/plugin-visual/src/assets/themes.json");

const CONTRACT: &str = r##"{
  "$schema": "x",
  "$defs": {
    "Mark": {
      "type": "object",
      "properties": { "theme": { "type": "string" } },
      "required": ["theme"],
      "x-wb-order": ["theme"],
      "x-wb-unknownKeys": "strip"
    },
    "Bag": { "type": "object", "additionalProperties": { "x-wb-any": true } },
    "Row": {
      "type": "object",
      "properties": { "name": { "type": "string" } },
      "required": ["name"],
      "x-wb-order": ["name"],
      "x-wb-unknownKeys": "strip"
    },
    "Rows": {
      "type": "object",
      "properties": { "rows": { "type": "array", "items": { "$ref": "#/$defs/Row" } } },
      "required": ["rows"],
      "x-wb-order": ["rows"],
      "x-wb-unknownKeys": "strip"
    }
  }
}"##;

const MANIFEST: &str = r#"{
  "id": "demo",
  "displayName": "Demo",
  "facets": [
    {
      "name": "mark", "displayName": "Mark", "version": "v0", "targets": ["node", "edge"],
      "schema": "facets/demo/demo.schema.json#/$defs/Mark",
      "assetRefs": { "theme": "themes" },
      "editor": { "fields": { "theme": { "widget": "text" } } }
    },
    {
      "name": "bag", "displayName": "Bag", "version": "v0", "targets": ["document", "node"],
      "schema": "facets/demo/demo.schema.json#/$defs/Bag"
    },
    {
      "name": "rows", "displayName": "Rows", "version": "v0", "targets": ["node"],
      "schema": "facets/demo/demo.schema.json#/$defs/Rows"
    }
  ],
  "assets": { "themes": "demo.themes", "stencils": "demo.stencils" }
}"#;

const STENCILS: &str = r#"{"box": {"displayName": "Box"}}"#;
const NO_HOST: Host<'static> = Host { matchers: &[], checks: &[], externals: &[] };

/// Helpers that unwrap, which clippy allows only inside what it reads as test code.
#[cfg(test)]
mod fixtures {
    use super::*;

    pub(crate) fn registry() -> Registry {
        let contracts = [("facets/demo/demo.schema.json", CONTRACT)];
        let tables = [("demo.themes", THEMES), ("demo.stencils", STENCILS)];
        build(
            &PluginSources {
                manifest: MANIFEST,
                contracts: &contracts,
                tables: &tables,
                migrations: &[],
            },
            &NO_HOST,
        )
        .expect("the demo plugin loads")
    }

    pub(crate) fn v(text: &str) -> Value {
        json::parse(text).expect("test JSON")
    }

    pub(crate) fn bucket(text: &str) -> Vec<(String, Value)> {
        let Value::Map(entries) = v(text) else { panic!("a bucket is an object") };
        entries
    }

    pub(crate) fn write(target: FacetTarget, text: &str) -> Result<Writes, Refused> {
        partition(&registry(), &[], target, &bucket(text))
    }

    pub(crate) fn refused_at(target: FacetTarget, text: &str) -> (String, Refusal) {
        let refused = write(target, text).expect_err("refused");
        (refused.key, refused.why)
    }
}
use fixtures::{bucket, refused_at, registry, v, write};

#[test]
fn a_bucket_splits_into_parsed_sets_and_deletions_in_the_buckets_order() {
    let writes = write(
        FacetTarget::Node,
        r#"{"demo.mark/v0": {"theme": "demo.sketch"}, "other.thing/v2": [1, {"a": null}], "demo.bag/v0": null, "demo.rows/v0": null}"#,
    )
    .expect("accepted");
    assert_eq!(
        writes.sets,
        [
            ("demo.mark/v0".to_owned(), v(r#"{"theme": "demo.sketch"}"#)),
            ("other.thing/v2".to_owned(), v(r#"[1, {"a": null}]"#)),
        ]
    );
    assert_eq!(writes.deletions, ["demo.bag/v0", "demo.rows/v0"]);
    assert_eq!(write(FacetTarget::Node, "{}"), Ok(Writes { sets: vec![], deletions: vec![] }));
}

#[test]
fn a_deletion_needs_no_target_schema_or_even_a_well_formed_key() {
    let writes = write(FacetTarget::Document, r#"{"demo.mark/v0": null, "nope": null}"#);
    assert_eq!(writes.expect("accepted").deletions, ["demo.mark/v0", "nope"]);
}

#[test]
fn a_facet_that_does_not_attach_to_the_target_is_refused_naming_where_it_does() {
    let (key, why) =
        refused_at(FacetTarget::Canvas, r#"{"demo.mark/v0": {"theme": "demo.sketch"}}"#);
    assert_eq!(key, "demo.mark/v0");
    assert_eq!(why, Refusal::Target(vec![FacetTarget::Node, FacetTarget::Edge]));
    // The target is judged for any version, before the version is.
    let (_, why) = refused_at(FacetTarget::Canvas, r#"{"demo.mark/v9": {}}"#);
    assert!(matches!(why, Refusal::Target(_)), "{why:?}");
}

#[test]
fn the_registrys_own_refusals_pass_through_stage_by_stage() {
    let node = FacetTarget::Node;
    let (_, why) = refused_at(node, r#"{"nope": 1}"#);
    assert_eq!(why, Refusal::Write(WriteRefusal::MalformedKey));
    let (_, why) = refused_at(node, r#"{"demo.mark/v3": {}}"#);
    assert_eq!(
        why,
        Refusal::Write(WriteRefusal::NotCurrentVersion { current: "demo.mark/v0".to_owned() })
    );
    let (_, why) = refused_at(node, r#"{"demo.mark/v0": {}}"#);
    let Refusal::Write(WriteRefusal::Invalid(issues)) = why else { panic!("{why:?}") };
    assert_eq!(issues.first().map(|issue| issue.code), Some(Code::InvalidType));
    let (_, why) = refused_at(node, r#"{"demo.mark/v0": {"theme": "demo.gone"}}"#);
    let Refusal::Write(WriteRefusal::UnregisteredAsset { field, id, kind, registered }) = why
    else {
        panic!("{why:?}")
    };
    assert_eq!((field.as_str(), id.as_str(), kind), ("theme", "demo.gone", AssetKind::Themes));
    assert_eq!(registered, registry().registered(AssetKind::Themes));
}

#[test]
fn a_key_the_schema_strips_refuses_the_write_naming_where() {
    let (key, why) =
        refused_at(FacetTarget::Node, r#"{"demo.mark/v0": {"theme": "demo.sketch", "colour": 1}}"#);
    assert_eq!(key, "demo.mark/v0");
    assert_eq!(why, Refusal::Unrecognized(Stray { path: vec![], key: "colour".to_owned() }));
    let (_, why) = refused_at(
        FacetTarget::Node,
        r#"{"demo.rows/v0": {"rows": [{"name": "a"}, {"name": "b", "extra": true}]}}"#,
    );
    assert_eq!(
        why,
        Refusal::Unrecognized(Stray {
            path: vec!["rows".to_owned(), "1".to_owned()],
            key: "extra".to_owned()
        })
    );
}

#[test]
fn the_first_refusal_in_the_buckets_order_wins_whatever_follows() {
    let node = FacetTarget::Node;
    // The target of the first is judged before the schema of the second, and the
    // second's schema before the third's key.
    let ordered =
        r#"{"demo.bag/v0": {}, "demo.mark/v0": {}, "demo.rows/v0": {"rows": [], "z": 1}}"#;
    let (key, why) = refused_at(node, ordered);
    assert_eq!(key, "demo.mark/v0");
    assert!(matches!(why, Refusal::Write(WriteRefusal::Invalid(_))));
    let reversed =
        r#"{"demo.rows/v0": {"rows": [], "z": 1}, "demo.mark/v0": {}, "demo.bag/v0": {}}"#;
    let (key, why) = refused_at(node, reversed);
    assert_eq!(key, "demo.rows/v0");
    assert!(matches!(why, Refusal::Unrecognized(_)));
    // A refusal stops the walk: a deletion after it is never reached, and one before it is dropped.
    let (key, _) = refused_at(node, r#"{"demo.bag/v0": null, "nope": 1, "demo.mark/v0": null}"#);
    assert_eq!(key, "nope");
}

#[test]
fn the_extra_assets_of_a_call_are_registered_after_the_registrys_own() {
    let registry = registry();
    let mine = ["demo.mine".to_owned()];
    let extra = [(AssetKind::Themes, &mine[..])];
    let bucket = bucket(r#"{"demo.mark/v0": {"theme": "demo.mine"}}"#);
    assert!(partition(&registry, &extra, FacetTarget::Node, &bucket).is_ok());
    // An id of another kind is no theme.
    let stencils = [(AssetKind::Stencils, &mine[..])];
    let refused = partition(&registry, &stencils, FacetTarget::Node, &bucket).expect_err("refused");
    let Refusal::Write(WriteRefusal::UnregisteredAsset { registered, .. }) = refused.why else {
        panic!()
    };
    assert_eq!(registered, registry.registered(AssetKind::Themes));
    let refused = partition(&registry, &[], FacetTarget::Node, &bucket).expect_err("refused");
    assert!(matches!(refused.why, Refusal::Write(WriteRefusal::UnregisteredAsset { .. })));
    // What the refusal lists is what was registered, the extras last.
    let other = ["demo.other".to_owned()];
    let both = [(AssetKind::Themes, &mine[..]), (AssetKind::Themes, &other[..])];
    let miss = self::bucket(r#"{"demo.mark/v0": {"theme": "demo.none"}}"#);
    let refused = partition(&registry, &both, FacetTarget::Node, &miss).expect_err("refused");
    let Refusal::Write(WriteRefusal::UnregisteredAsset { registered, .. }) = refused.why else {
        panic!()
    };
    let mut expected = registry.registered(AssetKind::Themes).to_vec();
    expected.extend(["demo.mine".to_owned(), "demo.other".to_owned()]);
    assert_eq!(registered, expected);
}

fn stray(sent: &str, parsed: &str) -> Option<(Vec<String>, String)> {
    first_unrecognized_key(&v(sent), &v(parsed)).map(|found| (found.path, found.key))
}

fn at(path: &[&str], key: &str) -> (Vec<String>, String) {
    (path.iter().map(ToString::to_string).collect(), key.to_owned())
}

#[test]
fn the_first_key_the_parsed_value_lost_is_found_in_the_senders_order() {
    assert_eq!(stray(r#"{"a": 1, "b": 2}"#, r#"{"a": 1, "b": 2}"#), None);
    assert_eq!(stray(r#"{"a": 1, "b": 2, "c": 3}"#, r#"{"a": 1}"#), Some(at(&[], "b")));
    assert_eq!(stray(r#"{"a": {"x": 1, "y": 1}}"#, r#"{"a": {"y": 1}}"#), Some(at(&["a"], "x")));
    assert_eq!(stray(r#"[{"a": 1}, {"b": 1}]"#, r#"[{"a": 1}, {}]"#), Some(at(&["1"], "b")));
    assert_eq!(
        stray(r#"{"l": [[{"k": 1}]]}"#, r#"{"l": [[{}]]}"#),
        Some(at(&["l", "0", "0"], "k"))
    );
    // The first in the sender's order, not the deepest or the shallowest.
    assert_eq!(stray(r#"{"a": {"x": 1}, "b": 1}"#, r#"{"a": {}}"#), Some(at(&["a"], "x")));
}

#[test]
fn what_the_parsed_value_cannot_be_compared_with_is_not_reported() {
    // A list shorter than what was sent has nothing to compare the rest with.
    assert_eq!(stray(r#"[{"a": 1}, {"b": 1}]"#, r#"[{"a": 1}]"#), None);
    // A kind mismatch, a scalar, and a null on either side.
    assert_eq!(stray(r#"{"a": 1}"#, "[1]"), None);
    assert_eq!(stray(r#"[{"a": 1}]"#, r#"{"a": 1}"#), None);
    assert_eq!(stray(r#"{"a": {"b": 1}}"#, r#"{"a": null}"#), None);
    assert_eq!(stray(r#"{"a": 1}"#, "3"), None);
    assert_eq!(stray("null", "null"), None);
}

#[test]
fn a_key_spelt_like_one_every_javascript_object_holds_is_never_reported() {
    for name in [
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
    ] {
        assert_eq!(stray(&format!(r#"{{"{name}": 1}}"#), "{}"), None, "{name}");
    }
    // Only those: a name that merely resembles one is a stray.
    assert_eq!(stray(r#"{"valueof": 1}"#, "{}"), Some(at(&[], "valueof")));
    assert_eq!(stray(r#"{"constructor": {"a": 1}, "b": 1}"#, "{}"), Some(at(&[], "b")));
    // And when the parsed value holds the key itself, it is compared like any.
    assert_eq!(
        stray(r#"{"constructor": {"a": 1}}"#, r#"{"constructor": {}}"#),
        Some(at(&["constructor"], "a"))
    );
}

#[test]
fn a_bag_that_keeps_every_key_never_reports_one() {
    let writes = write(FacetTarget::Node, r#"{"demo.bag/v0": {"a": 1, "b": {"c": [1, 2]}}}"#);
    assert_eq!(writes.expect("accepted").sets.len(), 1);
}

fn library(text: &str) -> Composition {
    compose_library(&registry(), &bucket(text))
}

#[test]
fn a_library_is_judged_a_stencil_at_a_time_and_the_kept_are_named_as_the_registry_would() {
    let composed = library(
        r#"{
          "alpha": {"displayName": "Alpha", "facets": {"demo.mark/v0": {"theme": "demo.sketch"}}},
          "Bad Name": {"displayName": "x"},
          "beta": {"displayName": ""},
          "gamma": {"displayName": "Gamma"},
          "delta": {"displayName": "D", "facets": {"demo.nothing/v0": {}}},
          "eps": {"displayName": "D", "facets": {"demo.mark/v3": {}}},
          "zeta": {"displayName": "D", "facets": {"demo.mark/v0": {}}}
        }"#,
    );
    assert_eq!(composed.kept, ["workspace.alpha", "workspace.gamma"]);
    let dropped: Vec<&str> = composed.dropped.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(dropped, ["Bad Name", "beta", "delta", "eps", "zeta"]);
    let why = |name: &str| composed.dropped.iter().find(|(n, _)| n == name).map(|(_, why)| why);
    assert_eq!(why("Bad Name"), Some(&StencilRefusal::Name));
    assert!(matches!(why("beta"), Some(StencilRefusal::Shape(issues)) if !issues.is_empty()));
    assert!(matches!(
        why("delta"),
        Some(StencilRefusal::Facet { key, why: PayloadRefusal::Unregistered }) if key == "demo.nothing/v0"
    ));
    assert!(matches!(
        why("eps"),
        Some(StencilRefusal::Facet { why: PayloadRefusal::NotCurrent { current }, .. }) if current == "demo.mark/v0"
    ));
    assert!(matches!(
        why("zeta"),
        Some(StencilRefusal::Facet { why: PayloadRefusal::Invalid(_), .. })
    ));
    assert_eq!(library("{}"), Composition { kept: vec![], dropped: vec![] });
}

#[test]
fn a_stencil_is_judged_by_the_shape_the_registrys_contracts_hold() {
    let bare = Registry::build(
        &[],
        Contracts::load(&[], &NO_HOST).expect("an empty set compiles"),
        |_| Vec::new(),
        &[],
    )
    .expect("an empty registry builds");
    let stencil = v(r#"{"displayName": "Box"}"#);
    assert_eq!(bare.judge_workspace_stencil("box", &stencil), Err(StencilRefusal::NoShape));
    assert_eq!(registry().judge_workspace_stencil("box", &stencil), Ok(()));
}
