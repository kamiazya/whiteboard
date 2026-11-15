//! A plugin's theme assets read into the engine's token types (`ThemeTokens`),
//! and the table a layout resolves a theme id against (`resolveThemeTable`):
//! each asset under `<namespace>.<name>`. The registry checks an asset's shape
//! when the plugin loads and keeps only its id, so the values are read here,
//! from the same file, and the reader is total: judging a shape is the
//! registry's, and a reader that could refuse halfway cost the artifact a
//! drop path per field.

use whiteboard_facet_engine::engine::{
    Fill, GroupFrameTokens, NodeStyleTokens, PaletteComment, PaletteNode, PalettePresets,
    PaletteProposal, PaletteSyntax, PaletteTokens, PresetAccent, ThemeDefaults, ThemeEdgeRouting,
    ThemeGlow, ThemeInk, ThemePalette, ThemeTokens,
};
use whiteboard_model::Value;

const NULL: Value = Value::Null;

fn field<'v>(value: &'v Value, key: &str) -> &'v Value {
    match value {
        Value::Map(entries) => entries.iter().find(|(name, _)| name == key).map_or(&NULL, |e| &e.1),
        _ => &NULL,
    }
}

fn opt_text(value: &Value, key: &str) -> Option<String> {
    match field(value, key) {
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

fn text(value: &Value, key: &str) -> String {
    opt_text(value, key).unwrap_or_default()
}

fn opt_num(value: &Value, key: &str) -> Option<f64> {
    match field(value, key) {
        Value::Number(n) => Some(*n),
        _ => None,
    }
}

fn style(value: &Value) -> NodeStyleTokens {
    let fill = text(value, "fill");
    let fill = if fill == "none" { Fill::NoFill(fill) } else { Fill::HexColor(fill) };
    NodeStyleTokens { fill, stroke: text(value, "stroke") }
}

fn accent(presets: &Value, key: &str) -> PresetAccent {
    let value = field(presets, key);
    PresetAccent { stroke: text(value, "stroke"), fill: text(value, "fill") }
}

fn palette(value: &Value) -> PaletteTokens {
    let (node, presets) = (field(value, "node"), field(value, "presets"));
    let (syntax, comment) = (field(value, "syntax"), field(value, "comment"));
    let proposal = field(value, "proposal");
    PaletteTokens {
        node: PaletteNode {
            text: style(field(node, "text")),
            file: style(field(node, "file")),
            link: style(field(node, "link")),
            group: style(field(node, "group")),
        },
        edge_stroke: text(value, "edgeStroke"),
        label_fill: text(value, "labelFill"),
        surface: text(value, "surface"),
        corner_radius_px: opt_num(value, "cornerRadiusPx").unwrap_or_default(),
        presets: PalettePresets {
            n1: accent(presets, "1"),
            n2: accent(presets, "2"),
            n3: accent(presets, "3"),
            n4: accent(presets, "4"),
            n5: accent(presets, "5"),
            n6: accent(presets, "6"),
        },
        syntax: PaletteSyntax {
            keyword: text(syntax, "keyword"),
            string: text(syntax, "string"),
            number: text(syntax, "number"),
            comment: text(syntax, "comment"),
        },
        comment: PaletteComment {
            pin: style(field(comment, "pin")),
            bubble: style(field(comment, "bubble")),
        },
        proposal: PaletteProposal {
            edge: text(proposal, "edge"),
            bubble_fill: text(proposal, "bubbleFill"),
        },
        markdown_chrome: opt_text(value, "markdownChrome"),
    }
}

fn defaults(value: &Value) -> ThemeDefaults {
    let frame = field(value, "groupFrame");
    let group_frame = (!matches!(frame, Value::Null)).then(|| GroupFrameTokens {
        stroke_dasharray: opt_text(frame, "strokeDasharray"),
        stroke_width: opt_num(frame, "strokeWidth"),
    });
    let edge_routing = opt_text(value, "edgeRouting").and_then(|r| ThemeEdgeRouting::from_wire(&r));
    ThemeDefaults { group_frame, edge_routing, node_shape: opt_text(value, "nodeShape") }
}

/// One theme asset, of a shape the engine contract accepts, as its token bundle.
#[must_use]
pub fn theme_tokens(value: &Value) -> ThemeTokens {
    let ink = if text(value, "ink") == "sketch" { ThemeInk::Sketch } else { ThemeInk::Clean };
    let modes = field(value, "palette");
    ThemeTokens {
        ink,
        stroke_width_px: opt_num(value, "strokeWidthPx"),
        font_family: opt_text(value, "fontFamily"),
        glow: opt_num(field(value, "glow"), "radiusPx").map(|radius_px| ThemeGlow { radius_px }),
        palette: ThemePalette {
            light: palette(field(modes, "light")),
            dark: palette(field(modes, "dark")),
        },
        defaults: defaults(field(value, "defaults")),
    }
}

/// A plugin's theme table (`assets/themes.json`, keyed by bare name) as the
/// layout's, each id namespaced; `None` when the text is not a mapping.
#[must_use]
pub fn theme_table(namespace: &str, text: &str) -> Option<Vec<(String, ThemeTokens)>> {
    let Ok(Value::Map(entries)) = whiteboard_model::json::parse(text) else { return None };
    let table =
        entries.iter().map(|(name, value)| (format!("{namespace}.{name}"), theme_tokens(value)));
    Some(table.collect())
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_facet_engine::engine::Fill;
    use whiteboard_plugin_visual::host::THEMES;

    use super::theme_table;

    #[test]
    fn a_fill_of_none_reads_as_no_fill_and_a_colour_as_one() {
        let table = theme_table("visual", THEMES).unwrap_or_default();
        let ids: Vec<&str> = table.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, ["visual.sketch", "visual.neon"]);
        for (_, tokens) in &table {
            let node = &tokens.palette.light.node;
            assert_eq!(node.group.fill, Fill::NoFill("none".to_owned()));
            assert_eq!(node.text.fill, Fill::HexColor("#ffffff".to_owned()));
        }
        assert_eq!(theme_table("visual", "[]"), None);
    }
}
