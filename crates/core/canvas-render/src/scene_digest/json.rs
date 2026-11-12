//! `JSON.stringify` of a [`SceneDigest`], key for key: the writer is the
//! contract's bytes, so it is not serde's, whose number text and key order are
//! its own. A number that is not finite is `null`, as `JSON.stringify` writes it.

use core::fmt::Write;

use whiteboard_det::format::js_number_to_string;
use whiteboard_scene::BoundingBox;

use super::SceneDigest;

fn quote(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn number(out: &mut String, x: f64) {
    if x.is_finite() {
        out.push_str(&js_number_to_string(x));
    } else {
        out.push_str("null");
    }
}

fn bbox(out: &mut String, b: &BoundingBox) {
    for (key, value) in [("{\"x\":", b.x), (",\"y\":", b.y), (",\"w\":", b.w), (",\"h\":", b.h)] {
        out.push_str(key);
        number(out, value);
    }
    out.push('}');
}

/// `items` between brackets, each written by `item`, commas between.
fn list<T>(out: &mut String, items: &[T], item: impl Fn(&mut String, &T)) {
    out.push('[');
    for (i, one) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        item(out, one);
    }
    out.push(']');
}

fn strings(out: &mut String, items: &[String]) {
    list(out, items, |o, s| quote(o, s));
}

impl SceneDigest {
    /// Exactly what `JSON.stringify` writes for the TypeScript digest of the same scene.
    #[must_use]
    pub fn to_json(&self) -> String {
        let mut out = String::from("{\"nodes\":");
        list(&mut out, &self.nodes, |o, n| {
            o.push_str("{\"id\":");
            quote(o, &n.id);
            o.push_str(",\"bbox\":");
            bbox(o, &n.bbox);
            let _ = write!(o, ",\"z\":{}", n.z);
            if n.truncated {
                o.push_str(",\"truncated\":true");
            }
            if n.overflows {
                o.push_str(",\"overflows\":true");
            }
            o.push('}');
        });
        out.push_str(",\"overlaps\":");
        list(&mut out, &self.overlaps, |o, pair| strings(o, pair));
        out.push_str(",\"containment\":");
        list(&mut out, &self.containment, |o, c| {
            o.push_str("{\"parent\":");
            quote(o, &c.parent);
            o.push_str(",\"child\":");
            quote(o, &c.child);
            o.push('}');
        });
        out.push_str(",\"clusters\":");
        list(&mut out, &self.clusters, |o, group| strings(o, group));
        out.push_str(",\"freeRegions\":");
        list(&mut out, &self.free_regions, bbox);
        out.push_str(if self.partial { ",\"partial\":true}" } else { ",\"partial\":false}" });
        out
    }
}
