//! Drawing a REGISTERED icon: the one producer of a `<use>` that references one.
//!
//! The `icon` scene node and a text run that paints an icon share it rather
//! than each emitting their own `<symbol>`: the set's paint and coordinate
//! space live ON the definition, so a second emitter would be a second place
//! for them to be got wrong, and the two would then disagree about the same
//! icon depending on where it appeared.

use super::paint::{Glow, appearance_attrs, id_token};
use super::vnode::{Attrs, Child, SvgDef, VNode};
use crate::finite_box::is_finite_box;
use whiteboard_plugin_visual::render::{ICON_VIEWBOX, IconElement, icon_geometry};
use whiteboard_scene::{Appearance, BoundingBox};

/// The convention the vendored geometry is authored for: outline only, so the
/// stroke COLOUR is the single thing a referencing `<use>` assigns. Lucide's
/// own.
fn icon_paint() -> Attrs {
    Attrs::new()
        .str("fill", "none")
        .num("stroke-width", 2.0)
        .str("stroke-linecap", "round")
        .str("stroke-linejoin", "round")
}

fn render_icon_element(element: &IconElement) -> Child {
    match element {
        IconElement::Path { d } => VNode::leaf("path", Attrs::new().str("d", d)),
        IconElement::Rect { x, y, width, height, rx } => VNode::leaf(
            "rect",
            Attrs::new()
                .num("x", *x)
                .num("y", *y)
                .num("width", *width)
                .num("height", *height)
                .opt_num("rx", *rx),
        ),
        IconElement::Circle { cx, cy, r } => {
            VNode::leaf("circle", Attrs::new().num("cx", *cx).num("cy", *cy).num("r", *r))
        }
        IconElement::Ellipse { cx, cy, rx, ry } => VNode::leaf(
            "ellipse",
            Attrs::new().num("cx", *cx).num("cy", *cy).num("rx", *rx).num("ry", *ry),
        ),
    }
    .into()
}

/// A `<use>` of icon `name` drawn at `bbox`, or none when the table cannot draw
/// the name, which is a caller's decision to make: a node renders nothing, a run
/// paints its text.
///
/// `stroke` alone is assigned per reference, because that is the only paint a
/// `<use>` can push into the definition.
pub(super) fn render_icon_use(
    name: &str,
    bbox: &BoundingBox,
    appearance: Option<&Appearance>,
    glow: Glow,
    stroke_fallback: Option<&str>,
) -> Option<Child> {
    if !is_finite_box(bbox) {
        return None;
    }
    let geometry = icon_geometry(name)?;
    let id = format!("wb-icon-{}", id_token(name));
    let symbol = VNode::el(
        "symbol",
        Attrs::new().str("id", &id).str("viewBox", ICON_VIEWBOX),
        // The set's paint lives ON the definition; only the stroke COLOUR
        // inherits from each referencing `<use>`.
        vec![
            VNode::el("g", icon_paint(), geometry.iter().map(render_icon_element).collect()).into(),
        ],
    );
    let paint = appearance_attrs(appearance);
    let stroke = paint.get_str("stroke").or(stroke_fallback);
    let reference = VNode::leaf(
        "use",
        Attrs::new()
            .str("href", &format!("#{id}"))
            .num("x", bbox.x)
            .num("y", bbox.y)
            .num("width", bbox.w)
            .num("height", bbox.h)
            .opt_str("stroke", stroke)
            .opt_num("stroke-opacity", paint.get_num("stroke-opacity"))
            .opt_str("filter", glow.filter.as_deref()),
    );
    let mut defs = vec![SvgDef { id, node: symbol }];
    defs.extend(glow.defs);
    Some(reference.with_defs(defs).into())
}
