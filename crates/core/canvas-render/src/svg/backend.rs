//! The document: the envelope options, the assembled parts, and the entry
//! points that serialize them.

use super::filter_budget::bound_filter_work;
use super::format::{NonFinite, format_coord};
use super::hoist::hoist_inherited_attrs;
use super::legend::render_legend;
use super::nodes::render_node;
use super::paint::{PRESENTATION, rect_attrs};
use super::serialize::serialize_svg;
use super::vnode::{Attrs, Child, SvgDef, VNode};
use crate::finite_box::is_finite_box;
use crate::scene_bounds::{scene_bounds, scene_document_bounds};
use whiteboard_scene::{BoundingBox, Scene};

/// Document-envelope options for [`render_scene_to_svg`].
///
/// Activation rule: with no options, or options carrying none of the envelope
/// fields, the output is the legacy no-envelope form. Setting any envelope
/// field activates the full envelope (a derived `viewBox` plus `width` and
/// `height`) rather than a partial one, so there is exactly one enveloped shape.
///
/// The TypeScript's caller-supplied `icons` and `shapes` tables are not options
/// here: the bundled visual plugin's are always the tables.
#[derive(Debug, Clone, Default)]
pub struct SvgDocumentOptions {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub view_box: Option<BoundingBox>,
    pub padding: Option<f64>,
    pub background: Option<String>,
    /// An inheritable default text colour, emitted as `fill` on the root `<svg>`.
    /// Markdown body runs carry no fill of their own (inside the editor they
    /// inherit the host element's CSS `fill`), so a scene rendered standalone on
    /// a non-white background needs this to be self-describing. An empty value is
    /// omitted, never defaulted.
    pub text_fill: Option<String>,
    /// The host draws the legend itself (the editor's overlay). Not an envelope option.
    pub omit_legend: bool,
    /// Device pixels per user unit the document will be rasterised at (a PNG
    /// export's `scale`), default 1. Filter work is budgeted in device pixels, so
    /// a 2x export keeps a quarter of the filter area a 1x one does. Not an
    /// envelope option.
    pub raster_scale: Option<f64>,
}

fn has_envelope_options(o: &SvgDocumentOptions) -> bool {
    o.width.is_some()
        || o.height.is_some()
        || o.view_box.is_some()
        || o.padding.is_some()
        || o.background.is_some()
        || o.text_fill.as_deref().is_some_and(|fill| !fill.is_empty())
}

/// A negative width or height is invalid on both the root `<svg>` element and
/// `viewBox` (SVG spec): `x` and `y` may be negative (an offset), but `w` and
/// `h` must not be, so this is checked on top of plain finiteness.
fn is_usable_view_box(bbox: &BoundingBox) -> bool {
    is_finite_box(bbox) && bbox.w >= 0.0 && bbox.h >= 0.0
}

/// Non-finite or negative padding is not a valid expansion amount, so it is
/// treated as 0 and the function stays total.
fn sanitize_padding(padding: Option<f64>) -> f64 {
    padding.filter(|p| p.is_finite() && *p >= 0.0).unwrap_or(0.0)
}

fn expand_box(bbox: BoundingBox, padding: f64) -> BoundingBox {
    if padding.to_bits() == 0 {
        return bbox;
    }
    BoundingBox {
        x: bbox.x - padding,
        y: bbox.y - padding,
        w: bbox.w + padding * 2.0,
        h: bbox.h + padding * 2.0,
    }
}

fn resolve_view_box(scene: &Scene, options: &SvgDocumentOptions) -> BoundingBox {
    if let Some(view_box) = options.view_box.filter(is_usable_view_box) {
        return view_box;
    }
    // A derived envelope makes room for the legend it draws; an explicit one is
    // the caller's, who reserves the room with `scene_document_bounds`.
    let draws_legend = scene.legend.is_some() && !options.omit_legend;
    let bounds = if draws_legend { scene_document_bounds(scene) } else { scene_bounds(scene) };
    expand_box(bounds, sanitize_padding(options.padding))
}

/// A negative root-element width or height is invalid SVG, so it falls back to
/// the derived dimension, same as a non-finite value.
fn resolve_dimension(explicit: Option<f64>, fallback: f64) -> f64 {
    explicit.filter(|d| d.is_finite() && *d >= 0.0).unwrap_or(fallback)
}

const SVG_XMLNS: &str = "http://www.w3.org/2000/svg";

