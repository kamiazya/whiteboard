//! A bucket judged against the bundled registry, and each refusal worded.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::json;
use whiteboard_plugin_visual::host::visual_registry;

fn bucket(text: &str) -> Vec<(String, Value)> {
    match json::parse(text).expect("a bucket") {
        Value::Map(entries) => entries,
        _ => Vec::new(),
    }
}

/// The reason the bucket is refused with, for a write targeting `target`.
fn reason(target: FacetTarget, text: &str) -> String {
    let registry = visual_registry().expect("the bundled registry");
    match judge(&registry, target, &bucket(text)) {
        Err(Refusal::FacetWriteRejected { reason, facet_key }) => format!("{facet_key}|{reason}"),
        other => format!("not refused: {other:?}"),
    }
}

#[test]
fn a_bucket_is_judged_into_sets_and_deletions_in_its_own_order() {
    let registry = visual_registry().expect("the bundled registry");
    let written = judge(
        &registry,
        FacetTarget::Node,
        &bucket(
            r#"{"visual.shape/v0":{"kind":"hexagon"},"other.thing/v1":[1],"visual.text/v0":null}"#,
        ),
    )
    .expect("accepted");
    let keys: Vec<&str> = written.sets.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["visual.shape/v0", "other.thing/v1"]);
    assert_eq!(written.deletions, ["visual.text/v0"]);
}

#[test]
fn a_facet_the_target_excludes_names_its_targets_and_the_noun_of_the_write() {
    assert_eq!(
        reason(FacetTarget::Document, r#"{"visual.shape/v0":{"kind":"hexagon"}}"#),
        "visual.shape/v0|its targets are [node], and this write targets a document"
    );
    assert_eq!(
        reason(FacetTarget::Edge, r#"{"visual.shape/v0":{"kind":"hexagon"}}"#),
        "visual.shape/v0|its targets are [node], and this write targets an edge"
    );
}

#[test]
fn a_key_off_the_grammar_a_stale_version_and_a_bad_payload_are_each_worded() {
    assert_eq!(reason(FacetTarget::Node, r#"{"Bad":1}"#), "Bad|malformed facet key \"Bad\"");
    assert_eq!(
        reason(FacetTarget::Node, r#"{"visual.shape/v9":{"kind":"hexagon"}}"#),
        "visual.shape/v9|\"visual.shape/v9\" is not the current version \u{2014} write \"visual.shape/v0\""
    );
    assert_eq!(
        reason(FacetTarget::Node, r#"{"visual.shape/v0":{"kind":"nope"}}"#),
        "visual.shape/v0|payload for \"visual.shape/v0\" is invalid: kind: invalid_value"
    );
    assert_eq!(
        reason(FacetTarget::Node, r#"{"visual.shape/v0":3}"#),
        "visual.shape/v0|payload for \"visual.shape/v0\" is invalid: (payload): invalid_type"
    );
}

#[test]
fn an_asset_nothing_registered_names_the_kind_and_what_is_registered() {
    let said = reason(FacetTarget::Canvas, r#"{"visual.theme/v0":{"theme":"visual.chalk"}}"#);
    assert_eq!(
        said,
        "visual.theme/v0|\"visual.theme/v0\" field theme names themes asset \"visual.chalk\", which no plugin registered \u{2014} registered: visual.sketch, visual.neon"
    );
}

#[test]
fn a_key_the_schema_drops_is_named_by_its_place() {
    assert_eq!(
        reason(FacetTarget::Node, r#"{"visual.shape/v0":{"kind":"hexagon","extra":1}}"#),
        "visual.shape/v0|payload for \"visual.shape/v0\" is invalid: payload: Unrecognized key: \"extra\""
    );
    let nested =
        reason(FacetTarget::Edge, r#"{"visual.edges/v0":{"routing":"orthogonal","extra":true}}"#);
    assert!(nested.ends_with("is invalid: payload: Unrecognized key: \"extra\""), "{nested}");
}

#[test]
fn only_a_facet_that_takes_a_stencil_and_is_written_asks_for_the_library() {
    let registry = visual_registry().expect("the bundled registry");
    let writes = |text: &str| writes_a_stencil(&registry, &bucket(text));
    assert!(writes(r#"{"visual.stencil/v0":{"stencil":"visual.datastore"}}"#));
    assert!(!writes(r#"{"visual.stencil/v0":null}"#));
    assert!(!writes(r#"{"visual.shape/v0":{"kind":"hexagon"}}"#));
    assert!(!writes(r#"{"other.thing/v1":{"stencil":"x"}}"#));
    assert!(!writes("{}"));
}

#[test]
fn every_class_of_issue_is_named_as_zod_names_it_and_a_list_place_is_its_index() {
    let named: Vec<&str> = [
        Code::InvalidType,
        Code::TooSmall,
        Code::TooBig,
        Code::InvalidFormat,
        Code::InvalidValue,
        Code::UnrecognizedKeys,
        Code::InvalidUnion,
        Code::InvalidKey,
        Code::Custom,
    ]
    .into_iter()
    .map(code_name)
    .collect();
    assert_eq!(
        named,
        [
            "invalid_type",
            "too_small",
            "too_big",
            "invalid_format",
            "invalid_value",
            "unrecognized_keys",
            "invalid_union",
            "invalid_key",
            "custom"
        ]
    );
    let issue = Issue {
        path: vec![PathStep::Key("a".into()), PathStep::Index(2), PathStep::Key("b".into())],
        code: Code::TooSmall,
        detail: whiteboard_facet_engine::schema::Detail::None,
        continues: false,
    };
    assert_eq!(issue_list(&[issue]), "a.2.b: too_small");
}
