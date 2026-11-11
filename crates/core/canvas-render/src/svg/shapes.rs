//! A node's silhouette and an edge's line, drawn: crisp geometry from the
//! shared outline decomposition, or the pencilled passes the ink module hands
//! back, each with the halo a glowing appearance asks for. The one place the
//! backend draws a shape from, so a silhouette kind added to the outline
//! module is drawn here and nowhere else.

use super::format::{NonFinite, format_coord};
use super::paint::{
    DROP_SHADOW_ID, Glow, PRESENTATION, appearance_attrs, drop_shadow_defs, id_token,
    non_negative_length, points_attr, positive_length, rect_attrs,
};
use super::vnode::{Attrs, Child, SvgDef, VNode};
use crate::edge_arrows::edge_arrow_polygons;
use crate::finite_box::is_finite_box;
use crate::glow::{GLOW_STD_DEVIATION_RATIO, glow_reach_px};
use crate::ink::{
    SKETCH_INK_REACH_PX, SKETCH_PASSES, SketchEdgeOptions, sketch_edge, sketch_shape,
};
use crate::node_outline::node_outline;
use whiteboard_det::math::{js_max, js_min};
use whiteboard_edge_routing::segment_intersection::EDGE_JUMP_RADIUS_PX;
use whiteboard_scene::{
    Appearance, BoundingBox, NodeOutline, ResolvedEdgeNode, SceneInk, ScenePoint, ShapeSceneNode,
};

type Drawn = Result<Child, NonFinite>;

/// The box a glowing element's own ink occupies, in its own user space:
/// min/max normalised, and widened by `reach_px` when the ink is pencilled and
/// may leave its geometry. None when nothing finite is left to glow.
fn glow_extent(points: &[ScenePoint], reach_px: f64) -> Option<BoundingBox> {
    let finite: Vec<&ScenePoint> =
        points.iter().filter(|p| p.x.is_finite() && p.y.is_finite()).collect();
    if finite.is_empty() {
        return None;
    }
    let low =
        |pick: fn(&ScenePoint) -> f64| finite.iter().fold(f64::INFINITY, |m, p| js_min(m, pick(p)));
    let high = |pick: fn(&ScenePoint) -> f64| {
        finite.iter().fold(f64::NEG_INFINITY, |m, p| js_max(m, pick(p)))
    };
    let x0 = low(|p| p.x) - reach_px;
    let y0 = low(|p| p.y) - reach_px;
    Some(BoundingBox {
        x: x0,
        y: y0,
        w: high(|p| p.x) + reach_px - x0,
        h: high(|p| p.y) + reach_px - y0,
    })
}

fn ink_reach_px(ink: Option<&SceneInk>) -> f64 {
    if ink.is_some() { SKETCH_INK_REACH_PX } else { 0.0 }
}

/// A boxed element's glow extent: its box's corners, so a negative width or
/// height normalises too.
pub(super) fn box_glow_extent(bbox: &BoundingBox, ink: Option<&SceneInk>) -> Option<BoundingBox> {
    glow_extent(
        &[
            ScenePoint { x: bbox.x, y: bbox.y },
            ScenePoint { x: bbox.x + bbox.w, y: bbox.y + bbox.h },
        ],
        ink_reach_px(ink),
    )
}

/// An edge's glow extent: its polyline, the arrowhead wings that reach past it,
/// and every hop's half-circle, which bulges off the line by the jump radius (on
/// a straight edge, the only ink off its zero-height axis).
pub(super) fn edge_glow_extent(node: &ResolvedEdgeNode) -> Option<BoundingBox> {
    let r = EDGE_JUMP_RADIUS_PX;
    let hops = node.jumps.iter().flatten().flat_map(|jump| {
        [ScenePoint { x: jump.x - r, y: jump.y - r }, ScenePoint { x: jump.x + r, y: jump.y + r }]
    });
    let wings = edge_arrow_polygons(node).into_iter().flat_map(|arrow| arrow.points);
    let points: Vec<ScenePoint> = node.path.iter().copied().chain(wings).chain(hops).collect();
    glow_extent(&points, ink_reach_px(node.ink.as_ref()))
}

