use serde_json::{Map, Value, json};
use whiteboard_canvas_render::theme::appearance::{
    SpatialCommentAppearance, SpatialCommentChromeAppearance, SpatialNodeAppearance,
    SpatialProposalAppearance,
};
use whiteboard_canvas_render::theme::markdown::MarkdownTheme;
use whiteboard_canvas_render::theme::palette::{
    SpatialNodeStyle, SpatialPalette, SpatialPresetAccent, SpatialSyntaxPalette,
};
use whiteboard_scene::Appearance;

/// A double as the recording writes it: the hex of its IEEE bits, high word first.
pub(crate) fn hex(value: f64) -> Value {
    Value::String(format!("{:016x}", value.to_bits()))
}

fn put<T: Into<Value>>(map: &mut Map<String, Value>, key: &str, value: Option<T>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value.into());
    }
}

pub(crate) fn appearance(a: &Appearance) -> Value {
    let mut m = Map::new();
    put(&mut m, "fill", a.fill.as_deref());
    put(&mut m, "stroke", a.stroke.as_deref());
    put(&mut m, "strokeWidth", a.stroke_width.map(hex));
    put(&mut m, "fontFamily", a.font_family.as_deref());
    put(&mut m, "fontSize", a.font_size.map(hex));
    put(&mut m, "fillOpacity", a.fill_opacity.map(hex));
    put(&mut m, "strokeOpacity", a.stroke_opacity.map(hex));
    put(&mut m, "halo", a.halo.as_deref());
    put(&mut m, "strokeDasharray", a.stroke_dasharray.as_deref());
    put(&mut m, "dropShadow", a.drop_shadow.then_some(true));
    put(&mut m, "glow", a.glow.map(|g| json!({ "radiusPx": hex(g.radius_px) })));
    Value::Object(m)
}

pub(crate) fn node(n: &SpatialNodeAppearance) -> Value {
    let mut m = Map::new();
    put(&mut m, "radius", n.radius.map(hex));
    put(&mut m, "appearance", n.appearance.as_ref().map(appearance));
    Value::Object(m)
}

fn style(s: &SpatialNodeStyle) -> Value {
    json!({ "fill": s.fill, "stroke": s.stroke })
}

fn accent(a: &SpatialPresetAccent) -> Value {
    json!({ "stroke": a.stroke, "fill": a.fill })
}

pub(crate) fn syntax(s: &SpatialSyntaxPalette) -> Value {
    json!({ "keyword": s.keyword, "string": s.string, "number": s.number, "comment": s.comment })
}

pub(crate) fn palette(p: &SpatialPalette) -> Value {
    let mut m = Map::new();
    m.insert(
        "node".into(),
        json!({
            "text": style(&p.node.text),
            "file": style(&p.node.file),
            "link": style(&p.node.link),
            "group": style(&p.node.group),
        }),
    );
    m.insert("edgeStroke".into(), json!(p.edge_stroke));
    m.insert("labelFill".into(), json!(p.label_fill));
    m.insert("surface".into(), json!(p.surface));
    m.insert("cornerRadiusPx".into(), hex(p.corner_radius_px));
    m.insert(
        "presets".into(),
        json!({
            "1": accent(&p.presets.n1), "2": accent(&p.presets.n2), "3": accent(&p.presets.n3),
            "4": accent(&p.presets.n4), "5": accent(&p.presets.n5), "6": accent(&p.presets.n6),
        }),
    );
    m.insert("syntax".into(), syntax(&p.syntax));
    m.insert(
        "comment".into(),
        json!({ "pin": style(&p.comment.pin), "bubble": style(&p.comment.bubble) }),
    );
    m.insert(
        "proposal".into(),
        json!({ "edge": p.proposal.edge, "bubbleFill": p.proposal.bubble_fill }),
    );
    put(&mut m, "markdownChrome", p.markdown_chrome.as_deref());
    Value::Object(m)
}

pub(crate) fn proposal(p: &SpatialProposalAppearance) -> Value {
    json!({
        "outline": appearance(&p.outline),
        "bubble": appearance(&p.bubble),
        "leader": appearance(&p.leader),
    })
}

fn chrome(c: &SpatialCommentChromeAppearance) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("pin".into(), appearance(&c.pin));
    m.insert("bubble".into(), appearance(&c.bubble));
    m.insert("leader".into(), appearance(&c.leader));
    put(&mut m, "passage", c.passage.as_ref().map(appearance));
    put(&mut m, "pinCount", c.pin_count.as_ref().map(appearance));
    put(&mut m, "region", c.region.as_ref().map(appearance));
    put(&mut m, "text", c.text.as_ref().map(appearance));
    m
}

pub(crate) fn comment(c: &SpatialCommentAppearance) -> Value {
    let mut m = chrome(&c.chrome);
    m.insert("resolvedOverlay".into(), Value::Object(chrome(&c.resolved_overlay)));
    Value::Object(m)
}

pub(crate) fn markdown(t: &MarkdownTheme) -> Value {
    let [h1, h2, h3, h4, h5, h6] = t.heading_font_size_px;
    json!({
        "bodyFontSizePx": hex(t.body_font_size_px),
        "bodyLineHeight": hex(t.body_line_height),
        "headingLineHeight": hex(t.heading_line_height),
        "headingFontSizePx": {
            "1": hex(h1), "2": hex(h2), "3": hex(h3), "4": hex(h4), "5": hex(h5), "6": hex(h6),
        },
        "blockGapPx": hex(t.block_gap_px),
        "headingSpaceAbovePx": hex(t.heading_space_above_px),
        "listIndentPx": hex(t.list_indent_px),
        "listMarkerGapPx": hex(t.list_marker_gap_px),
        "listItemGapPx": hex(t.list_item_gap_px),
        "monoFontFamily": t.mono_font_family,
        "codeFontScale": hex(t.code_font_scale),
        "codeLineHeight": hex(t.code_line_height),
        "codeBlockPaddingPx": hex(t.code_block_padding_px),
        "inlineCodePaddingXPx": hex(t.inline_code_padding_x_px),
        "blockquoteBarWidthPx": hex(t.blockquote_bar_width_px),
        "blockquoteGapPx": hex(t.blockquote_gap_px),
        "tableCellPaddingXPx": hex(t.table_cell_padding_x_px),
        "tableCellPaddingYPx": hex(t.table_cell_padding_y_px),
        "thematicBreakHeightPx": hex(t.thematic_break_height_px),
        "borderWidthPx": hex(t.border_width_px),
        "cornerRadiusPx": hex(t.corner_radius_px),
        "chromeColor": t.chrome_color,
        "panelOpacity": hex(t.panel_opacity),
        "borderOpacity": hex(t.border_opacity),
        "mutedTextOpacity": hex(t.muted_text_opacity),
    })
}
