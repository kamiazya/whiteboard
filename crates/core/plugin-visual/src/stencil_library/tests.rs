use whiteboard_model::{Value, json};

use super::read_stencil_library;
use crate::host::visual_registry;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn read(facets: &str) -> Vec<(String, Value)> {
    let registry = visual_registry().expect("the bundled plugin");
    read_stencil_library(&json::parse(facets).expect("JSON"), &registry)
}

fn names(library: &[(String, Value)]) -> Vec<&str> {
    library.iter().map(|(name, _)| name.as_str()).collect()
}

#[test]
fn a_library_reads_in_name_order_each_stencil_as_parsed() {
    let library = read(
        r#"{"visual.stencils/v0": {"stencils": {
            "zeta": {"displayName": "Z", "color": "2"},
            "alpha": {"displayName": "A", "extra": 1}}}}"#,
    );
    assert_eq!(names(&library), ["zeta"]);
    let parsed = json::parse(r#"{"displayName": "Z", "color": "2", "facets": {}}"#);
    assert_eq!(library[0].1, parsed.expect("JSON"));
}

#[test]
fn a_stencil_with_a_bad_name_or_shape_is_left_out_alone() {
    let library = read(
        r#"{"visual.stencils/v0": {"stencils": {
            "Not A Name": {"displayName": "x"}, "b": {"displayName": ""},
            "c": {"displayName": "C"}, "a": {"displayName": "A"}}}}"#,
    );
    assert_eq!(names(&library), ["a", "c"]);
}

#[test]
fn no_library_or_one_of_another_shape_reads_as_none() {
    for facets in [
        r"{}",
        r#"{"$undefined": true}"#,
        r#"{"visual.stencils/v0": []}"#,
        r#"{"visual.stencils/v0": {"stencils": []}}"#,
        r#"{"visual.stencils/v0": {"stencils": "s"}}"#,
        "null",
    ] {
        assert!(read(facets).is_empty(), "{facets}");
    }
}

/// Past the cap the first stencils by name are kept, a name refused before
/// it counting for nothing.
#[test]
fn a_library_past_the_cap_keeps_its_first_stencils_by_name() {
    let mut entries: Vec<String> =
        (0..300).map(|n| format!(r#""s{n:03}": {{"displayName": "S"}}"#)).collect();
    entries.push(r#""A": {"displayName": "refused"}"#.to_owned());
    let library =
        read(&format!(r#"{{"visual.stencils/v0": {{"stencils": {{{}}}}}}}"#, entries.join(",")));
    assert_eq!(library.len(), 256);
    assert_eq!(library.first().map(|(name, _)| name.as_str()), Some("s000"));
    assert_eq!(library.last().map(|(name, _)| name.as_str()), Some("s255"));
}
