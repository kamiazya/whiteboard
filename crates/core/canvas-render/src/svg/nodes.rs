//! Each scene node kind drawn as an element.

use super::document_href::embed_href;
use super::format::{NonFinite, format_coord};
use super::icon::render_icon_use;
use super::paint::{PRESENTATION, appearance_attrs, positive_length, rect_attrs};
use super::render_edge::render_edge;
use super::runs::render_text_run;
use super::shapes::{box_glow_extent, glow_of, render_shape};
use super::vnode::{Attrs, Child, VNode};
use crate::finite_box::is_finite_box;
use whiteboard_det::math::js_min;
use whiteboard_scene::{
    CodeBlockNode, EmbedPlaceholderNode, GlyphSceneNode, ImageFit, ImageSceneNode, ListItemNode,
    SceneNode, SvgFragmentNode, SvgFragmentRole, TableCellSceneNode, TableRowSceneNode,
    TextRunNode, ThematicBreakNode,
};

type Drawn = Result<Child, NonFinite>;

/// A `<g>` holding each of `items` drawn by `draw`.
fn group_of<T>(attrs: Attrs, items: &[T], draw: impl Fn(&T) -> Drawn) -> Drawn {
    let children: Result<Vec<Child>, NonFinite> = items.iter().map(draw).collect();
    Ok(VNode::el("g", attrs, children?).into())
}

fn runs_of(runs: &[TextRunNode]) -> Result<Vec<Child>, NonFinite> {
    runs.iter().map(render_text_run).collect()
}

/// A wrapper that shifts its content by the box's own `x`: the only two kinds
/// (list item, table cell) that emit a transform, which is the x-transform
/// boundary the bounds walk knows.
fn shifted(x: f64, children: Vec<Child>) -> Drawn {
    let attrs = if x == 0.0 {
        Attrs::new()
    } else {
        Attrs::new().str("transform", &format!("translate({},0)", format_coord(x)?))
    };
    Ok(VNode::el("g", attrs, children).into())
}

fn render_list_item(item: &ListItemNode) -> Drawn {
    let children: Result<Vec<Child>, NonFinite> = item.children.iter().map(render_node).collect();
    shifted(item.bbox.x, children?)
}

fn render_table_cell(cell: &TableCellSceneNode) -> Drawn {
    shifted(cell.bbox.x, runs_of(&cell.runs)?)
}

fn render_table_row(row: &TableRowSceneNode) -> Drawn {
    // A hairline on the row's bottom edge is the whole of a table's chrome: no
    // cell grid, no zebra wash. Drawn at the row's own y so it separates this
    // row from the next rather than boxing either.
    let separator: Child = match &row.appearance {
        Some(appearance) if is_finite_box(&row.bbox) => {
            let line = whiteboard_scene::BoundingBox {
                x: row.bbox.x,
                y: row.bbox.y + row.bbox.h - 1.0,
                w: row.bbox.w,
                h: 1.0,
            };
            VNode::leaf(
                "rect",
                rect_attrs(&line)
                    .merge(appearance_attrs(Some(appearance)))
                    .str("role", PRESENTATION),
            )
            .into()
        }
        _ => Child::none(),
    };
    let cells: Result<Vec<Child>, NonFinite> = row.cells.iter().map(render_table_cell).collect();
    Ok(VNode::el("g", Attrs::new(), vec![separator, Child::List(cells?)]).into())
}

