//! The generated payload types: each closed set reads and writes the spelling
//! the Zod half accepts, and the two vocabularies shared with the model say
//! the same words there.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::Value;
use whiteboard_model::spatial as model;
use whiteboard_plugin_visual::checks::{
    canvas_color, facet_key, facet_segment, namespaced_id, tag_identifier,
};
use whiteboard_plugin_visual::visual::{
    EdgeRoutingStyle, LibraryStencil, LineJumps, TagKeyDeclaration, TagValueDeclaration,
    VisualAxesFacet, VisualEdgesFacet, VisualInkFacet, VisualShapeFacet, VisualShapeKind,
    VisualStencilFacet, VisualStencilsFacet, VisualStrokeFacet, VisualStrokeWidth,
    VisualSymbolFacet, VisualSymbolIcon, VisualTagsFacet, VisualTextAlign, VisualTextFacet,
    VisualThemeFacet,
};

#[test]
fn every_value_of_a_closed_set_reads_back_as_itself() {
    for kind in [
        VisualShapeKind::Ellipse,
        VisualShapeKind::Diamond,
        VisualShapeKind::Hexagon,
        VisualShapeKind::Parallelogram,
        VisualShapeKind::Cylinder,
        VisualShapeKind::Octagon,
    ] {
        assert_eq!(VisualShapeKind::from_wire(kind.as_str()), Some(kind));
    }
    for style in
        [EdgeRoutingStyle::Straight, EdgeRoutingStyle::Orthogonal, EdgeRoutingStyle::Curved]
    {
        assert_eq!(EdgeRoutingStyle::from_wire(style.as_str()), Some(style));
    }
    for jumps in [LineJumps::None, LineJumps::Arc] {
        assert_eq!(LineJumps::from_wire(jumps.as_str()), Some(jumps));
    }
    for align in [VisualTextAlign::Start, VisualTextAlign::Center] {
        assert_eq!(VisualTextAlign::from_wire(align.as_str()), Some(align));
    }
    for width in [VisualStrokeWidth::Medium, VisualStrokeWidth::Thick] {
        assert_eq!(VisualStrokeWidth::from_wire(width.as_str()), Some(width));
    }
}

#[test]
fn a_value_the_contract_does_not_write_is_no_member() {
    assert_eq!(VisualShapeKind::from_wire("rect"), None);
    assert_eq!(VisualStrokeWidth::from_wire("thin"), None);
    assert_eq!(VisualTextAlign::from_wire("end"), None);
    assert_eq!(VisualShapeKind::from_wire("Ellipse"), None);
    assert_eq!(EdgeRoutingStyle::from_wire("zig"), None);
    assert_eq!(LineJumps::from_wire("dash"), None);
}

#[test]
fn the_edge_vocabularies_say_the_same_words_as_the_model() {
    for style in
        [EdgeRoutingStyle::Straight, EdgeRoutingStyle::Orthogonal, EdgeRoutingStyle::Curved]
    {
        let theirs = model::EdgeRoutingStyle::from_wire(style.as_str());
        assert_eq!(theirs.map(model::EdgeRoutingStyle::as_str), Some(style.as_str()));
    }
    for jumps in [LineJumps::None, LineJumps::Arc] {
        let theirs = model::LineJumps::from_wire(jumps.as_str());
        assert_eq!(theirs.map(model::LineJumps::as_str), Some(jumps.as_str()));
    }
    assert_eq!(EdgeRoutingStyle::default().as_str(), model::EdgeRoutingStyle::default().as_str());
    assert_eq!(LineJumps::default().as_str(), model::LineJumps::default().as_str());
}

#[test]
fn a_sample_of_each_facet_holds_what_its_contract_names() {
    let edges = VisualEdgesFacet {
        routing: Some(EdgeRoutingStyle::Curved),
        line_jumps: Some(LineJumps::Arc),
    };
    assert_eq!(edges.routing.map(EdgeRoutingStyle::as_str), Some("curved"));
    assert_eq!(VisualEdgesFacet::default(), VisualEdgesFacet { routing: None, line_jumps: None });

    let shape = VisualShapeFacet { kind: VisualShapeKind::Hexagon };
    assert_eq!(shape.kind.as_str(), "hexagon");
    assert_eq!(VisualTextFacet { align: VisualTextAlign::Start }.align.as_str(), "start");
    assert_eq!(VisualStrokeFacet { width: VisualStrokeWidth::Thick }.width.as_str(), "thick");
    assert_eq!(VisualInkFacet { group: "g1".to_owned() }.group, "g1");

    let theme = VisualThemeFacet { theme: "visual.sketch".to_owned() };
    let stencil = VisualStencilFacet { stencil: "visual.datastore".to_owned() };
    assert!(namespaced_id(&theme.theme) && namespaced_id(&stencil.stencil));

    let axes = VisualAxesFacet { axes: vec!["visual.shape/v0".to_owned()] };
    assert!(axes.axes.iter().all(|key| facet_key(key)));
}

#[test]
fn a_symbol_with_nothing_chosen_is_an_icon_with_no_name() {
    let symbol = VisualSymbolFacet::default();
    assert_eq!(symbol, VisualSymbolFacet::VisualSymbolIcon(VisualSymbolIcon::default()));
    assert_eq!(VisualSymbolIcon::KIND, "icon");
}

#[test]
fn a_tag_library_holds_keys_by_identifier_and_values_with_a_colour() {
    let value = TagValueDeclaration {
        color: Some("#ff0000".to_owned()),
        description: Some("fine".to_owned()),
    };
    let key = TagKeyDeclaration {
        description: None,
        exclusive: Some(true),
        values: Some(vec![("ok".to_owned(), value.clone())]),
    };
    let facet = VisualTagsFacet { keys: vec![("health".to_owned(), key.clone())] };
    assert!(facet.keys.iter().all(|(name, _)| tag_identifier(name)));
    assert!(key.values.iter().flatten().all(|(name, _)| tag_identifier(name)));
    assert!(value.color.as_deref().is_some_and(canvas_color));
    assert_eq!(VisualTagsFacet::default().keys, Vec::new());
    assert_eq!(
        TagKeyDeclaration::default(),
        TagKeyDeclaration { description: None, exclusive: None, values: None }
    );
}

#[test]
fn a_stencil_library_holds_stencils_by_segment_and_facets_by_key() {
    let stencil = LibraryStencil {
        display_name: "Bucket".to_owned(),
        color: Some("5".to_owned()),
        facets: vec![("visual.shape/v0".to_owned(), Value::Null)],
    };
    let facet = VisualStencilsFacet { stencils: vec![("bucket".to_owned(), stencil.clone())] };
    assert!(facet.stencils.iter().all(|(name, _)| facet_segment(name)));
    assert!(stencil.facets.iter().all(|(key, _)| facet_key(key)));
    assert!(stencil.color.as_deref().is_some_and(canvas_color));
    assert_eq!(LibraryStencil::default().facets, Vec::new());
    assert_eq!(VisualStencilsFacet::default().stencils, Vec::new());
}
