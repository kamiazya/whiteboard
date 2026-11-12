//! The theme layer as properties, stated from the token bundle a resolver was
//! built over and never from the port's own palette mapping: an explicit colour
//! on a node or an edge always wins over what a theme would have painted, a
//! preset replaces fill and stroke together, a kind with no colour takes its
//! kind's tokens, and a theme's weight, dash and glow reach exactly the elements
//! the contract names.

use whiteboard_canvas_render::theme::appearance::{RoutableElement, SpatialAppearanceResolver};
use whiteboard_canvas_render::theme::asset::{ThemedAppearanceCache, create_themed_appearance};
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_facet_engine::engine::{
    Fill, GroupFrameTokens, NodeStyleTokens, PresetAccent, ThemeDefaults, ThemeGlow, ThemeTokens,
};
use whiteboard_model::spatial::{
    CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine, NodeResource, SpatialNode,
};
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn hex() -> impl Strategy<Value = String> {
    "[0-9a-f]{6}".prop_map(|digits| format!("#{digits}"))
}

#[derive(Debug, Clone)]
struct Seed {
    hexes: Vec<String>,
    weight: Option<f64>,
    glow: Option<f64>,
    frame: Option<(Option<String>, Option<f64>)>,
}

fn seed() -> impl Strategy<Value = Seed> {
    (
        prop::collection::vec(hex(), 40),
        prop::option::of(0.25_f64..9.0),
        prop::option::of(1.0_f64..12.0),
        prop::option::of((prop::option::of("[0-9] [0-9]"), prop::option::of(0.5_f64..6.0))),
    )
        .prop_map(|(hexes, weight, glow, frame)| Seed { hexes, weight, glow, frame })
}

fn style(hexes: &[String], at: usize) -> NodeStyleTokens {
    let pick = |i: usize| hexes.get(i).cloned().unwrap_or_default();
    // An outlined node draws no fill, so `none` is as likely a token as a colour.
    let fill =
        if at.is_multiple_of(3) { Fill::NoFill("none".into()) } else { Fill::HexColor(pick(at)) };
    NodeStyleTokens { fill, stroke: pick(at + 1) }
}

fn tokens_of(seed: &Seed) -> ThemeTokens {
    let h = &seed.hexes;
    let pick = |i: usize| h.get(i).cloned().unwrap_or_default();
    let accent = |i: usize| PresetAccent { stroke: pick(i), fill: pick(i + 1) };
    let mut tokens = ThemeTokens::default();
    let palette = &mut tokens.palette.light;
    palette.node.text = style(h, 0);
    palette.node.file = style(h, 2);
    palette.node.link = style(h, 4);
    palette.node.group = style(h, 6);
    palette.edge_stroke = pick(8);
    palette.corner_radius_px = 3.0;
    palette.presets.n1 = accent(10);
    palette.presets.n2 = accent(12);
    palette.presets.n3 = accent(14);
    palette.presets.n4 = accent(16);
    palette.presets.n5 = accent(18);
    palette.presets.n6 = accent(20);
    tokens.palette.dark = tokens.palette.light.clone();
    tokens.stroke_width_px = seed.weight;
    tokens.glow = seed.glow.map(|radius_px| ThemeGlow { radius_px });
    tokens.defaults = ThemeDefaults {
        group_frame: seed
            .frame
            .clone()
            .map(|(dash, width)| GroupFrameTokens { stroke_dasharray: dash, stroke_width: width }),
        ..ThemeDefaults::default()
    };
    tokens
}

#[derive(Debug, Clone)]
enum Paint {
    Hex(String),
    Preset(u8),
    Absent,
    Invalid(String),
}

fn paint() -> impl Strategy<Value = Paint> {
    prop_oneof![
        3 => hex().prop_map(Paint::Hex),
        3 => (1_u8..=6).prop_map(Paint::Preset),
        2 => Just(Paint::Absent),
        2 => "[a-z0-9]{0,5}".prop_map(Paint::Invalid),
    ]
}