/// A fenced block: its tinted panel, then one `<text>` per source line.
///
/// The per-line form is not styling. SVG `<text>` collapses a newline to a
/// space, so a single element painted an entire fence on one line inside a box
/// sized for all of them. `runs` is absent only for a scene built before layout
/// carried them, which still renders through the old path rather than nothing.
fn render_code_block(node: &CodeBlockNode) -> Drawn {
    let panel: Child = match &node.appearance {
        Some(appearance) if is_finite_box(&node.bbox) => VNode::leaf(
            "rect",
            rect_attrs(&node.bbox)
                .opt_num("rx", positive_length(node.radius))
                .merge(appearance_attrs(Some(appearance)))
                .str("role", PRESENTATION),
        )
        .into(),
        _ => Child::none(),
    };
    let Some(runs) = &node.runs else {
        let text = VNode::el(
            "text",
            rect_attrs(&node.bbox).str("xml:space", "preserve"),
            vec![Child::Text(node.value.clone())],
        );
        return Ok(Child::List(vec![panel, text.into()]));
    };
    Ok(Child::List(vec![panel, Child::List(runs_of(runs)?)]))
}

/// Baseline drop below the bbox centre, as a fraction of the glyph size:
/// roughly half a typical glyph cap height, so the badge reads centred.
const GLYPH_BASELINE_FACTOR: f64 = 0.35;

fn render_svg_fragment(node: &SvgFragmentNode) -> Child {
    // Precondition: the caller has already validated `svg` is well-formed XML:
    // it is emitted verbatim, not escaped. A nested `<svg>` carries the
    // position: the fragment's own coordinates stay untouched and the wrapper's
    // x and y move them into document flow. This deliberately does NOT use a
    // transform, so the x-transform-boundary set stays exactly two: a fragment
    // has no scene-graph children for that machinery to see. Overflow stays
    // visible so a fragment taller than its reported size renders rather than
    // silently clipping. A non-finite box degrades to the unpositioned group
    // form (total rule, mirroring shape).
    let role = (node.role == Some(SvgFragmentRole::Presentation)).then_some(PRESENTATION);
    let raw = vec![Child::Raw(node.svg.clone())];
    if !is_finite_box(&node.bbox) {
        return VNode::el("g", Attrs::new().opt_str("role", role), raw).into();
    }
    let attrs = Attrs::new()
        .num("x", node.bbox.x)
        .num("y", node.bbox.y)
        .num("width", node.bbox.w)
        .num("height", node.bbox.h)
        .str("overflow", "visible")
        .opt_str("role", role);
    VNode::el("svg", attrs, raw).into()
}

fn render_glyph(node: &GlyphSceneNode) -> Child {
    if !is_finite_box(&node.bbox) || node.glyph.is_empty() {
        return Child::none();
    }
    // A single glyph sized to the smaller box side and centred via text-anchor
    // plus a fixed baseline offset. The offset approximates vertical centring
    // without `dominant-baseline`, whose resolution differs across renderers
    // (browsers and resvg) and would break the pixel agreement this backend
    // otherwise keeps.
    let size = js_min(node.bbox.w, node.bbox.h);
    let attrs = Attrs::new()
        .num("x", node.bbox.x + node.bbox.w / 2.0)
        .num("y", node.bbox.y + node.bbox.h / 2.0 + size * GLYPH_BASELINE_FACTOR)
        .num("font-size", size)
        .str("text-anchor", "middle");
    VNode::el("text", attrs, vec![Child::Text(node.glyph.clone())]).into()
}

fn render_image(node: &ImageSceneNode) -> Child {
    // Fixed attribute order (x y width height href preserveAspectRatio).
    // Aspect is always preserved; alt renders as a `<title>` child (the SVG
    // accessible-name mechanism), absence marks the image as presentation.
    let alt = node.alt.as_deref().filter(|a| !a.is_empty());
    let fit = if node.fit == Some(ImageFit::Cover) { "slice" } else { "meet" };
    let attrs = rect_attrs(&node.bbox)
        .str("href", &node.href)
        .str("preserveAspectRatio", &format!("xMidYMid {fit}"));
    let attrs = if alt.is_some() { attrs } else { attrs.str("role", PRESENTATION) };
    let children = alt
        .map(|a| vec![VNode::el("title", Attrs::new(), vec![Child::Text(a.to_string())]).into()])
        .unwrap_or_default();
    VNode::el("image", attrs, children).into()
}

