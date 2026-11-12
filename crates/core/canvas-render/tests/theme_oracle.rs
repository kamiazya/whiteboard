//! The theme layer against the recorded answers of the TypeScript: palettes, the
//! spatial theme's resolvers over every node kind and colour, the themed
//! appearance over every bundled theme and the token shapes they do not reach,
//! and the markdown chrome (`theme.jsonl`). Every double is the hex of its IEEE
//! bits, so a last-bit difference is a failure.

mod theme_support;

use std::collections::BTreeMap;

use serde_json::{Value, json};
use theme_support::{dump, tokens::theme_tokens};
use whiteboard_canvas_render::theme::appearance::{RoutableElement, SpatialAppearanceResolver};
use whiteboard_canvas_render::theme::asset::{
    create_themed_appearance, markdown_theme, palette_from_tokens,
};
use whiteboard_canvas_render::theme::font::{
    SPATIAL_THEME_FONT_FAMILY, SPATIAL_THEME_FONT_STACK, TEXT_HALO_PAD_PX,
};
use whiteboard_canvas_render::theme::geometry::SPATIAL_THEME_GEOMETRY;
use whiteboard_canvas_render::theme::markdown::MarkdownTheme;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::palette::SpatialPalette;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_model::spatial::{
    CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine, NodeResource, SpatialNode,
};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

type Res<T> = Result<T, String>;

struct Corpus {
    themes: BTreeMap<String, ThemeTokens>,
    node_kinds: Vec<Option<NodeResource>>,
    colors: Vec<Option<String>>,
}

fn mode_of(text: &str) -> Res<SpatialThemeMode> {
    SpatialThemeMode::from_wire(text).ok_or_else(|| format!("unknown mode {text}"))
}

fn opt_mode(value: &Value) -> Res<Option<SpatialThemeMode>> {
    value.as_str().map(mode_of).transpose()
}

fn resource_of(value: &Value) -> Option<NodeResource> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    value.is_object().then(|| NodeResource {
        mime_type: text("mimeType").unwrap_or_default(),
        content: text("content"),
        location: text("location"),
        subpath: None,
    })
}

fn corpus_of(meta: &Value) -> Res<Corpus> {
    let corpus = meta.get("corpus").ok_or("meta has no corpus")?;
    let themes = corpus["themes"]
        .as_object()
        .ok_or("no themes")?
        .iter()
        .map(|(name, tokens)| Ok((name.clone(), theme_tokens(tokens)?)))
        .collect::<Res<_>>()?;
    let node_kinds = corpus["nodeKinds"]
        .as_array()
        .ok_or("no node kinds")?
        .iter()
        .map(|k| resource_of(&k["resource"]))
        .collect();
    let colors = corpus["colors"]
        .as_array()
        .ok_or("no colors")?
        .iter()
        .map(|c| c.as_str().map(str::to_owned))
        .collect();
    Ok(Corpus { themes, node_kinds, colors })
}

fn color_of(text: Option<&String>) -> Option<CanvasColor> {
    text.map(|t| {
        CanvasColorPreset::from_wire(t)
            .map_or_else(|| CanvasColor::CanvasColorHex(t.clone()), CanvasColor::CanvasColorPreset)
    })
}

fn theme_named<'c>(corpus: &'c Corpus, name: &Value) -> Res<Option<&'c ThemeTokens>> {
    name.as_str().map(|n| corpus.themes.get(n).ok_or_else(|| format!("no theme {n}"))).transpose()
}

fn resolver_of(corpus: &Corpus, spec: &Value) -> Res<Box<dyn SpatialAppearanceResolver>> {
    let mode = mode_of(spec["mode"].as_str().ok_or("no mode")?)?;
    Ok(match theme_named(corpus, &spec["theme"])? {
        None => Box::new(create_spatial_theme(mode, None)),
        Some(tokens) => Box::new(create_themed_appearance(
            tokens,
            mode,
            spec["family"].as_str().unwrap_or(SPATIAL_THEME_FONT_FAMILY),
        )),
    })
}

fn resolver_answer(corpus: &Corpus, spec: &Value) -> Res<Value> {
    let theme = resolver_of(corpus, spec)?;
    let mut nodes = Vec::new();
    for resource in &corpus.node_kinds {
        for color in &corpus.colors {
            let node = SpatialNode {
                resource: resource.clone(),
                color: color_of(color.as_ref()),
                ..SpatialNode::default()
            };
            nodes.push(dump::node(&theme.resolve_node(&node)));
        }
    }
    let edges = corpus.colors.iter().map(|c| {
        let edge = CanvasEdge { color: color_of(c.as_ref()), ..CanvasEdge::default() };
        theme
            .resolve_edge(RoutableElement::Edge(&edge))
            .as_ref()
            .map_or(Value::Null, dump::appearance)
    });
    let lines = corpus.colors.iter().map(|c| {
        let line = CanvasLine { color: color_of(c.as_ref()), ..CanvasLine::default() };
        theme
            .resolve_edge(RoutableElement::Line(&line))
            .as_ref()
            .map_or(Value::Null, dump::appearance)
    });
    Ok(json!({
        "mode": theme.mode().map_or(Value::Null, |m| json!(m.as_str())),
        "label": dump::appearance(&theme.resolve_label()),
        "syntax": theme.resolve_syntax().as_ref().map_or(Value::Null, dump::syntax),
        "comment": theme.resolve_comment().as_ref().map_or(Value::Null, dump::comment),
        "proposal": theme.resolve_proposal().as_ref().map_or(Value::Null, dump::proposal),
        "nodes": nodes,
        "edges": edges.collect::<Vec<_>>(),
        "lines": lines.collect::<Vec<_>>(),
    }))
}

