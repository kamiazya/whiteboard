//! The blocks with no children of their own, ported from `layoutBlock`'s arms
//! and `layoutMathBlock`, `placeFragment`: a thematic break, raw html, a
//! definition, display math and the fragment a renderer's markup becomes.

use whiteboard_scene::{
    BoundingBox, RawHtmlNode, SceneNode, SvgFragmentNode, ThematicBreakNode,
    UnresolvedReferenceNode,
};

use crate::xml_escape::escape_xml_text;

use super::options::{
    Cursor, TypesetOptions, body_line_height_px, code_line_height_px, finite_positive, js_min,
    panel_paint,
};
use super::phrasing::count_f64;
use super::seams::Rendered;

pub(super) fn layout_html(
    value: &str,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> SceneNode {
    let height = body_line_height_px(opts.theme);
    let node = RawHtmlNode {
        bbox: BoundingBox { x: cursor.x, y: cursor.y, w: opts.max_width, h: height },
        value: value.to_owned(),
    };
    cursor.y += height + opts.theme.block_gap_px;
    SceneNode::RawHtml(node)
}

pub(super) fn layout_rule(cursor: &mut Cursor, opts: &TypesetOptions<'_>) -> SceneNode {
    let theme = opts.theme;
    let node = ThematicBreakNode {
        bbox: BoundingBox {
            x: cursor.x,
            y: cursor.y,
            w: opts.max_width,
            h: theme.thematic_break_height_px,
        },
        appearance: Some(panel_paint(theme, theme.border_opacity)),
    };
    cursor.y += theme.thematic_break_height_px + theme.block_gap_px;
    SceneNode::ThematicBreak(node)
}

/// A definition carries no visual content of its own; the zero-height marker
/// keeps it in the scene for provenance without taking space.
pub(super) fn layout_definition(identifier: &str, cursor: &Cursor) -> SceneNode {
    SceneNode::UnresolvedReference(UnresolvedReferenceNode {
        bbox: BoundingBox { x: 0.0, y: cursor.y, w: 0.0, h: 0.0 },
        identifier: identifier.to_owned(),
    })
}

/// Places a renderer's fragment at the cursor, sized from what the renderer
/// reported. The width clamps to the column; a missing or unusable dimension
/// falls back to the column width and one code line, keeping layout total
/// against a renderer that reports garbage.
pub(super) fn place_fragment(
    rendered: Rendered,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> SceneNode {
    let (svg, width, height) = match rendered {
        Rendered::Markup(svg) => (svg, None, None),
        Rendered::Fragment { svg, width, height } => (svg, width, height),
    };
    let w = finite_positive(width).map_or(opts.max_width, |w| js_min(w, opts.max_width));
    let h = finite_positive(height).unwrap_or_else(|| code_line_height_px(opts.theme));
    let y = cursor.y;
    cursor.y += h + opts.theme.block_gap_px;
    SceneNode::SvgFragment(SvgFragmentNode {
        bbox: BoundingBox { x: 0.0, y, w, h },
        svg,
        role: None,
    })
}

/// What a math block is drawn as when no renderer answers: its source, escaped,
/// since it is untrusted text, unlike a renderer's own markup. The baseline is
/// in em because SVG `<text>` positions by baseline, and zero would paint the
/// source one line above its fragment.
fn default_math(value: &str) -> String {
    format!("<text y=\"0.8em\">{}</text>", escape_xml_text(value))
}

/// Display math. A renderer that fails or answers nothing leaves the source.
pub(super) fn layout_math(
    value: &str,
    cursor: &mut Cursor,
    opts: &TypesetOptions<'_>,
) -> SceneNode {
    let rendered = opts
        .math
        .and_then(|renderer| renderer.render_math(value))
        .unwrap_or_else(|| Rendered::Markup(default_math(value)));
    let Rendered::Markup(svg) = rendered else { return place_fragment(rendered, cursor, opts) };
    let lines = count_f64(value.split('\n').count());
    let height = lines * code_line_height_px(opts.theme);
    let node = SvgFragmentNode {
        bbox: BoundingBox { x: 0.0, y: cursor.y, w: opts.max_width, h: height },
        svg,
        role: None,
    };
    cursor.y += height + opts.theme.block_gap_px;
    SceneNode::SvgFragment(node)
}