/// The filter a glowing element references, and its definition: a Gaussian blur
/// of the element merged twice under the element itself (twice, so the halo has
/// body without a flood colour: it is the element's own paint).
///
/// The region is the element's OWN extent, padded by half its stroke and the
/// halo's reach, in user space. Two constraints shape it:
/// - A rasteriser allocates and blurs a layer the size of the region for every
///   element that references it, so a region that grows with the scene makes
///   export cost (glowing elements) x (scene area). Per element, it is bounded
///   by what each element draws.
/// - It is `userSpaceOnUse`, never `objectBoundingBox`: an axis-aligned
///   straight edge has a zero-width or zero-height box, and a box-relative
///   region over it has zero area, so the specification (and resvg) drop the
///   element entirely. A padded user-space box has area on both axes.
///
/// One definition per (radius, region); the id derives from both, so a repeated
/// id across inline-injected SVGs is byte-identical by construction.
pub(super) fn glow_of(
    appearance: Option<&Appearance>,
    extent: Option<BoundingBox>,
) -> Result<Glow, NonFinite> {
    let radius = non_negative_length(appearance.and_then(|a| a.glow).map(|g| g.radius_px));
    let (Some(radius), Some(extent)) = (radius.filter(|r| *r > 0.0), extent) else {
        return Ok(Glow::default());
    };
    if !is_finite_box(&extent) {
        return Ok(Glow::default());
    }
    let half_stroke =
        non_negative_length(appearance.and_then(|a| a.stroke_width)).map_or(0.0, |w| w / 2.0);
    let pad = (glow_reach_px(radius) + half_stroke).ceil();
    let region = BoundingBox {
        x: extent.x - pad,
        y: extent.y - pad,
        w: extent.w + 2.0 * pad,
        h: extent.h + 2.0 * pad,
    };
    let region_key = [region.x, region.y, region.w, region.h]
        .into_iter()
        .map(format_coord)
        .collect::<Result<Vec<_>, _>>()?
        .join(",");
    let id = format!("wb-glow-{}-{}", format_coord(radius)?, id_token(&region_key));
    let filter = glow_filter(&id, radius, &region);
    Ok(Glow { filter: Some(format!("url(#{id})")), defs: vec![SvgDef { id, node: filter }] })
}

/// The blur and its twofold merge over `region`, a user-space box.
fn glow_filter(id: &str, radius: f64, region: &BoundingBox) -> VNode {
    VNode::el(
        "filter",
        Attrs::new()
            .str("id", id)
            .str("filterUnits", "userSpaceOnUse")
            .num("x", region.x)
            .num("y", region.y)
            .num("width", region.w)
            .num("height", region.h),
        vec![
            VNode::leaf(
                "feGaussianBlur",
                Attrs::new()
                    .num("stdDeviation", radius * GLOW_STD_DEVIATION_RATIO)
                    .str("result", "blur"),
            )
            .into(),
            VNode::el(
                "feMerge",
                Attrs::new(),
                ["blur", "blur", "SourceGraphic"]
                    .map(|name| VNode::leaf("feMergeNode", Attrs::new().str("in", name)).into())
                    .to_vec(),
            )
            .into(),
        ],
    )
}

/// The box chrome of a spatial canvas node. A non-finite box field is a layout
/// defect this package must not crash on: it renders as nothing.
pub(super) fn render_shape(node: &ShapeSceneNode) -> Drawn {
    if !is_finite_box(&node.bbox) {
        return Ok(Child::none());
    }
    match node.ink {
        Some(ink) => render_sketch_shape(node, ink),
        None => render_crisp_shape(node),
    }
}

/// Presence-only: attach a glow's filter reference and definition to an element.
fn with_glow(element: VNode, glow: &Glow) -> Child {
    let Some(filter) = &glow.filter else { return element.into() };
    let attrs = element.attrs.clone().str("filter", filter);
    element.with_attrs(attrs).with_defs(glow.defs.clone()).into()
}

const HATCH_STROKE_WIDTH: f64 = 0.9;
const HATCH_OPACITY: f64 = 0.75;
/// The second pass of an outline is the pencil going over its own line: a
/// lighter stroke on the same paper. At full strength two passes read as a
/// doubled hairline rather than one hand-drawn line.
const SECOND_PASS_OPACITY: f64 = 0.55;

