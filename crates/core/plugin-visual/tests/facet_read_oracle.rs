//! The plugin's facet readers against the recorded answers of the TypeScript.
//!
//! `packages/plugin-visual/src/oracle/facet-read-recorded-oracle.test.ts`
//! writes `facet-read.jsonl`: each reader asked of a bucket holding its key
//! with every payload the write recording holds for it, and of buckets holding
//! nothing it reads. This replays every line against the readers over the
//! registry the crate loads from the same files, exactly.

#[path = "common/value.rs"]
mod value;

use serde_json::{Value as Json, json};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::Value;
use whiteboard_model::spatial::ExtensionFacets;
use whiteboard_plugin_visual::host::visual_registry;
use whiteboard_plugin_visual::read;
use whiteboard_plugin_visual::visual::{
    VisualEdgesFacet, VisualShapeKind, VisualSymbolFacet, VisualTextAlign,
};

const RECORDING: &str =
    include_str!("../../../../packages/plugin-visual/src/oracle/facet-read.jsonl");

fn edges(style: &VisualEdgesFacet, routing: &str) -> Json {
    let mut out = serde_json::Map::new();
    if let Some(r) = style.routing {
        out.insert(routing.to_owned(), json!(r.as_str()));
    }
    if let Some(jumps) = style.line_jumps {
        out.insert("lineJumps".to_owned(), json!(jumps.as_str()));
    }
    Json::Object(out)
}

fn symbol(symbol: Option<VisualSymbolFacet>) -> Json {
    match symbol {
        Some(VisualSymbolFacet::VisualSymbolIcon(icon)) => {
            json!({"kind": "icon", "name": icon.name})
        }
        Some(VisualSymbolFacet::VisualSymbolEmoji(e)) => json!({"kind": "emoji", "char": e.char}),
        None => Json::Null,
    }
}

/// What the Rust reader answers, written as the TypeScript's answer is.
fn answer(reader: &str, facets: Option<&ExtensionFacets>, registry: &Registry) -> Json {
    match reader {
        "shape" => json!(read::node_shape(facets, registry).map(VisualShapeKind::as_str)),
        "text" => json!(read::node_text_align(facets, registry).map(VisualTextAlign::as_str)),
        "edges" => edges(&read::edges_style(facets, registry), "routing"),
        "canvas-edges" => edges(&read::edges_style(facets, registry), "style"),
        "stroke" => json!(read::stroke_width(facets, registry).map_or("thin", |w| w.as_str())),
        "theme" => json!(read::canvas_theme(facets, registry)),
        "stencil" => json!(read::node_stencil(facets, registry)),
        "symbol" => symbol(read::symbol(facets, registry)),
        other => json!({ "unknown reader": other }),
    }
}

#[test]
fn every_recorded_read_answers_as_the_typescript_answered_it() {
    let registry = visual_registry().expect("the bundled plugin loads");
    let mut replayed = 0;
    for line in RECORDING.lines() {
        let line: Json = serde_json::from_str(line).expect("a recorded line");
        let bucket = match &line["in"] {
            Json::Null => None,
            encoded => match value::decode(encoded) {
                Some(Value::Map(entries)) => Some(entries),
                other => panic!("a bucket that is not a mapping: {other:?}"),
            },
        };
        let reader = line["reader"].as_str().expect("a reader");
        assert_eq!(answer(reader, bucket.as_ref(), &registry), line["out"], "{line}");
        replayed += 1;
    }
    assert_eq!(replayed, 2003, "every recorded line replayed");
}