fn color_of(paint: &Paint) -> Option<CanvasColor> {
    match paint {
        Paint::Hex(text) => Some(CanvasColor::CanvasColorHex(text.clone())),
        Paint::Preset(n) => {
            CanvasColorPreset::from_wire(&n.to_string()).map(CanvasColor::CanvasColorPreset)
        }
        Paint::Absent => None,
        // A colour that is neither a preset key nor a hex: letters, so it can
        // never spell `1` to `6`, and no `#`.
        Paint::Invalid(text) => Some(CanvasColor::CanvasColorHex(format!("x{text}"))),
    }
}

/// Kinds: 0 text, 1 link, 2 file, 3 frame, 4 a resource nothing claims.
fn node_of(kind: u8, paint: &Paint) -> SpatialNode {
    let resource = |mime: &str, content: Option<&str>, location: Option<&str>| {
        Some(NodeResource {
            mime_type: mime.into(),
            content: content.map(Into::into),
            location: location.map(Into::into),
            subpath: None,
        })
    };
    let resource = match kind {
        0 => resource("text/markdown", Some("x"), None),
        1 => resource("text/uri-list", None, Some("https://example.com")),
        2 => resource("application/pdf", None, Some("a.pdf")),
        3 => None,
        _ => resource("application/x-unknown", None, None),
    };
    SpatialNode { resource, color: color_of(paint), ..SpatialNode::default() }
}

fn fill_text(style: &NodeStyleTokens) -> &str {
    match &style.fill {
        Fill::HexColor(text) | Fill::NoFill(text) => text,
    }
}

fn kind_style(tokens: &ThemeTokens, kind: u8) -> &NodeStyleTokens {
    let node = &tokens.palette.light.node;
    match kind {
        1 => &node.link,
        2 => &node.file,
        3 => &node.group,
        _ => &node.text,
    }
}

fn preset_of(tokens: &ThemeTokens, n: u8) -> &PresetAccent {
    let presets = &tokens.palette.light.presets;
    match n {
        1 => &presets.n1,
        2 => &presets.n2,
        3 => &presets.n3,
        4 => &presets.n4,
        5 => &presets.n5,
        _ => &presets.n6,
    }
}

fn run_node_case(
    tokens: &ThemeTokens,
    kind: u8,
    paint: &Paint,
    mode: SpatialThemeMode,
) -> Result<(), String> {
    let theme = create_themed_appearance(tokens, mode, "Roboto");
    let node = theme.resolve_node(&node_of(kind, paint));
    let appearance = node.appearance.ok_or("no appearance")?;
    let base = kind_style(tokens, kind);
    let (fill, stroke) = match paint {
        Paint::Hex(text) => (text.as_str(), base.stroke.as_str()),
        Paint::Preset(n) => {
            let accent = preset_of(tokens, *n);
            (accent.fill.as_str(), accent.stroke.as_str())
        }
        Paint::Absent | Paint::Invalid(_) => (fill_text(base), base.stroke.as_str()),
    };
    if appearance.fill.as_deref() != Some(fill) || appearance.stroke.as_deref() != Some(stroke) {
        return Err(format!("{paint:?} on kind {kind}: {appearance:?}, want {fill} / {stroke}"));
    }
    Ok(())
}

#[test]
fn an_explicit_colour_wins_a_preset_replaces_both_and_the_rest_take_the_kind() {
    let hexed = Floor::new("a node with a raw hex colour");
    let preset = Floor::new("a node with a preset colour");
    let plain = Floor::new("a node with no usable colour");
    check((seed(), 0_u8..5, paint(), prop::bool::ANY), None, |(seed, kind, paint, dark)| {
        hexed.draw(matches!(paint, Paint::Hex(_)));
        preset.draw(matches!(paint, Paint::Preset(_)));
        plain.draw(matches!(paint, Paint::Absent | Paint::Invalid(_)));
        let mode = if dark { SpatialThemeMode::Dark } else { SpatialThemeMode::Light };
        let result = run_node_case(&tokens_of(&seed), kind, &paint, mode);
        prop_assert!(result.is_ok(), "{result:?}");
        Ok(())
    });
    hexed.assert(40);
    preset.assert(40);
    plain.assert(40);
}