/// The opacity a pass is painted at; a stroke past the passes (an arrowhead
/// wing) keeps its own.
fn pass_opacity(index: usize, own: Option<f64>) -> Option<f64> {
    if index == 0 || index >= SKETCH_PASSES {
        return own;
    }
    Some(own.map_or(SECOND_PASS_OPACITY, |o| o * SECOND_PASS_OPACITY))
}

/// A pencilled stroke's attributes, in the order `d fill stroke stroke-width
/// stroke-opacity stroke-dasharray`, whether or not the opacity is set.
fn pencil_path(d: &str, paint: &Attrs, opacity: Option<f64>) -> Attrs {
    Attrs::new()
        .str("d", d)
        .str("fill", "none")
        .opt_str("stroke", paint.get_str("stroke"))
        .opt_num("stroke-width", paint.get_num("stroke-width"))
        .opt_num("stroke-opacity", opacity)
        .opt_str("stroke-dasharray", paint.get_str("stroke-dasharray"))
}

/// A pencilled node: the flat fill (or hatch lines) as an underlay, then the
/// strokes the shared decomposition hands back, round-capped so the passes read
/// as one pencil line. Comment chrome never arrives here (the layout inks
/// document content only), so the drop-shadow branch stays crisp.
fn render_sketch_shape(node: &ShapeSceneNode, ink: SceneInk) -> Drawn {
    let outline = node.shape.as_deref().and_then(|id| node_outline(id, &node.bbox));
    let strokes = sketch_shape(
        outline.as_ref(),
        &node.bbox,
        ink.seed,
        ink.fill == Some(whiteboard_scene::SceneInkFill::Hatch),
    );
    let paint = appearance_attrs(node.appearance.as_ref());
    let tint = sketch_tint(node, &paint)?;
    let hatch = match &strokes.hatch {
        None => Child::none(),
        Some(lines) => VNode::el(
            "g",
            Attrs::new().str("stroke-linecap", "round"),
            lines
                .iter()
                .map(|d| {
                    VNode::leaf(
                        "path",
                        Attrs::new()
                            .str("d", d)
                            .str("fill", "none")
                            .opt_str("stroke", paint.get_str("stroke"))
                            .num("stroke-width", HATCH_STROKE_WIDTH)
                            .num("stroke-opacity", HATCH_OPACITY),
                    )
                    .into()
                })
                .collect(),
        )
        .into(),
    };
    let glow = glow_of(node.appearance.as_ref(), box_glow_extent(&node.bbox, Some(&ink)))?;
    let outline_strokes = VNode::el(
        "g",
        Attrs::new().str("stroke-linecap", "round").str("stroke-linejoin", "round"),
        strokes
            .strokes
            .iter()
            .enumerate()
            .map(|(pass, d)| {
                let own = paint.get_num("stroke-opacity");
                VNode::leaf("path", pencil_path(d, &paint, pass_opacity(pass, own))).into()
            })
            .collect(),
    );
    Ok(Child::List(vec![Child::List(vec![tint, hatch]), with_glow(outline_strokes, &glow)]))
}

/// The crisp silhouette with its stroke removed: a hand draws no 6px fillet, so
/// the rect underlay drops its radius too. A hatched node keeps this tint UNDER
/// its lines, since a label sits on a coloured surface, not on bare accent
/// strokes.
fn sketch_tint(node: &ShapeSceneNode, paint: &Attrs) -> Drawn {
    let fill = match paint.get_str("fill") {
        None | Some("none") => return Ok(Child::none()),
        Some(fill) => fill,
    };
    let appearance = Appearance {
        fill: Some(fill.to_string()),
        fill_opacity: paint.get_num("fill-opacity"),
        ..Appearance::default()
    };
    let tinted = ShapeSceneNode { radius: None, appearance: Some(appearance), ..node.clone() };
    render_crisp_shape(&tinted)
}

