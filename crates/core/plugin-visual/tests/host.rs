//! The bundled plugin loaded from the files the TypeScript package also reads:
//! the registry it builds holds the assets those files hold, in their order,
//! and a file that is not a plugin is refused rather than half loaded.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::plugin::LoadError;
use whiteboard_facet_engine::plugin_manifest::AssetKind;
use whiteboard_plugin_visual::host::{VisualSources, registry_from, visual_registry};

const MANIFEST: &str = include_str!("../../../../packages/plugin-visual/src/visual.manifest.json");
const CONTRACT: &str = include_str!("../../../../contracts/facets/visual/visual.schema.json");
const THEMES: &str = include_str!("../../../../packages/plugin-visual/src/assets/themes.json");
const STENCILS: &str = include_str!("../../../../packages/plugin-visual/src/assets/stencils.json");
const LUCIDE: &str =
    include_str!("../../../../packages/plugin-visual/src/assets/icons-lucide.json");
const GLYPHS: &str =
    include_str!("../../../../packages/plugin-visual/src/assets/icons-glyphs.json");

const SOURCES: VisualSources<'static> = VisualSources {
    manifest: MANIFEST,
    contract: CONTRACT,
    themes: THEMES,
    stencils: STENCILS,
    lucide_icons: LUCIDE,
    glyph_icons: GLYPHS,
};

#[test]
fn the_bundled_plugin_registers_its_themes_stencils_and_icons_in_file_order() {
    let registry = visual_registry().expect("the bundled plugin loads");
    assert_eq!(registry.registered(AssetKind::Themes), ["visual.sketch", "visual.neon"]);
    let stencils = registry.registered(AssetKind::Stencils);
    assert_eq!(stencils.len(), 6);
    assert_eq!(stencils.first().map(String::as_str), Some("visual.datastore"));
    let icons = registry.registered(AssetKind::Icons);
    let at = |id: &str| icons.iter().position(|held| held == id);
    assert!(icons.len() > 20, "only {} icons", icons.len());
    assert_eq!(at("visual.database"), Some(0));
    assert!(at("visual.user") < at("visual.edge-straight"));
    assert_eq!(icons.last().map(String::as_str), Some("visual.signature"));
}

#[test]
fn the_loaded_registry_knows_the_manifests_facets() {
    let registry = visual_registry().expect("the bundled plugin loads");
    assert!(registry.targets_of("visual.shape/v0").is_some());
    assert!(registry.targets_of("visual.nothing/v0").is_none());
}

#[test]
fn a_stencil_naming_a_facet_nobody_registered_is_refused() {
    let stencils = STENCILS.replace("visual.shape/v0", "visual.silhouette/v0");
    let error = registry_from(&VisualSources { stencils: &stencils, ..SOURCES }).err();
    assert!(matches!(error, Some(LoadError::StencilFacetUnregistered { .. })), "{error:?}");
}

#[test]
fn a_glyph_that_shadows_a_vendored_icon_is_refused() {
    let glyphs = r#"{"database": {"geometry": [{"tag": "path", "d": "M0 0"}]}}"#;
    let error = registry_from(&VisualSources { glyph_icons: glyphs, ..SOURCES }).err();
    assert_eq!(
        error,
        Some(LoadError::DuplicateAsset { kind: AssetKind::Icons, name: "database".to_owned() })
    );
}