#[test]
fn an_edge_or_a_line_takes_a_hex_or_a_preset_stroke_and_otherwise_the_edge_stroke() {
    check((seed(), paint(), prop::bool::ANY), None, |(seed, paint, as_line)| {
        let tokens = tokens_of(&seed);
        let theme = create_themed_appearance(&tokens, SpatialThemeMode::Light, "Roboto");
        let color = color_of(&paint);
        let (edge, line) = (
            CanvasEdge { color: color.clone(), ..CanvasEdge::default() },
            CanvasLine { color, ..CanvasLine::default() },
        );
        let element =
            if as_line { RoutableElement::Line(&line) } else { RoutableElement::Edge(&edge) };
        let stroke = theme.resolve_edge(element).and_then(|a| a.stroke);
        let want = match &paint {
            Paint::Hex(text) => text.as_str(),
            Paint::Preset(n) => preset_of(&tokens, *n).stroke.as_str(),
            Paint::Absent | Paint::Invalid(_) => tokens.palette.light.edge_stroke.as_str(),
        };
        prop_assert_eq!(stroke.as_deref(), Some(want));
        Ok(())
    });
}

#[test]
fn a_theme_weight_dash_and_glow_reach_exactly_the_elements_the_contract_names() {
    let framed = Floor::new("a theme with a group frame");
    let glowing = Floor::new("a theme with a glow");
    check((seed(), 0_u8..5, paint()), None, |(seed, kind, paint)| {
        framed.draw(seed.frame.is_some());
        glowing.draw(seed.glow.is_some());
        let tokens = tokens_of(&seed);
        let theme = create_themed_appearance(&tokens, SpatialThemeMode::Light, "Roboto");
        let node = theme.resolve_node(&node_of(kind, &paint)).appearance.unwrap_or_default();
        let (dash, width) = seed.frame.clone().unwrap_or((None, None));
        let is_frame = kind == 3;
        prop_assert_eq!(
            node.stroke_width,
            if is_frame { width.or(seed.weight) } else { seed.weight }
        );
        prop_assert_eq!(node.stroke_dasharray, if is_frame { dash } else { None });
        prop_assert_eq!(node.glow.map(|g| g.radius_px), if is_frame { None } else { seed.glow });
        let edge =
            theme.resolve_edge(RoutableElement::Edge(&CanvasEdge::default())).unwrap_or_default();
        prop_assert_eq!(edge.stroke_width, seed.weight);
        prop_assert_eq!(edge.glow.map(|g| g.radius_px), seed.glow);
        let label = theme.resolve_label();
        prop_assert!(
            label.stroke_width.is_none() && label.glow.is_none() && label.stroke.is_none()
        );
        prop_assert_eq!(label.font_family.as_deref(), Some("Roboto"));
        Ok(())
    });
    framed.assert(40);
    glowing.assert(40);
}

#[test]
fn a_cache_answers_the_same_resolver_for_the_same_mode_and_family_and_no_other() {
    check(seed(), None, |seed| {
        let tokens = tokens_of(&seed);
        let mut cache = ThemedAppearanceCache::new(&tokens);
        let light = cache.get(SpatialThemeMode::Light, "Roboto");
        prop_assert!(std::rc::Rc::ptr_eq(&light, &cache.get(SpatialThemeMode::Light, "Roboto")));
        prop_assert!(!std::rc::Rc::ptr_eq(&light, &cache.get(SpatialThemeMode::Dark, "Roboto")));
        prop_assert!(!std::rc::Rc::ptr_eq(&light, &cache.get(SpatialThemeMode::Light, "Inter")));
        prop_assert_eq!(
            cache.get(SpatialThemeMode::Light, "Inter").resolve_label().font_family,
            Some("Inter".to_owned())
        );
        Ok(())
    });
}
