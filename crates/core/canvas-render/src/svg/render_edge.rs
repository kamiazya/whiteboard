//! How an EDGE is drawn: its path data (jumped, rounded), its arrowheads as
//! shared marker definitions, and the assembly of the two. Its own module
//! because it is the one node kind whose drawing is a subject of its own.

use super::format::{NonFinite, format_coord};
use super::paint::{PRESENTATION, appearance_attrs, id_token, points_attr};
use super::shapes::{edge_glow_extent, glow_of, render_sketch_edge};
use super::vnode::{Attrs, Child, SvgDef, VNode};
use crate::edge_arrows::{
    EdgeEndSide, MarkerDirection, arrow_marker_geometry, edge_arrow_ends, edge_arrow_inset,
    edge_arrow_scale,
};
use crate::edge_flatten::{hop_endpoints, jump_is_on, jumps_within_span, scene_point};
use whiteboard_det::format::js_number_to_string;
use whiteboard_det::math::hypot;
use whiteboard_edge_routing::edge_rounding::rounded_edge_corners;
use whiteboard_edge_routing::geometry::Point;
use whiteboard_edge_routing::segment_intersection::EDGE_JUMP_RADIUS_PX;
use whiteboard_scene::{EdgeJumpPoint, ResolvedEdgeNode, ScenePoint};

fn pair(point: ScenePoint) -> Result<String, NonFinite> {
    Ok(format!("{} {}", format_coord(point.x)?, format_coord(point.y)?))
}

/// Path commands for one straight run from `from` to `to`, hopping over each
/// jump point with a half-circle arc. Sweep 1 bulges to the LEFT of travel in
/// SVG's y-down coordinates (up, for a rightward run): the side the flattener
/// samples for hit-testing and the selection highlight. Jumps arrive ordered
/// along the run.
fn line_with_jumps(
    from: ScenePoint,
    to: ScenePoint,
    jumps: &[EdgeJumpPoint],
) -> Result<Vec<String>, NonFinite> {
    let radius = js_number_to_string(EDGE_JUMP_RADIUS_PX);
    let mut parts = Vec::new();
    for jump in jumps {
        let Some((entry, exit)) = hop_endpoints(from, to, ScenePoint { x: jump.x, y: jump.y })
        else {
            continue;
        };
        parts.push(format!("L {}", pair(entry)?));
        parts.push(format!("A {radius} {radius} 0 0 1 {}", pair(exit)?));
    }
    parts.push(format!("L {}", pair(to)?));
    Ok(parts)
}

/// The polyline as a path `d`, hopping over each jump on its segment.
fn jumped_path_data(path: &[ScenePoint], jumps: &[EdgeJumpPoint]) -> Result<String, NonFinite> {
    let Some(&first) = path.first() else { return Ok(String::new()) };
    let mut parts = vec![format!("M {}", pair(first)?)];
    for (seg, run) in path.windows(2).enumerate() {
        let [from, to] = run else { continue };
        let on: Vec<EdgeJumpPoint> = jumps.iter().filter(|j| jump_is_on(j, seg)).copied().collect();
        parts.extend(line_with_jumps(*from, *to, &on)?);
    }
    Ok(parts.join(" "))
}

/// The same polyline with its corners rounded off, per the shared corner
/// decomposition (the editor's hit-testing flattens the SAME corners, which is
/// what keeps a tap landing on the ink). Degenerate inputs fall back to the
/// straight reading rather than emitting a malformed `d`.
fn rounded_path_data(path: &[ScenePoint], jumps: &[EdgeJumpPoint]) -> Result<String, NonFinite> {
    let (Some(&first), Some(&last)) = (path.first(), path.last()) else {
        return Ok(String::new());
    };
    let mut parts = vec![format!("M {}", pair(first)?)];
    if path.len() < 3 {
        parts.extend(line_with_jumps(first, last, &jumps_within_span(jumps, 0, first, last))?);
        return Ok(parts.join(" "));
    }
    let mut current = first;
    let routed: Vec<Point> = path.iter().map(|p| Point { x: p.x, y: p.y }).collect();
    let corners = rounded_edge_corners(&routed);
    for (index, corner) in corners.iter().enumerate() {
        let (enter, control, leave) =
            (scene_point(corner.enter), scene_point(corner.control), scene_point(corner.leave));
        parts.extend(line_with_jumps(
            current,
            enter,
            &jumps_within_span(jumps, index, current, enter),
        )?);
        parts.push(format!("Q {} {}", pair(control)?, pair(leave)?));
        current = leave;
    }
    let tail = jumps_within_span(jumps, corners.len(), current, last);
    parts.extend(line_with_jumps(current, last, &tail)?);
    Ok(parts.join(" "))
}

fn arrow_marker_def(
    direction: MarkerDirection,
    fill: &str,
    scale: f64,
    inset: f64,
) -> Result<SvgDef, NonFinite> {
    let geometry = arrow_marker_geometry(direction, scale, inset);
    // A fixed-size head keeps its historical id, so a light line's output is
    // unchanged; a scaled one adds its size and reference to the id, which is
    // what tells two definitions in one colour apart.
    let size = if scale.to_bits() == 1.0f64.to_bits() && inset.to_bits() == 0 {
        String::new()
    } else {
        format!("-{}", id_token(&format!("{}-{}", format_coord(scale)?, format_coord(inset)?)))
    };
    let name = if direction == MarkerDirection::Start { "start" } else { "end" };
    let id = format!("wb-arrow-{name}-{}{size}", id_token(fill));
    let node = VNode::el(
        "marker",
        Attrs::new()
            .str("id", &id)
            .num("markerWidth", geometry.width)
            .num("markerHeight", geometry.height)
            .num("refX", geometry.ref_x)
            .num("refY", geometry.ref_y)
            .str("markerUnits", "userSpaceOnUse")
            .str("orient", "auto"),
        vec![
            VNode::leaf(
                "polygon",
                Attrs::new().str("points", &points_attr(&geometry.points)?).str("fill", fill),
            )
            .into(),
        ],
    );
    Ok(SvgDef { id, node })
}