fn render_crisp_shape(node: &ShapeSceneNode) -> Drawn {
    // Non-rect silhouettes come from the shared decomposition (one producer for
    // drawing and hit-testing); an absent `shape` stays the historic rect.
    let Some(id) = &node.shape else { return render_chrome_rect(node) };
    // A null outline here can only mean the id resolves to nothing, the
    // non-finite box already being handled above, so the node falls back to its
    // rect. Drawing NOTHING was correct while ids came from a closed union and
    // null meant a degenerate box; once a document can name a shape this build
    // does not carry, it made the node disappear.
    let Some(outline) = node_outline(id, &node.bbox) else { return render_chrome_rect(node) };
    let glow = glow_of(node.appearance.as_ref(), box_glow_extent(&node.bbox, None))?;
    let paint = appearance_attrs(node.appearance.as_ref());
    match outline {
        NodeOutline::Ellipse { cx, cy, rx, ry } => Ok(with_glow(
            VNode::leaf(
                "ellipse",
                Attrs::new().num("cx", cx).num("cy", cy).num("rx", rx).num("ry", ry).merge(paint),
            ),
            &glow,
        )),
        NodeOutline::Polygon { points } => Ok(with_glow(
            VNode::leaf("polygon", Attrs::new().str("points", &points_attr(&points)?).merge(paint)),
            &glow,
        )),
        NodeOutline::Cylinder { x, y, w, h, ry } => cylinder(x, y, w, h, ry, &paint, &glow),
    }
}

fn arc(rx: f64, ry: f64, sweep: u8, to_x: f64, at_y: f64) -> Result<String, NonFinite> {
    Ok(format!(
        "A {} {} 0 0 {sweep} {} {}",
        format_coord(rx)?,
        format_coord(ry)?,
        format_coord(to_x)?,
        format_coord(at_y)?
    ))
}

fn cylinder(x: f64, y: f64, w: f64, h: f64, ry: f64, paint: &Attrs, glow: &Glow) -> Drawn {
    let rx = w / 2.0;
    let top = y + ry;
    let bottom = y + h - ry;
    let silhouette = [
        format!("M {} {}", format_coord(x)?, format_coord(top)?),
        arc(rx, ry, 1, x + w, top)?,
        format!("L {} {}", format_coord(x + w)?, format_coord(bottom)?),
        arc(rx, ry, 1, x, bottom)?,
        "Z".to_string(),
    ]
    .join(" ");
    // The lid is the visible lower half of the top cap: stroke-only ink INSIDE
    // the silhouette, so bounds and hit keep reading the box.
    let lid =
        [format!("M {} {}", format_coord(x)?, format_coord(top)?), arc(rx, ry, 0, x + w, top)?]
            .join(" ");
    let parts: Vec<Child> = vec![
        VNode::leaf("path", Attrs::new().str("d", &silhouette).merge(paint.clone())).into(),
        VNode::leaf(
            "path",
            Attrs::new()
                .str("d", &lid)
                .str("fill", "none")
                .opt_str("stroke", paint.get_str("stroke"))
                .opt_num("stroke-width", paint.get_num("stroke-width"))
                .opt_num("stroke-opacity", paint.get_num("stroke-opacity")),
        )
        .into(),
    ];
    // Two siblings, unchanged, unless a glow needs the pair filtered as one: a
    // halo per part would double up along the lid.
    Ok(if glow.filter.is_none() {
        Child::List(parts)
    } else {
        with_glow(VNode::el("g", Attrs::new(), parts), glow)
    })
}

/// A pencilled edge: the drawn polyline (rounded corners and hops included,
/// through the same flattening the hit-test uses) in two bowed passes, and each
/// arrowhead as two wing strokes, with no marker, since a crisp triangle on a
/// pencil line is the one thing that reads as two styles at once.
pub(super) fn render_sketch_edge(node: &ResolvedEdgeNode, ink: SceneInk) -> Drawn {
    let arrows = edge_arrow_polygons(node);
    let strokes = sketch_edge(
        &node.path,
        ink.seed,
        &SketchEdgeOptions {
            arrows: &arrows,
            rounded: node.rounded,
            jumps: node.jumps.as_deref().unwrap_or(&[]),
        },
    );
    let paint = appearance_attrs(node.appearance.as_ref());
    let paths = strokes
        .iter()
        .enumerate()
        .map(|(pass, d)| {
            let attrs = pencil_path(d, &paint, pass_opacity(pass, paint.get_num("stroke-opacity")))
                .str("role", PRESENTATION);
            VNode::leaf("path", attrs).into()
        })
        .collect();
    let group = VNode::el(
        "g",
        Attrs::new().str("stroke-linecap", "round").str("stroke-linejoin", "round"),
        paths,
    );
    Ok(with_glow(group, &glow_of(node.appearance.as_ref(), edge_glow_extent(node))?))
}

