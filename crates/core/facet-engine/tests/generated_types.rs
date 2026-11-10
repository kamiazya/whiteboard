//! The generated asset types: each closed set reads and writes the spelling
//! the Zod half accepts, a type with nothing chosen is the empty one, and the
//! matchers the contract names accept the strings its fixtures hold.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::checks::{facet_key, hex_color, namespaced_id};
use whiteboard_facet_engine::engine::{
    Fill, GroupFrameTokens, IconAsset, IconCircle, IconEllipse, IconGeometry, IconPath, IconRect,
    NodeStyleTokens, PaletteComment, PaletteNode, PalettePresets, PaletteProposal, PaletteSyntax,
    PaletteTokens, PresetAccent, StencilAsset, ThemeDefaults, ThemeEdgeRouting, ThemeGlow,
    ThemeInk, ThemePalette, ThemeTokens,
};
use whiteboard_model::Value;

#[test]
fn every_value_of_a_closed_set_reads_back_as_itself() {
    for ink in [ThemeInk::Clean, ThemeInk::Sketch] {
        assert_eq!(ThemeInk::from_wire(ink.as_str()), Some(ink));
    }
    for routing in
        [ThemeEdgeRouting::Straight, ThemeEdgeRouting::Orthogonal, ThemeEdgeRouting::Curved]
    {
        assert_eq!(ThemeEdgeRouting::from_wire(routing.as_str()), Some(routing));
    }
    assert_eq!(ThemeInk::Sketch.as_str(), "sketch");
    assert_eq!(ThemeEdgeRouting::Curved.as_str(), "curved");
}

#[test]
fn a_value_the_contract_does_not_write_is_no_member() {
    assert_eq!(ThemeInk::from_wire("neon"), None);
    assert_eq!(ThemeInk::from_wire("Clean"), None);
    assert_eq!(ThemeEdgeRouting::from_wire("zig"), None);
    assert_eq!(ThemeEdgeRouting::from_wire(""), None);
}

#[test]
fn the_first_value_of_a_closed_set_is_the_one_nothing_chosen_reads_as() {
    assert_eq!(ThemeInk::default(), ThemeInk::Clean);
    assert_eq!(ThemeEdgeRouting::default(), ThemeEdgeRouting::Straight);
}

#[test]
fn a_fill_is_a_colour_or_the_keyword_none() {
    let none = Fill::NoFill("none".to_owned());
    let hex = Fill::HexColor("#3d3d3d".to_owned());
    assert_ne!(none, hex);
    assert_eq!(Fill::default(), Fill::HexColor(String::new()));
    match (&none, &hex) {
        (Fill::NoFill(word), Fill::HexColor(colour)) => {
            assert_eq!(word, "none");
            assert!(hex_color(colour));
        }
        _ => unreachable!("the variants were just built"),
    }
    assert_eq!(none.clone(), none);
}

#[test]
fn an_icon_element_is_one_of_four_primitives_and_none_chosen_is_an_empty_path() {
    assert_eq!(IconGeometry::default(), IconGeometry::IconPath(IconPath::default()));
    assert_eq!((IconPath::TAG, IconRect::TAG), ("path", "rect"));
    assert_eq!((IconCircle::TAG, IconEllipse::TAG), ("circle", "ellipse"));
    let icon = IconAsset {
        view_box: Some("0 0 24 24".to_owned()),
        geometry: vec![
            IconGeometry::IconPath(IconPath { d: "M0 0".to_owned() }),
            IconGeometry::IconRect(IconRect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 2.0,
                rx: Some(1.0),
            }),
            IconGeometry::IconCircle(IconCircle { cx: 1.0, cy: 2.0, r: 3.0 }),
            IconGeometry::IconEllipse(IconEllipse { cx: 1.0, cy: 2.0, rx: 3.0, ry: 4.0 }),
        ],
    };
    assert_eq!(icon.clone(), icon);
    assert_eq!(IconAsset::default(), IconAsset { view_box: None, geometry: Vec::new() });
    assert_eq!(IconRect::default().rx, None);
}

#[test]
fn a_stencil_holds_facets_by_key_and_no_position() {
    let stencil = StencilAsset {
        display_name: "Datastore".to_owned(),
        color: Some("5".to_owned()),
        facets: vec![("paint.shape/v0".to_owned(), Value::Null)],
    };
    assert!(stencil.facets.iter().all(|(key, _)| facet_key(key)));
    assert_eq!(stencil.clone(), stencil);
    assert_eq!(
        StencilAsset::default(),
        StencilAsset { display_name: String::new(), color: None, facets: Vec::new() }
    );
}