/// The path with each arrowed end moved back along its terminal run, so a heavy
/// line's butt end sits under its head rather than poking past the tip. The
/// insets are 0 for a light line and for a run too short to shorten, which
/// returns the path as it was.
fn pulled_back(path: &[ScenePoint], from_inset: f64, to_inset: f64) -> Vec<ScenePoint> {
    if from_inset.to_bits() == 0 && to_inset.to_bits() == 0 {
        return path.to_vec();
    }
    let toward = |from: ScenePoint, to: ScenePoint, by: f64| {
        let length = hypot(to.x - from.x, to.y - from.y);
        ScenePoint {
            x: from.x + ((to.x - from.x) / length) * by,
            y: from.y + ((to.y - from.y) / length) * by,
        }
    };
    let last = path.len().saturating_sub(1);
    path.iter()
        .enumerate()
        .map(|(index, &point)| {
            let neighbour = |at: usize| path.get(at).copied().unwrap_or(point);
            if index == 0 && from_inset > 0.0 {
                toward(point, neighbour(1), from_inset)
            } else if index == last && to_inset > 0.0 {
                toward(point, neighbour(last.saturating_sub(1)), to_inset)
            } else {
                point
            }
        })
        .collect()
}

struct Arrowheads {
    start: Option<SvgDef>,
    end: Option<SvgDef>,
    path: Vec<ScenePoint>,
}

/// Arrowheads are shared `<marker>` definitions in the edge's stroke colour and
/// head size, referenced per end: one definition per (direction, colour, size)
/// instead of a polygon per edge end. Which ends get one is `edge_arrow_ends`,
/// the polygon renderer's own skip rule, because a marker on a direction-less
/// end would paint at angle 0 where the polygon drew nothing. Answers the path
/// to draw too, since a heavy line's arrowed ends are pulled back under their
/// heads.
fn arrowheads(node: &ResolvedEdgeNode) -> Result<Arrowheads, NonFinite> {
    // No stroke means the polyline itself is invisible (SVG's default stroke is
    // none), so the arrow must match it, not fall back to the marker content's
    // default black fill and float detached.
    let fill = node
        .appearance
        .as_ref()
        .and_then(|a| a.stroke.as_deref())
        .filter(|s| !s.is_empty())
        .unwrap_or("none");
    let (from, to) = edge_arrow_ends(node);
    let scale = edge_arrow_scale(node);
    let from_inset = if from { edge_arrow_inset(node, EdgeEndSide::From) } else { 0.0 };
    let to_inset = if to { edge_arrow_inset(node, EdgeEndSide::To) } else { 0.0 };
    Ok(Arrowheads {
        start: from
            .then(|| arrow_marker_def(MarkerDirection::Start, fill, scale, from_inset))
            .transpose()?,
        end: to
            .then(|| arrow_marker_def(MarkerDirection::End, fill, scale, to_inset))
            .transpose()?,
        path: pulled_back(&node.path, from_inset, to_inset),
    })
}

pub(super) fn render_edge(node: &ResolvedEdgeNode) -> Result<Child, NonFinite> {
    if let Some(ink) = node.ink {
        return render_sketch_edge(node, ink);
    }
    // `fill="none"` is not decoration. SVG's initial fill is black and a
    // `<polyline>` fills the region its points enclose, so a bent edge would
    // paint a solid wedge across its own corner in whatever fill the surrounding
    // document inherits; a `<path>` needs it for exactly the same reason.
    let jumps = node.jumps.as_deref().unwrap_or(&[]);
    let Arrowheads { start, end, path } = arrowheads(node)?;
    let marker = |def: &Option<SvgDef>| def.as_ref().map(|d| format!("url(#{})", d.id));
    let tail = |attrs: Attrs| -> Attrs {
        attrs
            .merge(appearance_attrs(node.appearance.as_ref()))
            .opt_str("marker-start", marker(&start).as_deref())
            .opt_str("marker-end", marker(&end).as_deref())
            .str("role", PRESENTATION)
    };
    let line = if node.rounded {
        VNode::leaf(
            "path",
            tail(Attrs::new().str("d", &rounded_path_data(&path, jumps)?).str("fill", "none")),
        )
    } else if !jumps.is_empty() {
        VNode::leaf(
            "path",
            tail(Attrs::new().str("d", &jumped_path_data(&path, jumps)?).str("fill", "none")),
        )
    } else {
        VNode::leaf(
            "polyline",
            tail(Attrs::new().str("points", &points_attr(&path)?).str("fill", "none")),
        )
    };
    let glow = glow_of(node.appearance.as_ref(), edge_glow_extent(node))?;
    let mut defs: Vec<SvgDef> = start.into_iter().chain(end).collect();
    defs.extend(glow.defs);
    let line = match &glow.filter {
        None => line,
        Some(filter) => {
            let attrs = line.attrs.clone().str("filter", filter);
            line.with_attrs(attrs)
        }
    };
    Ok(line.with_defs(defs).into())
}
