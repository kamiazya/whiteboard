//! A run of inline text, drawn: the `<text>` element, the backdrop and halo
//! beneath it, the fade of a truncated run, and what a run paints in place of
//! its glyphs.

use super::document_href::document_href;
use super::format::{NonFinite, sanitize_href};
use super::icon::render_icon_use;
use super::paint::{PRESENTATION, appearance_attrs, non_negative_length, rect_attrs};
use super::shapes::{box_glow_extent, glow_of};
use super::vnode::{Attrs, Child, SvgDef, VNode};
use crate::finite_box::is_finite_box;
use crate::scene_bounds::TEXT_HALO_PAD_PX;
use whiteboard_model::checks::is_js_space;
use whiteboard_scene::{LinkProvenance, RunPaint, TextRunNode};

type Drawn = Result<Child, NonFinite>;

/// SVG `<text y>` is the BASELINE, not the top of the glyph box: `bbox.y` is
/// deliberately the line TOP (so bounds and digest keep reading a true top-left
/// box), so the two must never be conflated. A non-finite baseline is omitted
/// rather than reaching `format_coord`; an absent baseline reproduces
/// `y = bbox.y`.
fn text_baseline_y(run: &TextRunNode) -> f64 {
    match run.baseline {
        Some(baseline) if baseline.is_finite() => run.bbox.y + baseline,
        _ => run.bbox.y,
    }
}

/// Corner radius of a text run's backdrop pill (GitHub's inline code).
const BACKDROP_RADIUS_PX: f64 = 6.0;

/// The id of the one shared truncation-fade mask. A document embedding several
/// of these SVGs ends up with the id repeated, which is harmless precisely
/// because every copy is byte-identical: `url(#...)` resolves to the first, and
/// the first says the same as the rest.
const FADE_MASK_ID: &str = "wb-truncation-fade";

/// `maskContentUnits="objectBoundingBox"` is what makes ONE mask enough: its
/// content is expressed in the 0..1 box of whatever element references it, so
/// it scales to each run rather than needing a definition per run. Declared on
/// each truncated run and hoisted into the document's `<defs>`, which appears
/// exactly when something references the mask.
fn fade_defs() -> Vec<SvgDef> {
    let gradient_id = format!("{FADE_MASK_ID}-gradient");
    let gradient = VNode::el(
        "linearGradient",
        Attrs::new()
            .str("id", &gradient_id)
            .num("x1", 0.0)
            .num("y1", 0.0)
            .num("x2", 1.0)
            .num("y2", 0.0),
        vec![
            VNode::leaf("stop", Attrs::new().num("offset", 0.75).str("stop-color", "#ffffff"))
                .into(),
            VNode::leaf("stop", Attrs::new().num("offset", 1.0).str("stop-color", "#000000"))
                .into(),
        ],
    );
    let mask = VNode::el(
        "mask",
        Attrs::new().str("id", FADE_MASK_ID).str("maskContentUnits", "objectBoundingBox"),
        vec![
            VNode::leaf(
                "rect",
                Attrs::new()
                    .num("x", 0.0)
                    .num("y", 0.0)
                    .num("width", 1.0)
                    .num("height", 1.0)
                    .str("fill", &format!("url(#{gradient_id})")),
            )
            .into(),
        ],
    );
    vec![
        SvgDef { id: gradient_id, node: gradient },
        SvgDef { id: FADE_MASK_ID.to_string(), node: mask },
    ]
}

/// Inline emphasis the layout measured for: painted, or the flags are lies. A
/// link is underlined rather than recoloured because this backend is never
/// handed a palette: a run's fill is INHERITED from whatever host group the SVG
/// is dropped into, which lets one scene render on light and dark surfaces and
/// through resvg unchanged. Underline survives all three, and colour alone would
/// not satisfy WCAG 1.4.1 anyway.
fn emphasis_attrs(run: &TextRunNode) -> Attrs {
    let mut decorations = Vec::new();
    if run.deleted {
        decorations.push("line-through");
    }
    if run.link.is_some() {
        decorations.push("underline");
    }
    let attrs = Attrs::new();
    let attrs = if run.strong { attrs.str("font-weight", "700") } else { attrs };
    let attrs = if run.emphasis { attrs.str("font-style", "italic") } else { attrs };
    if decorations.is_empty() {
        attrs
    } else {
        attrs.str("text-decoration", &decorations.join(" "))
    }
}

/// The tinted box behind a run (inline code today). Bleeds `backdrop_pad_x_px`
/// past the run horizontally so the glyphs are not flush against the edge, and
/// stays inside the line box vertically so a backdrop can never overlap the line
/// above. A non-finite box renders as nothing.
fn render_backdrop(run: &TextRunNode) -> Child {
    let Some(backdrop) = &run.backdrop else { return Child::none() };
    if !is_finite_box(&run.bbox) {
        return Child::none();
    }
    let pad = non_negative_length(run.backdrop_pad_x_px).unwrap_or(0.0);
    let bbox = whiteboard_scene::BoundingBox {
        x: run.bbox.x - pad,
        y: run.bbox.y,
        w: run.bbox.w + 2.0 * pad,
        h: run.bbox.h,
    };
    VNode::leaf(
        "rect",
        rect_attrs(&bbox).num("rx", BACKDROP_RADIUS_PX).merge(appearance_attrs(Some(backdrop))),
    )
    .into()
}

