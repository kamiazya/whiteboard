//! A Rust scene as the canonical text the TypeScript's `dumpScene` writes: every
//! number as the hex of its 64 IEEE bits, keys sorted, nothing absent written.
//!
//! The scene is the production writer's tree (`scene_wire`), canonicalised, so
//! every recorded scene a replay compares holds that writer to the
//! TypeScript's field names as well as the layout to its geometry.

use whiteboard_canvas_render::scene_wire::{Tree, nodes_tree};
use whiteboard_scene::Scene;

/// A NaN's sign is the arithmetic's to choose, so every NaN is written as
/// `f64::NAN`, matching the TypeScript oracle's `canonicalNanHex`.
fn num(value: f64) -> String {
    let value = if value.is_nan() { f64::NAN } else { value };
    format!("#{:016x}", value.to_bits())
}

fn string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn canonical(tree: &Tree) -> String {
    match tree {
        Tree::Number(value) => num(*value),
        Tree::Text(value) => string(value),
        Tree::Flag(value) => value.to_string(),
        Tree::List(items) => {
            format!("[{}]", items.iter().map(canonical).collect::<Vec<_>>().join(","))
        }
        Tree::Object(fields) => {
            let mut fields: Vec<_> = fields.iter().collect();
            fields.sort_by(|a, b| a.0.cmp(b.0));
            let body: Vec<String> = fields
                .iter()
                .map(|(key, value)| format!("{}:{}", string(key), canonical(value)))
                .collect();
            format!("{{{}}}", body.join(","))
        }
    }
}

pub(crate) fn dump_scene(scene: &Scene) -> String {
    canonical(&Tree::Object(vec![("nodes", nodes_tree(&scene.nodes))]))
}
