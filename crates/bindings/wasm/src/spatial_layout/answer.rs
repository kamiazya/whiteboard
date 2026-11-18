//! The answer of `layout_spatial_canvas`, as JSON text.

use whiteboard_canvas_render::compose_canvas::LaidOut;
use whiteboard_canvas_render::compose_node::Degradation;
use whiteboard_canvas_render::scene_wire::{Tree, scene_tree};
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_sides::EdgeAnchorPair;
use whiteboard_edge_routing::geometry::Point;
use whiteboard_scene::Scene;

use super::fragments::Ask;
use super::request::SvgAsk;
use super::svg::{MAX_SVG_BYTES, Unrendered, render};

fn text(value: &str) -> Tree {
    Tree::Text(value.to_owned())
}

fn outcome(kind: &str, rest: Vec<Tree>) -> String {
    let mut items = vec![text(kind)];
    items.extend(rest);
    // Strings alone, which always have text.
    Tree::List(items).to_json().unwrap_or_default()
}

pub(super) fn refused(code: &str, class: &str) -> String {
    outcome("refused", vec![text(code), text(class)])
}

/// What a request named that its content does not hold: a markdown body's
/// `#Heading` section.
pub(super) fn missing(what: &str) -> String {
    outcome("missing", vec![text(what)])
}

/// The fences, as `[lang, value]`, whose tokens the caller must send.
pub(super) fn needs(code: &[(String, String)]) -> String {
    let fence = |(lang, value): &(String, String)| Tree::List(vec![text(lang), text(value)]);
    outcome(
        "needs",
        vec![Tree::Object(vec![("code", Tree::List(code.iter().map(fence).collect()))])],
    )
}

const fn side_name(side: Side) -> &'static str {
    match side {
        Side::Top => "top",
        Side::Bottom => "bottom",
        Side::Left => "left",
        Side::Right => "right",
    }
}

fn point(p: Point) -> Tree {
    Tree::Object(vec![("x", Tree::Number(p.x)), ("y", Tree::Number(p.y))])
}

/// One anchor pair as the TypeScript's `EdgeAnchorPair`.
fn anchor(pair: &EdgeAnchorPair) -> Tree {
    let mut f = Vec::new();
    f.extend(pair.from.map(|p| ("from", point(p))));
    f.extend(pair.to.map(|p| ("to", point(p))));
    f.extend(pair.from_lane_depth.map(|d| ("fromLaneDepth", Tree::Number(d))));
    f.extend(pair.to_lane_depth.map(|d| ("toLaneDepth", Tree::Number(d))));
    f.extend(pair.from_side.map(|s| ("fromSide", text(side_name(s)))));
    f.extend(pair.to_side.map(|s| ("toSide", text(side_name(s)))));
    if pair.around {
        f.push(("around", Tree::Flag(true)));
    }
    Tree::Object(f)
}

/// One degradation as the TypeScript's `SpatialLayoutDegradation`.
fn event(event: &Degradation) -> Tree {
    let mut f = Vec::new();
    match event {
        Degradation::BodyParseFailed { node_id } => {
            f.extend([("kind", text("body-parse-failed")), ("nodeId", text(node_id))]);
        }
        Degradation::UnknownNodeKind { node_id, media_type } => f.extend([
            ("kind", text("unknown-node-kind")),
            ("nodeId", text(node_id)),
            ("type", text(media_type)),
        ]),
        Degradation::UnsupportedBackgroundStyle { node_id, style } => f.extend([
            ("kind", text("unsupported-background-style")),
            ("nodeId", text(node_id)),
            ("style", text(style.as_str())),
        ]),
        Degradation::UnknownTheme { theme } => {
            f.extend([("kind", text("unknown-theme")), ("theme", text(theme))]);
        }
        Degradation::FontMissing { family } => {
            f.extend([("kind", text("font-missing")), ("family", text(family))]);
        }
    }
    Tree::Object(f)
}

/// The degradations a layout reported, in order.
pub(super) fn events(reported: &[Degradation]) -> Tree {
    Tree::List(reported.iter().map(event).collect())
}

/// One fragment source as the TypeScript's `FragmentAsk`.
fn ask(ask: &Ask) -> Tree {
    Tree::Object(match ask {
        Ask::Math(value) => vec![("kind", text("math")), ("value", text(value))],
        Ask::Diagram { lang, value } => {
            vec![("kind", text("diagram")), ("lang", text(lang)), ("value", text(value))]
        }
    })
}

/// The SVG `ask` describes as the answer's last element, or the refusal that
/// answers instead: a scene holding a number the document cannot spell, or a
/// document past `max` bytes.
pub(super) fn svg_item(scene: &Scene, ask: &SvgAsk, max: usize) -> Result<Tree, String> {
    match render(scene, ask, max) {
        Ok(svg) => Ok(Tree::Text(svg)),
        Err(Unrendered::NonFinite) => Err(refused("malformed", "non-finite")),
        Err(Unrendered::TooLarge) => Err(refused("input-too-large", "svg")),
    }
}

/// The layout as the `ok` answer, the fragment sources it asked for next when
/// the request carried a table and the SVG it asked for last, or refused when
/// it holds a number JSON cannot spell, which no canvas the model admits holds
/// (its coordinates are safe integers), or an SVG past [`MAX_SVG_BYTES`].
pub(super) fn laid_out(
    laid: &LaidOut,
    degradations: &[Degradation],
    asked: Option<Vec<Ask>>,
    svg: Option<&SvgAsk>,
) -> String {
    let anchors = laid.anchors.iter().map(|(id, pair)| Tree::List(vec![text(id), anchor(pair)]));
    let mut items = vec![
        text("ok"),
        scene_tree(&laid.scene),
        Tree::List(anchors.collect()),
        events(degradations),
    ];
    items.extend(asked.map(|asked| Tree::List(asked.iter().map(ask).collect())));
    if let Some(svg) = svg {
        match svg_item(&laid.scene, svg, MAX_SVG_BYTES) {
            Ok(item) => items.push(item),
            Err(refusal) => return refusal,
        }
    }
    let answer = Tree::List(items);
    answer.to_json().unwrap_or_else(|_| refused("malformed", "non-finite"))
}
