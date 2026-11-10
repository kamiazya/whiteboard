//! The generated manifest types: each closed set reads and writes the spelling
//! the Zod half accepts, and a manifest built from the types holds what its
//! contract names.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::checks::{facet_segment, namespaced_id, schema_ref, version_tag};
use whiteboard_facet_engine::plugin_manifest::{
    AssetKind, CatalogEntry, CompatEntry, EditorSpec, FacetDecl, FacetTarget, FieldSpec,
    FieldWidget, Glyph, GlyphAsset, GlyphChar, GlyphShape, GlyphShapeName, GlyphTheme,
    ManifestAssets, Picker, PickerCatalog, PickerLayout, PickerOption, PluginManifest,
    SegmentedOption,
};
use whiteboard_model::Value;

#[test]
fn every_value_of_a_closed_set_reads_back_as_itself() {
    for kind in [AssetKind::Themes, AssetKind::Icons, AssetKind::Stencils] {
        assert_eq!(AssetKind::from_wire(kind.as_str()), Some(kind));
    }
    for target in [FacetTarget::Document, FacetTarget::Canvas, FacetTarget::Node, FacetTarget::Edge]
    {
        assert_eq!(FacetTarget::from_wire(target.as_str()), Some(target));
    }
    for widget in [
        FieldWidget::Text,
        FieldWidget::Number,
        FieldWidget::Toggle,
        FieldWidget::Choice,
        FieldWidget::Segmented,
    ] {
        assert_eq!(FieldWidget::from_wire(widget.as_str()), Some(widget));
    }
    for shape in [
        GlyphShapeName::Square,
        GlyphShapeName::Circle,
        GlyphShapeName::Diamond,
        GlyphShapeName::Hexagon,
        GlyphShapeName::Octagon,
        GlyphShapeName::Parallelogram,
        GlyphShapeName::Cylinder,
        GlyphShapeName::None,
    ] {
        assert_eq!(GlyphShapeName::from_wire(shape.as_str()), Some(shape));
    }
    for layout in [PickerLayout::Chips, PickerLayout::Cards] {
        assert_eq!(PickerLayout::from_wire(layout.as_str()), Some(layout));
    }
}

#[test]
fn a_value_the_contract_does_not_write_is_no_member() {
    assert_eq!(AssetKind::from_wire("Themes"), None);
    assert_eq!(FacetTarget::from_wire("page"), None);
    assert_eq!(FieldWidget::from_wire("slider"), None);
    assert_eq!(GlyphShapeName::from_wire("triangle"), None);
    assert_eq!(PickerLayout::from_wire("grid"), None);
}

#[test]
fn each_glyph_arm_is_written_with_its_own_kind() {
    assert_eq!(GlyphShape::KIND, "shape");
    assert_eq!(GlyphChar::KIND, "char");
    assert_eq!(GlyphAsset::KIND, "asset");
    assert_eq!(GlyphTheme::KIND, "theme");
    assert_eq!(Glyph::default(), Glyph::GlyphShape(GlyphShape { name: GlyphShapeName::Square }));
}

/// A picker exercising every optional part: a theme glyph, a catalog with an entry.
fn demo_picker(option: PickerOption) -> Picker {
    Picker {
        options: Some(vec![option]),
        specimen_icon: Some("demo.dot".to_owned()),
        layout: Some(PickerLayout::Cards),
        catalog: Some(PickerCatalog {
            label: "Search".to_owned(),
            source: "demo.marks".to_owned(),
            entry: Some(CatalogEntry {
                label: "Any".to_owned(),
                placeholder: Some("Type".to_owned()),
                payload: vec![("kind".to_owned(), Value::String("emoji".to_owned()))],
                field: "char".to_owned(),
            }),
        }),
    }
}

/// A segmented field with an asset glyph.
fn demo_field() -> FieldSpec {
    FieldSpec {
        widget: FieldWidget::Segmented,
        label: Some("Routing".to_owned()),
        quick: Some(true),
        placeholder: None,
        options: Some(vec![SegmentedOption {
            value: "straight".to_owned(),
            label: "Straight".to_owned(),
            glyph: Some(Glyph::GlyphAsset(GlyphAsset { id: "demo.line".to_owned() })),
        }]),
        layout: Some(PickerLayout::Chips),
    }
}

/// A facet carrying an editor and a retained version.
fn demo_facet(picker: Picker) -> FacetDecl {
    FacetDecl {
        name: "mark".to_owned(),
        display_name: "Mark".to_owned(),
        version: "v1".to_owned(),
        targets: vec![FacetTarget::Node],
        schema: "facets/demo/demo.schema.json#/$defs/DemoMark".to_owned(),
        asset_refs: Some(vec![("theme".to_owned(), AssetKind::Themes)]),
        editor: Some(EditorSpec {
            picker: Some(picker),
            fields: Some(vec![("routing".to_owned(), demo_field())]),
        }),
        compat: Some(vec![(
            "v0".to_owned(),
            CompatEntry {
                schema: "facets/demo/demo.schema.json#/$defs/DemoMarkOld".to_owned(),
                migrate: "demo.step".to_owned(),
            },
        )]),
    }
}

#[test]
fn a_manifest_built_from_the_types_holds_what_its_contract_names() {
    let option = PickerOption {
        payload: Value::Null,
        label: "No mark".to_owned(),
        glyph: Some(Glyph::GlyphTheme(GlyphTheme {
            id: "demo.look".to_owned(),
            icon: "demo.dot".to_owned(),
        })),
        keywords: Some(vec!["none".to_owned()]),
    };
    let facet = demo_facet(demo_picker(option.clone()));
    let manifest = PluginManifest {
        id: "demo".to_owned(),
        display_name: "Demo".to_owned(),
        facets: vec![facet.clone()],
        assets: Some(ManifestAssets {
            themes: Some("demo.themes".to_owned()),
            icons: None,
            stencils: None,
        }),
    };
    assert!(facet_segment(&manifest.id) && facet_segment(&facet.name));
    assert!(version_tag(&facet.version) && schema_ref(&facet.schema));
    assert!(namespaced_id(manifest.assets.iter().flat_map(|a| &a.themes).next().map_or("", |s| s)));
    assert_eq!(PluginManifest::default().facets, Vec::new());
    assert_ne!(manifest, PluginManifest::default());
    assert_eq!(FacetDecl::default().targets, Vec::new());
    assert_eq!(option.payload, Value::default());
    assert_eq!(PickerOption::default().payload, Value::Null);
}