fn render_icon_node(node: &whiteboard_scene::IconSceneNode) -> Drawn {
    let glow = glow_of(node.appearance.as_ref(), box_glow_extent(&node.bbox, None))?;
    Ok(render_icon_use(&node.icon, &node.bbox, node.appearance.as_ref(), glow, None)
        .unwrap_or_else(Child::none))
}

fn render_thematic_break(node: &ThematicBreakNode) -> Child {
    VNode::leaf(
        "rect",
        rect_attrs(&node.bbox)
            .merge(appearance_attrs(node.appearance.as_ref()))
            .str("role", PRESENTATION),
    )
    .into()
}

/// SVG `<text y>` is the BASELINE, so the box TOP would paint the title one
/// line above the placeholder's own space, colliding with the preceding block.
/// The node carries no measured ascent (it is not a text run), so the baseline
/// is derived from the box: 0.8 matches the ascent ratio the measurer contract
/// documents for body text.
fn render_embed_placeholder(node: &EmbedPlaceholderNode) -> Child {
    let text = VNode::el(
        "text",
        Attrs::new().num("x", node.bbox.x).num("y", node.bbox.y + node.bbox.h * 0.8),
        vec![Child::Text(node.title.clone())],
    );
    VNode::el("a", Attrs::new().str("href", &embed_href(&node.document_id)), vec![text.into()])
        .into()
}

/// A node that groups the nodes it holds, which inherit its paint.
fn container(attrs: Attrs, children: &[SceneNode]) -> Drawn {
    group_of(attrs, children, render_node)
}

pub(super) fn render_node(node: &SceneNode) -> Drawn {
    match node {
        SceneNode::TextRun(run) => render_text_run(run),
        SceneNode::Heading(n) => Ok(VNode::el("g", Attrs::new(), runs_of(&n.runs)?).into()),
        SceneNode::Paragraph(n) => Ok(VNode::el("g", Attrs::new(), runs_of(&n.runs)?).into()),
        SceneNode::List(n) => group_of(Attrs::new(), &n.items, render_list_item),
        SceneNode::CodeBlock(n) => render_code_block(n),
        // `fill-opacity` on the group is INHERITED by every descendant text run,
        // which is how quoted prose reads muted without naming a text colour
        // that would be wrong in one of the two host themes. The bar child sets
        // its own value, and a descendant's own presentation attribute wins over
        // the inherited one (it does not multiply).
        SceneNode::Blockquote(n) => container(
            appearance_attrs(n.appearance.as_ref()).str("role", PRESENTATION),
            &n.children,
        ),
        SceneNode::Group(n) => container(Attrs::new().str("role", PRESENTATION), &n.children),
        SceneNode::ThematicBreak(n) => Ok(render_thematic_break(n)),
        SceneNode::Table(n) => group_of(Attrs::new(), &n.rows, render_table_row),
        // Raw HTML has no independently verifiable well-formedness guarantee (it
        // is caller-supplied Markdown-embedded HTML), so it is escaped as text
        // rather than injected verbatim like a trusted SVG fragment.
        SceneNode::RawHtml(n) => {
            Ok(VNode::el("text", rect_attrs(&n.bbox), vec![Child::Text(n.value.clone())]).into())
        }
        SceneNode::UnresolvedReference(_) => {
            Ok(VNode::leaf("g", Attrs::new().str("role", PRESENTATION)).into())
        }
        SceneNode::SvgFragment(n) => Ok(render_svg_fragment(n)),
        SceneNode::EmbedPlaceholder(n) => Ok(render_embed_placeholder(n)),
        SceneNode::EmbedResolved(n) => container(Attrs::new(), &n.children),
        SceneNode::Edge(n) => render_edge(n),
        SceneNode::Shape(n) => render_shape(n),
        SceneNode::Icon(n) => render_icon_node(n),
        SceneNode::Glyph(n) => Ok(render_glyph(n)),
        SceneNode::Image(n) => Ok(render_image(n)),
    }
}