/// What a run that PAINTS something instead of its text draws, or none to draw
/// the text after all. The substitution is the painter's alone: the run stays a
/// run, its `text` the alt, so passage anchoring matches the same quotes.
fn paint_run(run: &TextRunNode, paint: &RunPaint) -> Result<Option<Child>, NonFinite> {
    match paint {
        // `meet` rather than `slice`: an inline picture is sized to the line,
        // and cropping it to fill a text box would cut the thing the author put
        // there.
        RunPaint::Image { src } => {
            let alt = run.text.trim_matches(is_js_space);
            let attrs =
                rect_attrs(&run.bbox).str("href", src).str("preserveAspectRatio", "xMidYMid meet");
            let attrs = if alt.is_empty() { attrs.str("role", PRESENTATION) } else { attrs };
            let children = if alt.is_empty() {
                Vec::new()
            } else {
                vec![VNode::el("title", Attrs::new(), vec![Child::Text(alt.to_string())]).into()]
            };
            Ok(Some(VNode::el("image", attrs, children).into()))
        }
        // A body run names no fill of its own so it INHERITS the host's, and an
        // icon is stroked where prose is filled: no host sets a stroke, so asking
        // for `currentColor` is what makes the icon the colour the prose beside
        // it resolved to. A run that DOES name a fill (a link) hands it over.
        //
        // Falling through to the text is not a degradation to tidy away: a name
        // this table cannot draw has to say something, and the source the author
        // typed is the most useful thing it can say.
        RunPaint::Icon { name } => {
            let glow = glow_of(run.appearance.as_ref(), box_glow_extent(&run.bbox, None))?;
            let fill = run.appearance.as_ref().and_then(|a| a.fill.as_deref());
            Ok(render_icon_use(
                name,
                &run.bbox,
                run.appearance.as_ref(),
                glow,
                Some(fill.unwrap_or("currentColor")),
            ))
        }
    }
}

/// A surface-coloured pill under the whole text box (a glyph-outline halo leaves
/// the crossed line peeking through word spaces), so a label sitting ON an edge
/// stays readable end to end.
fn halo_underlay(run: &TextRunNode) -> Child {
    let Some(halo) = run.appearance.as_ref().and_then(|a| a.halo.as_deref()) else {
        return Child::none();
    };
    if halo.is_empty() {
        return Child::none();
    }
    let pad = TEXT_HALO_PAD_PX;
    VNode::leaf(
        "rect",
        Attrs::new()
            .num("x", run.bbox.x - pad)
            .num("y", run.bbox.y - pad)
            .num("width", run.bbox.w + 2.0 * pad)
            .num("height", run.bbox.h + 2.0 * pad)
            .num("rx", pad)
            .str("fill", halo),
    )
    .into()
}

pub(super) fn render_text_run(run: &TextRunNode) -> Drawn {
    if let Some(paint) = &run.paints
        && let Some(painted) = paint_run(run, paint)?
    {
        return Ok(painted);
    }
    let glow = glow_of(run.appearance.as_ref(), box_glow_extent(&run.bbox, None))?;
    let fade = run.truncated.then(|| format!("url(#{FADE_MASK_ID})"));
    // A code run's whitespace is CONTENT: XML collapses it otherwise, and a
    // fenced line loses the indentation that says what nests inside what.
    let attrs = Attrs::new()
        .num("x", run.bbox.x)
        .num("y", text_baseline_y(run))
        .merge(appearance_attrs(run.appearance.as_ref()))
        .merge(emphasis_attrs(run))
        .opt_str("filter", glow.filter.as_deref())
        .opt_str("mask", fade.as_deref())
        .opt_str("xml:space", run.code.then_some("preserve"));
    let mut defs = if run.truncated { fade_defs() } else { Vec::new() };
    defs.extend(glow.defs);
    let text = VNode::el("text", attrs, vec![Child::Text(run.text.clone())]).with_defs(defs);
    // The backdrop is painted before the halo underlay so a run can carry both
    // without the panel hiding the halo; inline code uses this for its tinted
    // pill.
    let content = Child::List(vec![render_backdrop(run), halo_underlay(run), text.into()]);
    let Some(link) = &run.link else { return Ok(content) };
    let href = match link {
        LinkProvenance::Link { href, .. } => sanitize_href(href),
        LinkProvenance::WikiLink { document_id, .. }
        | LinkProvenance::Embed { document_id, .. } => document_href(document_id),
    };
    Ok(VNode::el("a", Attrs::new().str("href", &href), vec![content]).into())
}