/// The historic rect, also what a node falls back to when its shape id resolves
/// to nothing.
fn render_chrome_rect(node: &ShapeSceneNode) -> Drawn {
    let glow = glow_of(node.appearance.as_ref(), box_glow_extent(&node.bbox, None))?;
    let shadow = node.appearance.as_ref().is_some_and(|a| a.drop_shadow);
    let filter = if shadow { Some(format!("url(#{DROP_SHADOW_ID})")) } else { glow.filter.clone() };
    let mut attrs = rect_attrs(&node.bbox)
        .opt_num("rx", positive_length(node.radius))
        .merge(appearance_attrs(node.appearance.as_ref()))
        .opt_str("filter", filter.as_deref());
    if let Some(task) = &node.task_box {
        attrs = attrs
            .str("role", "checkbox")
            .str("aria-checked", if task.checked { "true" } else { "false" });
    }
    let rect = VNode::leaf("rect", attrs);
    Ok(if shadow {
        rect.with_defs(drop_shadow_defs()).into()
    } else if glow.filter.is_none() {
        rect.into()
    } else {
        rect.with_defs(glow.defs).into()
    })
}

#[cfg(test)]
mod tests {
    use super::edge_glow_extent;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_model::spatial::EdgeSide;
    use whiteboard_scene::{BoundingBox, EdgeEnd, EdgeJumpPoint, ResolvedEdgeNode, ScenePoint};

    fn edge(path: &[(f64, f64)], jumps: &[(f64, f64)]) -> ResolvedEdgeNode {
        ResolvedEdgeNode {
            id: "e".into(),
            jumps: Some(jumps.iter().map(|&(x, y)| EdgeJumpPoint { segment: 0.0, x, y }).collect()),
            path: path.iter().map(|&(x, y)| ScenePoint { x, y }).collect(),
            from_side: EdgeSide::Left,
            to_side: EdgeSide::Right,
            from_end: EdgeEnd::None,
            to_end: EdgeEnd::None,
            rounded: false,
            ink: None,
            comment_chrome: false,
            appearance: None,
        }
    }

    fn corners(b: Option<BoundingBox>) -> Option<[f64; 4]> {
        b.map(|b| [b.x, b.y, b.w, b.h])
    }

    #[test]
    fn a_hop_reaches_a_jump_radius_off_the_line_even_past_the_end_of_the_path() {
        // The hops at 12 and 97 reach to 7 and 102 either side of a path 10 to 100.
        let got =
            edge_glow_extent(&edge(&[(10.0, 0.0), (100.0, 0.0)], &[(12.0, 0.0), (97.0, 0.0)]));
        assert_eq!(corners(got), Some([7.0, -5.0, 95.0, 10.0]));
    }

    #[test]
    fn a_point_with_one_coordinate_that_is_not_finite_is_left_out_whole() {
        let got = edge_glow_extent(&edge(&[(0.0, 0.0), (50.0, f64::NAN), (100.0, 10.0)], &[]));
        assert_eq!(corners(got), Some([0.0, 0.0, 100.0, 10.0]));
        let got = edge_glow_extent(&edge(&[(f64::INFINITY, 4.0), (0.0, 0.0), (2.0, 8.0)], &[]));
        assert_eq!(corners(got), Some([0.0, 0.0, 2.0, 8.0]));
        assert_eq!(corners(edge_glow_extent(&edge(&[(f64::NAN, f64::NAN)], &[]))), None);
        assert_eq!(corners(edge_glow_extent(&edge(&[], &[]))), None);
    }
}