fn palette_answer(corpus: &Corpus, record: &Value) -> Res<Value> {
    let mode = mode_of(record["mode"].as_str().ok_or("no mode")?)?;
    Ok(dump::palette(&match theme_named(corpus, &record["theme"])? {
        None if mode == SpatialThemeMode::Light => SpatialPalette::light(),
        None => SpatialPalette::dark(),
        Some(tokens) => {
            let palette = &tokens.palette;
            palette_from_tokens(if mode == SpatialThemeMode::Light {
                &palette.light
            } else {
                &palette.dark
            })
        }
    }))
}

fn constants() -> Value {
    json!({
        "fontFamily": SPATIAL_THEME_FONT_FAMILY,
        "fontStack": SPATIAL_THEME_FONT_STACK,
        "haloPadPx": dump::hex(TEXT_HALO_PAD_PX),
        "geometry": {
            "paddingPx": dump::hex(SPATIAL_THEME_GEOMETRY.padding_px),
            "labelFontSizePx": dump::hex(SPATIAL_THEME_GEOMETRY.label_font_size_px),
            "minContentWidthPx": dump::hex(SPATIAL_THEME_GEOMETRY.min_content_width_px),
        },
        "markdownNode": dump::markdown(&MarkdownTheme::node()),
        "markdownDocument": dump::markdown(&MarkdownTheme::document()),
        "markdownCompact": dump::markdown(&MarkdownTheme::compact()),
    })
}

fn answer(corpus: &Corpus, record: &Value) -> Res<Value> {
    match record["kind"].as_str().ok_or("no kind")? {
        "constants" => Ok(constants()),
        "palette" => palette_answer(corpus, record),
        "markdown" => Ok(dump::markdown(&markdown_theme(
            theme_named(corpus, &record["theme"])?,
            opt_mode(&record["mode"])?,
        ))),
        "resolver" => resolver_answer(corpus, &record["spec"]),
        other => Err(format!("unknown kind {other}")),
    }
}

/// The path of the first place two answers differ.
fn first_diff(got: &Value, want: &Value, path: &str) -> Option<String> {
    match (got, want) {
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|k| match (a.get(k), b.get(k)) {
                (Some(x), Some(y)) => first_diff(x, y, &format!("{path}.{k}")),
                (x, y) => Some(format!("{path}.{k}: got {x:?}, recorded {y:?}")),
            })
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .enumerate()
            .find_map(|(i, (x, y))| first_diff(x, y, &format!("{path}[{i}]"))),
        _ => (got != want).then(|| format!("{path}: got {got}, recorded {want}")),
    }
}

fn records() -> Res<Vec<Value>> {
    include_str!("../../../../packages/canvas-render/src/oracle/theme.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).map_err(|e| format!("{e}: {line}")))
        .collect()
}

#[test]
fn every_recorded_answer_is_reproduced_to_the_last_bit() {
    let records = records().unwrap_or_else(|e| panic!("{e}"));
    let meta = records.first().expect("the recording has a meta record");
    let corpus = corpus_of(meta).unwrap_or_else(|e| panic!("{e}"));
    let mut failures = Vec::new();
    for record in records.iter().skip(1) {
        let id = record["id"].as_str().unwrap_or("constants");
        match answer(&corpus, record) {
            Ok(got) => {
                if let Some(diff) = first_diff(&got, &record["out"], id) {
                    failures.push(diff);
                }
            }
            Err(e) => failures.push(format!("{id}: {e}")),
        }
    }
    assert!(records.len() >= 46, "the recording holds {} records", records.len());
    assert!(failures.is_empty(), "{} records differ; first: {}", failures.len(), failures[0]);
}

#[test]
fn the_corpus_reaches_every_kind_every_colour_and_both_bundled_themes() {
    let records = records().unwrap_or_else(|e| panic!("{e}"));
    let corpus = corpus_of(&records[0]).unwrap_or_else(|e| panic!("{e}"));
    assert!(corpus.node_kinds.len() >= 8 && corpus.node_kinds.iter().any(Option::is_none));
    assert!(corpus.colors.len() >= 15 && corpus.colors.contains(&None));
    for name in ["sketch", "neon", "bare"] {
        assert!(corpus.themes.contains_key(name), "{name}");
    }
    let resolvers = records.iter().filter(|r| r["kind"] == "resolver").count();
    assert!(resolvers >= 16, "{resolvers}");
}
