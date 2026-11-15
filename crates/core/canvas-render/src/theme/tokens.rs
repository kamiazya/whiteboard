//! A plugin's theme assets read into the engine's token types (`ThemeTokens`),
//! and the table a layout resolves a theme id against (`resolveThemeTable`):
//! each asset under `<namespace>.<name>`. The registry checks an asset's shape
//! when the plugin loads and keeps only its id, so the values are read here,
//! from the same file.

use whiteboard_facet_engine::engine::{
    Fill, GroupFrameTokens, NodeStyleTokens, PaletteComment, PaletteNode, PalettePresets,
    PaletteProposal, PaletteSyntax, PaletteTokens, PresetAccent, ThemeDefaults, ThemeEdgeRouting,
    ThemeGlow, ThemeInk, ThemePalette, ThemeTokens,
};
use whiteboard_model::Value;

fn field<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    match value {
        Value::Map(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, v)| v),
        _ => None,
    }
}

fn opt_text(value: &Value, key: &str) -> Option<String> {
    match field(value, key)? {
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

fn opt_num(value: &Value, key: &str) -> Option<f64> {
    match field(value, key)? {
        Value::Number(n) => Some(*n),
        _ => None,
    }
}

fn style(value: Option<&Value>) -> Option<NodeStyleTokens> {
    let value = value?;
    let fill = opt_text(value, "fill")?;
    let fill = if fill == "none" { Fill::NoFill(fill) } else { Fill::HexColor(fill) };
    Some(NodeStyleTokens { fill, stroke: opt_text(value, "stroke")? })
}

fn accent(presets: &Value, key: &str) -> Option<PresetAccent> {
    let value = field(presets, key)?;
    Some(PresetAccent { stroke: opt_text(value, "stroke")?, fill: opt_text(value, "fill")? })
}

fn node(value: &Value) -> Option<PaletteNode> {
    Some(PaletteNode {
        text: style(field(value, "text"))?,
        file: style(field(value, "file"))?,
        link: style(field(value, "link"))?,
        group: style(field(value, "group"))?,
    })
}

fn presets(value: &Value) -> Option<PalettePresets> {
    Some(PalettePresets {
        n1: accent(value, "1")?,
        n2: accent(value, "2")?,
        n3: accent(value, "3")?,
        n4: accent(value, "4")?,
        n5: accent(value, "5")?,
        n6: accent(value, "6")?,
    })
}

fn syntax(value: &Value) -> Option<PaletteSyntax> {
    Some(PaletteSyntax {
        keyword: opt_text(value, "keyword")?,
        string: opt_text(value, "string")?,
        number: opt_text(value, "number")?,
        comment: opt_text(value, "comment")?,
    })
}

fn palette(value: &Value) -> Option<PaletteTokens> {
    let comment = field(value, "comment")?;
    let proposal = field(value, "proposal")?;
    Some(PaletteTokens {
        node: node(field(value, "node")?)?,
        edge_stroke: opt_text(value, "edgeStroke")?,
        label_fill: opt_text(value, "labelFill")?,
        surface: opt_text(value, "surface")?,
        corner_radius_px: opt_num(value, "cornerRadiusPx")?,
        presets: presets(field(value, "presets")?)?,
        syntax: syntax(field(value, "syntax")?)?,
        comment: PaletteComment {
            pin: style(field(comment, "pin"))?,
            bubble: style(field(comment, "bubble"))?,
        },
        proposal: PaletteProposal {
            edge: opt_text(proposal, "edge")?,
            bubble_fill: opt_text(proposal, "bubbleFill")?,
        },
        markdown_chrome: opt_text(value, "markdownChrome"),
    })
}

fn defaults(value: Option<&Value>) -> ThemeDefaults {
    let Some(value) = value else { return ThemeDefaults::default() };
    let group_frame = field(value, "groupFrame").map(|frame| GroupFrameTokens {
        stroke_dasharray: opt_text(frame, "strokeDasharray"),
        stroke_width: opt_num(frame, "strokeWidth"),
    });
    let edge_routing = opt_text(value, "edgeRouting").and_then(|r| ThemeEdgeRouting::from_wire(&r));
    ThemeDefaults { group_frame, edge_routing, node_shape: opt_text(value, "nodeShape") }
}

/// One theme asset as its token bundle; `None` when a field the contract
/// requires is missing or of another kind.
#[must_use]
pub fn theme_tokens(value: &Value) -> Option<ThemeTokens> {
    let ink = match opt_text(value, "ink")?.as_str() {
        "sketch" => ThemeInk::Sketch,
        _ => ThemeInk::Clean,
    };
    let modes = field(value, "palette")?;
    let glow = match field(value, "glow") {
        Some(glow) => Some(ThemeGlow { radius_px: opt_num(glow, "radiusPx")? }),
        None => None,
    };
    Some(ThemeTokens {
        ink,
        stroke_width_px: opt_num(value, "strokeWidthPx"),
        font_family: opt_text(value, "fontFamily"),
        glow,
        palette: ThemePalette {
            light: palette(field(modes, "light")?)?,
            dark: palette(field(modes, "dark")?)?,
        },
        defaults: defaults(field(value, "defaults")),
    })
}

/// A plugin's theme table (`assets/themes.json`, keyed by bare name) as the
/// layout's, each id namespaced; `None` when the text is not such a table.
#[must_use]
pub fn theme_table(namespace: &str, text: &str) -> Option<Vec<(String, ThemeTokens)>> {
    let Ok(Value::Map(entries)) = whiteboard_model::json::parse(text) else { return None };
    entries
        .iter()
        .map(|(name, value)| Some((format!("{namespace}.{name}"), theme_tokens(value)?)))
        .collect()
}
