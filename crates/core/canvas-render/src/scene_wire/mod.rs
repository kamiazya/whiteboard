//! A laid-out scene as the TypeScript holds it: every node an object of the
//! `scene-graph.ts` shape, an absent field left out and a flag written only
//! when set, so a host decodes the answer of `layout_spatial_canvas` with
//! `JSON.parse` and holds the object the TypeScript composer would have built.
//!
//! The scene is not a published contract (owner decision q53): this is the
//! core speaking to its own shim, and the one writer of that shape. The test
//! dumper the scene oracles compare with is this tree canonicalised (keys
//! sorted, numbers as their bits), so every recorded scene holds the writer to
//! the TypeScript's field names.
//!
//! JSON has no spelling for NaN or an infinity, so a tree holding one has no
//! text ([`NonFinite`]) and the export refuses the layout: the host's
//! TypeScript then answers, and nothing reaches it changed.

mod nodes;

use whiteboard_det::format::js_number_to_string;
use whiteboard_scene::{LegendKey, LegendKind, Scene, SceneLegend};

pub use nodes::nodes_tree;

/// One value of the scene's object tree.
#[derive(Debug, Clone, PartialEq)]
pub enum Tree {
    Number(f64),
    Text(String),
    Flag(bool),
    List(Vec<Tree>),
    /// Fields in the order written; a key is never repeated.
    Object(Vec<(&'static str, Tree)>),
}

/// A number JSON cannot spell, so the tree has no text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NonFinite;

impl Tree {
    pub(crate) fn text(value: &str) -> Self {
        Self::Text(value.to_owned())
    }

    /// The tree as JSON text, every number spelled so that `JSON.parse` reads
    /// the same double back (`-0` included).
    ///
    /// # Errors
    /// [`NonFinite`] when the tree holds a NaN or an infinity.
    pub fn to_json(&self) -> Result<String, NonFinite> {
        let mut out = String::new();
        self.write(&mut out)?;
        Ok(out)
    }

    fn write(&self, out: &mut String) -> Result<(), NonFinite> {
        match self {
            Self::Number(value) => out.push_str(&json_number(*value)?),
            Self::Text(value) => write_string(value, out),
            Self::Flag(value) => out.push_str(if *value { "true" } else { "false" }),
            Self::List(items) => {
                out.push('[');
                for (at, item) in items.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    item.write(out)?;
                }
                out.push(']');
            }
            Self::Object(fields) => {
                out.push('{');
                for (at, (key, item)) in fields.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    write_string(key, out);
                    out.push(':');
                    item.write(out)?;
                }
                out.push('}');
            }
        }
        Ok(())
    }
}

/// A finite double as JSON: JavaScript's own spelling, which is the shortest
/// that reads back, and `-0` written as such, since JavaScript spells it `0`.
fn json_number(value: f64) -> Result<String, NonFinite> {
    if !value.is_finite() {
        return Err(NonFinite);
    }
    if value == 0.0 && value.is_sign_negative() {
        return Ok("-0".to_owned());
    }
    Ok(js_number_to_string(value))
}

fn write_string(value: &str, out: &mut String) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if u32::from(c) < 0x20 => {
                out.push_str("\\u00");
                let code = u32::from(c);
                out.extend([code >> 4, code & 0xf].map(|n| char::from_digit(n, 16).unwrap_or('0')));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn legend_key(key: &LegendKey) -> Tree {
    let of = match key.of {
        LegendKind::Boxes => "boxes",
        LegendKind::Edges => "edges",
    };
    let entries = key.entries.iter().map(|entry| {
        let mut swatch = Vec::new();
        swatch.extend(entry.swatch.fill.as_deref().map(|fill| ("fill", Tree::text(fill))));
        swatch.extend(entry.swatch.stroke.as_deref().map(|stroke| ("stroke", Tree::text(stroke))));
        Tree::Object(vec![
            ("value", Tree::text(&entry.value)),
            ("count", Tree::Number(entry.count)),
            ("swatch", Tree::Object(swatch)),
        ])
    });
    Tree::Object(vec![
        ("key", Tree::text(&key.key)),
        ("of", Tree::text(of)),
        ("entries", Tree::List(entries.collect())),
    ])
}

fn legend_tree(legend: &SceneLegend) -> Tree {
    let uncarried = Tree::Object(vec![
        ("boxes", Tree::Flag(legend.uncarried.boxes)),
        ("edges", Tree::Flag(legend.uncarried.edges)),
    ]);
    Tree::Object(vec![
        ("keys", Tree::List(legend.keys.iter().map(legend_key).collect())),
        ("uncarried", uncarried),
    ])
}

/// A scene as the TypeScript's `Scene`: its nodes, and its legend when it has one.
#[must_use]
pub fn scene_tree(scene: &Scene) -> Tree {
    let mut fields = vec![("nodes", nodes_tree(&scene.nodes))];
    fields.extend(scene.legend.as_ref().map(|legend| ("legend", legend_tree(legend))));
    Tree::Object(fields)
}

#[cfg(test)]
mod tests;
