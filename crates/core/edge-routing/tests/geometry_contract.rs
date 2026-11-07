//! The generated geometry types hold the contract's bounds on the wire, the
//! same refusals `rectSchema` makes on the TypeScript side.

use whiteboard_edge_routing::geometry::{Point, Rect};

#[test]
fn a_rect_within_bounds_parses() {
    let rect: Rect = serde_json::from_str(r#"{"x":-1,"y":2,"w":0,"h":3.5}"#).unwrap();
    assert_eq!(rect, Rect { x: -1.0, y: 2.0, w: 0.0, h: 3.5 });
}

#[test]
fn a_negative_size_is_refused() {
    let err = serde_json::from_str::<Rect>(r#"{"x":0,"y":0,"w":-0.5,"h":1}"#).unwrap_err();
    assert!(err.to_string().contains("Rect.w is below its minimum 0"), "{err}");
}

#[test]
fn an_unknown_key_is_refused_on_both_types() {
    assert!(serde_json::from_str::<Rect>(r#"{"x":0,"y":0,"w":1,"h":1,"z":0}"#).is_err());
    assert!(serde_json::from_str::<Point>(r#"{"x":0,"y":0,"z":0}"#).is_err());
}

#[test]
fn a_missing_field_is_refused() {
    assert!(serde_json::from_str::<Point>(r#"{"x":0}"#).is_err());
}

#[test]
fn a_positional_array_is_refused() {
    // serde's derived Deserialize also reads a sequence; Zod's strictObject
    // does not, so the generated types must refuse one too.
    assert!(serde_json::from_str::<Point>("[1,2]").is_err());
    assert!(serde_json::from_str::<Rect>("[0,0,1,1]").is_err());
}