fn style(fill: &str, stroke: &str) -> NodeStyleTokens {
    NodeStyleTokens { fill: Fill::HexColor(fill.to_owned()), stroke: stroke.to_owned() }
}

fn accent(stroke: &str, fill: &str) -> PresetAccent {
    PresetAccent { stroke: stroke.to_owned(), fill: fill.to_owned() }
}

fn palette() -> PaletteTokens {
    PaletteTokens {
        node: PaletteNode {
            text: style("#ffffff", "#3d3d3d"),
            file: style("#f5f5f5", "#3d3d3d"),
            link: style("#eef4ff", "#3d3d3d"),
            group: NodeStyleTokens {
                fill: Fill::NoFill("none".to_owned()),
                stroke: "#3d3d3d".to_owned(),
            },
        },
        edge_stroke: "#3d3d3d".to_owned(),
        label_fill: "#2a2a2a".to_owned(),
        surface: "#fffdf7".to_owned(),
        corner_radius_px: 2.0,
        presets: PalettePresets {
            n1: accent("#dc2626", "#fee2e2"),
            n2: accent("#ea580c", "#ffedd5"),
            n3: accent("#d97706", "#fef3c7"),
            n4: accent("#059669", "#d1fae5"),
            n5: accent("#0891b2", "#cffafe"),
            n6: accent("#9333ea", "#f3e8ff"),
        },
        syntax: PaletteSyntax {
            keyword: "#7e22ce".to_owned(),
            string: "#047857".to_owned(),
            number: "#c2410c".to_owned(),
            comment: "#5b6472".to_owned(),
        },
        comment: PaletteComment {
            pin: style("#d97706", "#ffffff"),
            bubble: style("#ffffff", "#d97706"),
        },
        proposal: PaletteProposal { edge: "#4f46e5".to_owned(), bubble_fill: "#ffffff".to_owned() },
        markdown_chrome: Some("#123456".to_owned()),
    }
}

#[test]
fn a_theme_holds_both_modes_and_defaults_that_are_empty_when_nothing_is_said() {
    let theme = ThemeTokens {
        ink: ThemeInk::Sketch,
        stroke_width_px: Some(1.4),
        font_family: Some("Yomogi".to_owned()),
        glow: Some(ThemeGlow { radius_px: 0.5 }),
        palette: ThemePalette { light: palette(), dark: palette() },
        defaults: ThemeDefaults {
            node_shape: Some("visual.diamond".to_owned()),
            edge_routing: Some(ThemeEdgeRouting::Curved),
            group_frame: Some(GroupFrameTokens {
                stroke_dasharray: Some("4 2".to_owned()),
                stroke_width: Some(1.5),
            }),
        },
    };
    assert_eq!(theme.clone(), theme);
    assert!(format!("{theme:?}").contains("Yomogi"));
    assert!(theme.defaults.node_shape.as_deref().is_some_and(namespaced_id));
    let colours = [
        &theme.palette.light.surface,
        &theme.palette.light.presets.n3.fill,
        &theme.palette.dark.syntax.comment,
        &theme.palette.dark.proposal.bubble_fill,
    ];
    assert!(colours.into_iter().all(|colour| hex_color(colour)));

    let bare = ThemeDefaults::default();
    assert_eq!(bare, ThemeDefaults { node_shape: None, edge_routing: None, group_frame: None });
    assert_eq!(GroupFrameTokens::default().stroke_width, None);
    let empty = ThemeTokens::default();
    assert_eq!(empty.defaults, bare);
    assert_eq!(empty.ink, ThemeInk::Clean);
    assert_eq!(empty.palette.light.markdown_chrome, None);
    assert_eq!(empty.palette, ThemePalette::default());
    assert_eq!(PalettePresets::default().n6, PresetAccent::default());
    assert_eq!(PaletteComment::default().pin, NodeStyleTokens::default());
    assert_eq!(PaletteNode::default().group.fill, Fill::default());
    assert_eq!(PaletteProposal::default().edge, "");
    assert_eq!(PaletteSyntax::default().keyword, "");
    assert_eq!(ThemeGlow::default(), ThemeGlow { radius_px: 0.0 });
}