/// The document's assembled pieces, shared by [`render_scene_to_svg`] and the
/// keyed renderer so the two can never disagree on root attributes, defs,
/// background or per-entry bodies. `body` holds exactly one (possibly empty)
/// child per top-level scene entry, hoisted, in document order: the unit the
/// keyed renderer wraps and the scene-diff scoreboard counts.
pub(super) struct SvgDocumentParts {
    /// Fixed order: `xmlns [width height viewBox fill]`, the envelope rule.
    pub root_attrs: Attrs,
    pub defs: Child,
    pub background: Child,
    pub body: Vec<Child>,
    /// Drawn last, over the content; empty in a fragment.
    pub legend: Child,
}

/// The definitions the body references, as the document's single `<defs>`:
/// presence-only, exactly like an absent appearance attribute, so a scene
/// declaring none emits the same bytes it always has.
fn defs_child(collected: Vec<SvgDef>) -> Child {
    if collected.is_empty() {
        return Child::none();
    }
    VNode::el("defs", Attrs::new(), collected.into_iter().map(|def| def.node.into()).collect())
        .into()
}

/// The root's attributes in the envelope's fixed order `xmlns width height
/// viewBox fill`.
fn envelope_attrs(clip: &BoundingBox, options: &SvgDocumentOptions) -> Result<Attrs, NonFinite> {
    let view_box = format!(
        "{} {} {} {}",
        format_coord(clip.x)?,
        format_coord(clip.y)?,
        format_coord(clip.w)?,
        format_coord(clip.h)?
    );
    let fill = options.text_fill.as_deref().filter(|f| !f.is_empty());
    Ok(Attrs::new()
        .str("xmlns", SVG_XMLNS)
        .num("width", resolve_dimension(options.width, clip.w))
        .num("height", resolve_dimension(options.height, clip.h))
        .str("viewBox", &view_box)
        .opt_str("fill", fill))
}

/// The envelope's leading rect, document chrome rather than a per-node visual
/// attribute: the one exemption to the no-visual-attributes rule.
fn background_child(background: Option<&str>, clip: &BoundingBox) -> Child {
    match background {
        Some(fill) => {
            VNode::leaf("rect", rect_attrs(clip).str("fill", fill).str("role", PRESENTATION)).into()
        }
        None => Child::none(),
    }
}

pub(super) fn build_document_parts(
    scene: &Scene,
    options: Option<&SvgDocumentOptions>,
) -> Result<SvgDocumentParts, NonFinite> {
    // The optimisation passes are group-local by construction: the keyed
    // projection uses string equality as change detection, so a pass whose
    // output for one entry depended on another would dirty unrelated groups on
    // every edit.
    let rendered: Result<Vec<Child>, NonFinite> = scene
        .nodes
        .iter()
        .map(|node| render_node(node).map(|child| hoist_inherited_attrs(&child)))
        .collect();
    let envelope = options.filter(|o| has_envelope_options(o));
    // Filter regions are charged only inside the box that gets rasterised: the
    // envelope's viewBox when there is one, the scene's own bounds otherwise.
    let clip = match envelope {
        Some(o) => resolve_view_box(scene, o),
        None => scene_bounds(scene),
    };
    let (body, collected) =
        bound_filter_work(rendered?, &clip, options.and_then(|o| o.raster_scale));
    let defs = defs_child(collected);
    let Some(options) = envelope else {
        let root_attrs = Attrs::new().str("xmlns", SVG_XMLNS);
        return Ok(SvgDocumentParts {
            root_attrs,
            defs,
            background: Child::none(),
            body,
            legend: Child::none(),
        });
    };
    let background = background_child(options.background.as_deref(), &clip);
    let legend = match &scene.legend {
        Some(legend) if !options.omit_legend => render_legend(legend, &clip),
        _ => Child::none(),
    };
    Ok(SvgDocumentParts {
        root_attrs: envelope_attrs(&clip, options)?,
        defs,
        background,
        body,
        legend,
    })
}

/// Serializes a laid-out scene to an SVG string. Pure, no DOM: the same
/// implementation runs natively and on wasm32. Output follows the canonical
/// serialization rules (fixed attribute order, consistent escaping, single root
/// `xmlns`, one number formatter) so the same scene produces byte-identical SVG
/// everywhere.
///
/// With no `options` (or options with no envelope field set), the root element
/// carries only `xmlns`. Passing any envelope field activates the document
/// envelope: fixed root-attribute order `xmlns width height viewBox fill` (`fill`
/// only when `text_fill` is set), plus a leading `role="presentation"` background
/// rect (document chrome, not a per-node visual attribute) when `background` is
/// set.
pub fn render_scene_to_svg(
    scene: &Scene,
    options: Option<&SvgDocumentOptions>,
) -> Result<String, NonFinite> {
    let parts = build_document_parts(scene, options)?;
    let children = vec![parts.defs, parts.background, Child::List(parts.body), parts.legend];
    serialize_svg(&VNode::el("svg", parts.root_attrs, children))
}
