//! A theme asset as the JSON the plugin ships it, read into the generated types.
//! The contract's own interpreter judges a payload and answers a value tree, not
//! these types, and the port has no caller that reads a bundle yet.

use serde_json::Value;
use whiteboard_facet_engine::engine::{
    Fill, GroupFrameTokens, NodeStyleTokens, PaletteComment, PaletteNode, PalettePresets,
    PaletteProposal, PaletteSyntax, PaletteTokens, PresetAccent, ThemeDefaults, ThemeEdgeRouting,
    ThemeGlow, ThemeInk, ThemePalette, ThemeTokens,
};

type Res<T> = Result<T, String>;

fn field<'a>(value: &'a Value, key: &str) -> Res<&'a Value> {
    value.get(key).ok_or_else(|| format!("missing {key}"))
}

fn text(value: &Value, key: &str) -> Res<String> {
    field(value, key)?.as_str().map(str::to_owned).ok_or_else(|| format!("{key} is not text"))
}

fn opt_text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn num(value: &Value, key: &str) -> Res<f64> {
    field(value, key)?.as_f64().ok_or_else(|| format!("{key} is not a number"))
}

fn style(value: &Value) -> Res<NodeStyleTokens> {
    let fill = text(value, "fill")?;
    let fill = if fill == "none" { Fill::NoFill(fill) } else { Fill::HexColor(fill) };
    Ok(NodeStyleTokens { fill, stroke: text(value, "stroke")? })
}

fn accent(value: &Value) -> Res<PresetAccent> {
    Ok(PresetAccent { stroke: text(value, "stroke")?, fill: text(value, "fill")? })
}

fn palette(value: &Value) -> Res<PaletteTokens> {
    let node = field(value, "node")?;
    let presets = field(value, "presets")?;
    let syntax = field(value, "syntax")?;
    let comment = field(value, "comment")?;
    let proposal = field(value, "proposal")?;
    Ok(PaletteTokens {
        node: PaletteNode {
            text: style(field(node, "text")?)?,
            file: style(field(node, "file")?)?,
            link: style(field(node, "link")?)?,
            group: style(field(node, "group")?)?,
        },
        edge_stroke: text(value, "edgeStroke")?,
        label_fill: text(value, "labelFill")?,
        surface: text(value, "surface")?,
        corner_radius_px: num(value, "cornerRadiusPx")?,
        presets: PalettePresets {
            n1: accent(field(presets, "1")?)?,
            n2: accent(field(presets, "2")?)?,
            n3: accent(field(presets, "3")?)?,
            n4: accent(field(presets, "4")?)?,
            n5: accent(field(presets, "5")?)?,
            n6: accent(field(presets, "6")?)?,
        },
        syntax: PaletteSyntax {
            keyword: text(syntax, "keyword")?,
            string: text(syntax, "string")?,
            number: text(syntax, "number")?,
            comment: text(syntax, "comment")?,
        },
        comment: PaletteComment {
            pin: style(field(comment, "pin")?)?,
            bubble: style(field(comment, "bubble")?)?,
        },
        proposal: PaletteProposal {
            edge: text(proposal, "edge")?,
            bubble_fill: text(proposal, "bubbleFill")?,
        },
        markdown_chrome: opt_text(value, "markdownChrome"),
    })
}

fn defaults(value: Option<&Value>) -> ThemeDefaults {
    let Some(value) = value else { return ThemeDefaults::default() };
    let group_frame = value.get("groupFrame").map(|frame| GroupFrameTokens {
        stroke_dasharray: opt_text(frame, "strokeDasharray"),
        stroke_width: frame.get("strokeWidth").and_then(Value::as_f64),
    });
    let edge_routing =
        value.get("edgeRouting").and_then(Value::as_str).and_then(ThemeEdgeRouting::from_wire);
    ThemeDefaults { group_frame, edge_routing, node_shape: opt_text(value, "nodeShape") }
}

pub(crate) fn theme_tokens(value: &Value) -> Res<ThemeTokens> {
    let ink = match text(value, "ink")?.as_str() {
        "sketch" => ThemeInk::Sketch,
        _ => ThemeInk::Clean,
    };
    let palette_value = field(value, "palette")?;
    Ok(ThemeTokens {
        ink,
        stroke_width_px: value.get("strokeWidthPx").and_then(Value::as_f64),
        font_family: opt_text(value, "fontFamily"),
        glow: value
            .get("glow")
            .map(|glow| num(glow, "radiusPx").map(|radius_px| ThemeGlow { radius_px }))
            .transpose()?,
        palette: ThemePalette {
            light: palette(field(palette_value, "light")?)?,
            dark: palette(field(palette_value, "dark")?)?,
        },
        defaults: defaults(value.get("defaults")),
    })
}
