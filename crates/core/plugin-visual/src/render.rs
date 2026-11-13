//! What the bundled visual plugin contributes to RENDERING, as data: its
//! silhouettes under their namespaced ids, the box each leaves its content,
//! and its icon geometry. The renderer holds no table of its own, so what a
//! silhouette is and which icons exist is this plugin's business.
//!
//! Its one decoration is the badge a stencil-wearing box carries
//! ([`StencilBadge`]), a [`NodeDecoration`] the renderer asks with every other
//! contribution. The facet readers that answer which stencil and symbol a node
//! wears, and the themes, are not here yet: the badge asks [`NodeMarks`], which
//! the host answers until they are.

use whiteboard_det::math::js_min;
use whiteboard_model::Value;
use whiteboard_model::json;
use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{
    Appearance, BoundingBox, DecorationContext, IconSceneNode, NodeDecoration, NodeOutline,
    SceneNode, ScenePoint,
};

use crate::visual::VisualSymbolFacet;

/// The namespace the plugin's silhouettes are composed under.
pub const SHAPE_NAMESPACE: &str = "visual";

fn polygon(points: &[(f64, f64)]) -> NodeOutline {
    NodeOutline::Polygon { points: points.iter().map(|&(x, y)| ScenePoint { x, y }).collect() }
}

/// The octagon's corner cut, off the SMALLER dimension so the shape survives
/// any proportion: a quarter of it is pronounced enough to read as a cut corner
/// and never large enough to make two cuts meet.
fn octagon_cut(bbox: &BoundingBox) -> f64 {
    js_min(bbox.w, bbox.h) / 4.0
}

/// The silhouette `visual.<name>` draws in `bbox`, or none for a name this
/// plugin does not carry (a document naming one is ordinary).
///
/// Outlines derive from the box and a kind, never stored coordinates, so a
/// translated scene moves the box and the outline follows. Polygons run
/// clockwise from the first corner named, a fixed order for deterministic
/// serialisation.
#[must_use]
pub fn shape_outline(id: &str, bbox: &BoundingBox) -> Option<NodeOutline> {
    let name = id.strip_prefix(SHAPE_NAMESPACE)?.strip_prefix('.')?;
    let BoundingBox { x, y, w, h } = *bbox;
    let cy = y + h / 2.0;
    Some(match name {
        "ellipse" => NodeOutline::Ellipse { cx: x + w / 2.0, cy, rx: w / 2.0, ry: h / 2.0 },
        // Edge-midpoint polygon, clockwise from the top vertex.
        "diamond" => polygon(&[(x + w / 2.0, y), (x + w, cy), (x + w / 2.0, y + h), (x, cy)]),
        // Pointy-left-right six-gon: the corner inset is a quarter of the
        // width, capped at half the height so degenerate proportions stay a
        // valid convex polygon.
        "hexagon" => {
            let inset = (w / 4.0).min(h / 2.0);
            polygon(&[
                (x + inset, y),
                (x + w - inset, y),
                (x + w, cy),
                (x + w - inset, y + h),
                (x + inset, y + h),
                (x, cy),
            ])
        }
        // Right-leaning skew with the same capped proportion as the hexagon.
        "parallelogram" => {
            let skew = (w / 4.0).min(h / 2.0);
            polygon(&[(x + skew, y), (x + w, y), (x + w - skew, y + h), (x, y + h)])
        }
        // A rectangle with its four corners taken off, the polygon nearest the
        // rounded rectangle a running component is drawn as.
        "octagon" => {
            let cut = octagon_cut(bbox);
            polygon(&[
                (x + cut, y),
                (x + w - cut, y),
                (x + w, y + cut),
                (x + w, y + h - cut),
                (x + w - cut, y + h),
                (x + cut, y + h),
                (x, y + h - cut),
                (x, y + cut),
            ])
        }
        "cylinder" => NodeOutline::Cylinder { x, y, w, h, ry: (w * 0.1).min(h / 4.0) },
        _ => return None,
    })
}

/// The box `visual.<name>` leaves its content in `bbox`: the axis-aligned box
/// inscribed in the silhouette, so text laid out inside it never crosses the
/// outline. None for a name this plugin does not carry, which a caller reads as
/// the box itself.
///
/// The ellipse insets 0.15 of each side rather than the exact (1 - 1/√2)/2: the
/// exact value puts the corners ON the rim, where float error flips containment.
/// The hexagon and parallelogram give up only their slanted horizontal margins,
/// the octagon half its corner cut on every side (each corner then lies on its
/// diagonal), and the cylinder its lid (the front rim dips to 2·ry) and bottom
/// bulge.
#[must_use]
pub fn shape_content_box(id: &str, bbox: &BoundingBox) -> Option<BoundingBox> {
    let name = id.strip_prefix(SHAPE_NAMESPACE)?.strip_prefix('.')?;
    let BoundingBox { x, y, w, h } = *bbox;
    let inset =
        |dx: f64, dy: f64| BoundingBox { x: x + dx, y: y + dy, w: w - 2.0 * dx, h: h - 2.0 * dy };
    Some(match name {
        "ellipse" => inset(w * 0.15, h * 0.15),
        "diamond" => BoundingBox { x: x + w / 4.0, y: y + h / 4.0, w: w / 2.0, h: h / 2.0 },
        "hexagon" | "parallelogram" => {
            let dx = js_min(w / 4.0, h / 2.0);
            BoundingBox { x: x + dx, y, w: w - 2.0 * dx, h }
        }
        "octagon" => {
            let half = octagon_cut(bbox) / 2.0;
            inset(half, half)
        }
        "cylinder" => {
            let ry = js_min(w * 0.1, h / 4.0);
            BoundingBox { x, y: y + 2.0 * ry, w, h: h - 3.0 * ry }
        }
        _ => return None,
    })
}

/// One primitive of an icon, in the 24x24 lucide viewBox.
#[derive(Debug, Clone, PartialEq)]
pub enum IconElement {
    Path { d: String },
    Rect { x: f64, y: f64, width: f64, height: f64, rx: Option<f64> },
    Circle { cx: f64, cy: f64, r: f64 },
    Ellipse { cx: f64, cy: f64, rx: f64, ry: f64 },
}

/// The vendored icon geometry, one file with the TypeScript package.
const LUCIDE: &str =
    include_str!("../../../../packages/plugin-visual/src/assets/icons-lucide.json");

/// The coordinate space the vendored geometry is drawn in.
pub const ICON_VIEWBOX: &str = "0 0 24 24";

fn field<'a>(entries: &'a [(String, Value)], name: &str) -> Option<&'a Value> {
    entries.iter().find(|(key, _)| key == name).map(|(_, value)| value)
}

fn number(entries: &[(String, Value)], name: &str) -> Option<f64> {
    match field(entries, name)? {
        Value::Number(n) => Some(*n),
        _ => None,
    }
}

/// The numbers `names` hold, all of them or none.
fn numbers<const N: usize>(entries: &[(String, Value)], names: [&str; N]) -> Option<[f64; N]> {
    let found: Option<Vec<f64>> = names.iter().map(|name| number(entries, name)).collect();
    found?.try_into().ok()
}

fn element(value: &Value) -> Option<IconElement> {
    let Value::Map(entries) = value else { return None };
    let Value::String(tag) = field(entries, "tag")? else { return None };
    Some(match tag.as_str() {
        "path" => match field(entries, "d")? {
            Value::String(d) => IconElement::Path { d: d.clone() },
            _ => return None,
        },
        "rect" => {
            let [x, y, width, height] = numbers(entries, ["x", "y", "width", "height"])?;
            IconElement::Rect { x, y, width, height, rx: number(entries, "rx") }
        }
        "circle" => {
            let [cx, cy, r] = numbers(entries, ["cx", "cy", "r"])?;
            IconElement::Circle { cx, cy, r }
        }
        "ellipse" => {
            let [cx, cy, rx, ry] = numbers(entries, ["cx", "cy", "rx", "ry"])?;
            IconElement::Ellipse { cx, cy, rx, ry }
        }
        _ => return None,
    })
}

/// The vendored geometry for icon `name`, or none when the set does not carry
/// it. The one lookup a document-supplied name may go through: the table is
/// read from the file's own entries, so a name such as `toString` is an unknown
/// name like any other.
#[must_use]
pub fn icon_geometry(name: &str) -> Option<Vec<IconElement>> {
    icon_geometry_in(LUCIDE, name)
}

/// `icon_geometry` over a table's text: an entry that is not an object holding
/// a `geometry` list of primitives this renderer draws is no icon.
fn icon_geometry_in(table: &str, name: &str) -> Option<Vec<IconElement>> {
    let Ok(Value::Map(icons)) = json::parse(table) else { return None };
    let Value::Map(icon) = field(&icons, name)? else { return None };
    let Value::Seq(elements) = field(icon, "geometry")? else { return None };
    elements.iter().map(element).collect()
}

/// Edge of a stencil's badge, and its distance from the node's top edge.
const BADGE_SIZE_PX: f64 = 16.0;
const BADGE_INSET_PX: f64 = 6.0;
/// Below this node height the badge would sit on the label, so it is left off.
const BADGE_MIN_NODE_HEIGHT_PX: f64 = 48.0;

/// The mark a box wearing a stencil carries (`stencilBadge`), at the top centre,
/// where every silhouette here is at its widest and clear: a corner is outside a
/// diamond, an ellipse and a parallelogram. Only a stencil-wearing box draws it,
/// since a stencil is a kind, and two kinds that differ only by silhouette are
/// hard to tell apart at a glance; a symbol set by hand reaches the surfaces too
/// small to read a node on instead. An icon is stroked, so the badge takes the
/// label's ink, and `currentColor` when the label has none.
fn stencil_badge(
    node: &BoundingBox,
    stencil: Option<&str>,
    symbol: Option<&VisualSymbolFacet>,
    label_fill: Option<&str>,
) -> Option<IconSceneNode> {
    stencil?;
    let Some(VisualSymbolFacet::VisualSymbolIcon(icon)) = symbol else { return None };
    if node.h < BADGE_MIN_NODE_HEIGHT_PX {
        return None;
    }
    Some(IconSceneNode {
        bbox: BoundingBox {
            x: node.x + (node.w - BADGE_SIZE_PX) / 2.0,
            y: node.y + BADGE_INSET_PX,
            w: BADGE_SIZE_PX,
            h: BADGE_SIZE_PX,
        },
        icon: icon.name.clone(),
        appearance: Some(Appearance {
            stroke: Some(label_fill.unwrap_or("currentColor").to_owned()),
            ..Appearance::default()
        }),
    })
}

/// The facet values the badge reads off a node.
pub trait NodeMarks {
    /// The stencil the node wears (`visual.stencil/v0`), by id.
    fn stencil(&self, node: &SpatialNode) -> Option<String>;

    /// The symbol the node wears (`visual.symbol/v0`).
    fn symbol(&self, node: &SpatialNode) -> Option<VisualSymbolFacet>;
}

/// The plugin's decoration (`stencilBadge`): the badge over a node, placed by
/// the node's own box rather than the content bounds it is told, as the
/// TypeScript places it.
pub struct StencilBadge<'a> {
    pub marks: &'a dyn NodeMarks,
}

impl NodeDecoration for StencilBadge<'_> {
    fn decorate(&self, node: &SpatialNode, context: &DecorationContext) -> Vec<SceneNode> {
        let bbox = BoundingBox { x: node.x, y: node.y, w: node.width, h: node.height };
        let stencil = self.marks.stencil(node);
        let symbol = self.marks.symbol(node);
        stencil_badge(&bbox, stencil.as_deref(), symbol.as_ref(), context.label.fill.as_deref())
            .map(SceneNode::Icon)
            .into_iter()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ICON_VIEWBOX, IconElement, NodeMarks, StencilBadge, icon_geometry, icon_geometry_in,
        shape_content_box, shape_outline, stencil_badge,
    };
    use crate::visual::{VisualSymbolEmoji, VisualSymbolFacet, VisualSymbolIcon};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_model::spatial::SpatialNode;
    use whiteboard_scene::{
        Appearance, BoundingBox, DecorationContext, NodeDecoration, NodeOutline, SceneNode,
        ScenePoint,
    };

    const WIDE: BoundingBox = BoundingBox { x: 10.0, y: 20.0, w: 200.0, h: 80.0 };
    const SMALL: BoundingBox = BoundingBox { x: 0.0, y: 0.0, w: 40.0, h: 12.0 };

    fn polygon(points: &[(f64, f64)]) -> NodeOutline {
        NodeOutline::Polygon { points: points.iter().map(|&(x, y)| ScenePoint { x, y }).collect() }
    }

    #[test]
    fn each_silhouette_leaves_its_content_the_box_inscribed_in_it() {
        let boxed = |x, y, w, h| Some(BoundingBox { x, y, w, h });
        let cases = [
            ("ellipse", boxed(40.0, 32.0, 140.0, 56.0)),
            ("diamond", boxed(60.0, 40.0, 100.0, 40.0)),
            ("hexagon", boxed(50.0, 20.0, 120.0, 80.0)),
            ("parallelogram", boxed(50.0, 20.0, 120.0, 80.0)),
            ("octagon", boxed(20.0, 30.0, 180.0, 60.0)),
            ("cylinder", boxed(10.0, 60.0, 200.0, 20.0)),
        ];
        for (name, want) in cases {
            assert_eq!(shape_content_box(&format!("visual.{name}"), &WIDE), want, "{name}");
        }
    }

    #[test]
    fn a_name_outside_the_namespace_has_no_content_box() {
        for id in ["visual.star", "visualellipse", "other.ellipse", "ellipse"] {
            assert_eq!(shape_content_box(id, &WIDE), None, "{id}");
        }
    }

    #[test]
    fn an_ellipse_is_the_inscribed_one() {
        assert_eq!(
            shape_outline("visual.ellipse", &WIDE),
            Some(NodeOutline::Ellipse { cx: 110.0, cy: 60.0, rx: 100.0, ry: 40.0 })
        );
    }

    #[test]
    fn a_diamond_runs_clockwise_from_the_top_vertex() {
        assert_eq!(
            shape_outline("visual.diamond", &WIDE),
            Some(polygon(&[(110.0, 20.0), (210.0, 60.0), (110.0, 100.0), (10.0, 60.0)]))
        );
    }

    #[test]
    fn a_hexagon_insets_a_quarter_of_the_width_capped_at_half_the_height() {
        assert_eq!(
            shape_outline("visual.hexagon", &WIDE),
            Some(polygon(&[
                (50.0, 20.0),
                (170.0, 20.0),
                (210.0, 60.0),
                (170.0, 100.0),
                (50.0, 100.0),
                (10.0, 60.0)
            ]))
        );
        // 40x12: a quarter of the width is 10, half the height is 6.
        assert_eq!(
            shape_outline("visual.hexagon", &SMALL),
            Some(polygon(&[
                (6.0, 0.0),
                (34.0, 0.0),
                (40.0, 6.0),
                (34.0, 12.0),
                (6.0, 12.0),
                (0.0, 6.0)
            ]))
        );
    }

    #[test]
    fn a_parallelogram_skews_right_by_the_same_capped_proportion() {
        assert_eq!(
            shape_outline("visual.parallelogram", &WIDE),
            Some(polygon(&[(50.0, 20.0), (210.0, 20.0), (170.0, 100.0), (10.0, 100.0)]))
        );
        assert_eq!(
            shape_outline("visual.parallelogram", &SMALL),
            Some(polygon(&[(6.0, 0.0), (40.0, 0.0), (34.0, 12.0), (0.0, 12.0)]))
        );
    }

    #[test]
    fn a_tall_box_insets_a_quarter_of_its_width_before_the_height_cap_applies() {
        let tall = BoundingBox { x: 0.0, y: 0.0, w: 40.0, h: 100.0 };
        assert_eq!(
            shape_outline("visual.hexagon", &tall),
            Some(polygon(&[
                (10.0, 0.0),
                (30.0, 0.0),
                (40.0, 50.0),
                (30.0, 100.0),
                (10.0, 100.0),
                (0.0, 50.0)
            ]))
        );
        assert_eq!(
            shape_outline("visual.parallelogram", &tall),
            Some(polygon(&[(10.0, 0.0), (40.0, 0.0), (30.0, 100.0), (0.0, 100.0)]))
        );
    }

    #[test]
    fn an_octagon_cuts_a_quarter_of_the_smaller_side_off_every_corner() {
        // 200x80: the cut is 20.
        assert_eq!(
            shape_outline("visual.octagon", &WIDE),
            Some(polygon(&[
                (30.0, 20.0),
                (190.0, 20.0),
                (210.0, 40.0),
                (210.0, 80.0),
                (190.0, 100.0),
                (30.0, 100.0),
                (10.0, 80.0),
                (10.0, 40.0)
            ]))
        );
        // 40x12: the cut is 3, off the height, not the width.
        assert_eq!(
            shape_outline("visual.octagon", &SMALL),
            Some(polygon(&[
                (3.0, 0.0),
                (37.0, 0.0),
                (40.0, 3.0),
                (40.0, 9.0),
                (37.0, 12.0),
                (3.0, 12.0),
                (0.0, 9.0),
                (0.0, 3.0)
            ]))
        );
    }

    #[test]
    fn a_cylinder_has_a_lid_of_a_tenth_of_the_width_capped_at_a_quarter_of_the_height() {
        assert_eq!(
            shape_outline("visual.cylinder", &WIDE),
            Some(NodeOutline::Cylinder { x: 10.0, y: 20.0, w: 200.0, h: 80.0, ry: 20.0 })
        );
        assert_eq!(
            shape_outline("visual.cylinder", &SMALL),
            Some(NodeOutline::Cylinder { x: 0.0, y: 0.0, w: 40.0, h: 12.0, ry: 3.0 })
        );
        let wide_lid = BoundingBox { x: 0.0, y: 0.0, w: 100.0, h: 400.0 };
        assert_eq!(
            shape_outline("visual.cylinder", &wide_lid),
            Some(NodeOutline::Cylinder { x: 0.0, y: 0.0, w: 100.0, h: 400.0, ry: 10.0 })
        );
    }

    #[test]
    fn an_id_the_plugin_does_not_carry_has_no_outline() {
        for id in [
            "",
            "visual",
            "visual.",
            "visual.blob",
            "ellipse",
            "other.ellipse",
            "visualellipse",
            "visual:ellipse",
            "Visual.ellipse",
        ] {
            assert_eq!(shape_outline(id, &WIDE), None, "{id:?}");
        }
    }

    #[test]
    fn an_icon_is_read_from_the_vendored_file_primitive_by_primitive() {
        assert_eq!(ICON_VIEWBOX, "0 0 24 24");
        assert_eq!(
            icon_geometry("database"),
            Some(vec![
                IconElement::Ellipse { cx: 12.0, cy: 5.0, rx: 9.0, ry: 3.0 },
                IconElement::Path { d: "M3 5V19A9 3 0 0 0 21 19V5".into() },
                IconElement::Path { d: "M3 12A9 3 0 0 0 21 12".into() },
            ])
        );
        assert_eq!(
            icon_geometry("image"),
            Some(vec![
                IconElement::Rect { x: 3.0, y: 3.0, width: 18.0, height: 18.0, rx: Some(2.0) },
                IconElement::Circle { cx: 9.0, cy: 9.0, r: 2.0 },
                IconElement::Path { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21".into() },
            ])
        );
    }

    #[test]
    fn a_name_the_set_does_not_carry_draws_nothing() {
        for name in ["", "nope", "toString", "constructor", "__proto__", "Database", "geometry"] {
            assert_eq!(icon_geometry(name), None, "{name:?}");
        }
    }

    #[test]
    fn an_entry_that_is_not_a_list_of_primitives_this_renderer_draws_is_no_icon() {
        let bad = [
            "not json",
            "[]",
            r#"{"i":1}"#,
            r#"{"i":{}}"#,
            r#"{"i":{"geometry":1}}"#,
            r#"{"i":{"geometry":[1]}}"#,
            r#"{"i":{"geometry":[{}]}}"#,
            r#"{"i":{"geometry":[{"tag":1}]}}"#,
            r#"{"i":{"geometry":[{"tag":"polygon"}]}}"#,
            r#"{"i":{"geometry":[{"tag":"path"}]}}"#,
            r#"{"i":{"geometry":[{"tag":"path","d":1}]}}"#,
            r#"{"i":{"geometry":[{"tag":"rect","x":1,"y":1,"width":1}]}}"#,
            r#"{"i":{"geometry":[{"tag":"rect","x":"1","y":1,"width":1,"height":1}]}}"#,
            r#"{"i":{"geometry":[{"tag":"circle","cx":1,"cy":1}]}}"#,
            r#"{"i":{"geometry":[{"tag":"ellipse","cx":1,"cy":1,"rx":1}]}}"#,
            r#"{"i":{"geometry":[{"tag":"path","d":"M0 0"},{"tag":"path"}]}}"#,
        ];
        for table in bad {
            assert_eq!(icon_geometry_in(table, "i"), None, "{table}");
        }
    }

    #[test]
    fn a_table_of_every_primitive_is_read_and_an_empty_geometry_draws_nothing() {
        let table = r#"{"i":{"geometry":[{"tag":"rect","x":1,"y":2,"width":3,"height":4},
            {"tag":"circle","cx":5,"cy":6,"r":7},{"tag":"ellipse","cx":8,"cy":9,"rx":1,"ry":2},
            {"tag":"path","d":"M0 0"}]},"empty":{"geometry":[]}}"#;
        assert_eq!(
            icon_geometry_in(table, "i"),
            Some(vec![
                IconElement::Rect { x: 1.0, y: 2.0, width: 3.0, height: 4.0, rx: None },
                IconElement::Circle { cx: 5.0, cy: 6.0, r: 7.0 },
                IconElement::Ellipse { cx: 8.0, cy: 9.0, rx: 1.0, ry: 2.0 },
                IconElement::Path { d: "M0 0".into() },
            ])
        );
        assert_eq!(icon_geometry_in(table, "empty"), Some(Vec::new()));
        assert_eq!(icon_geometry_in(table, "missing"), None);
    }

    #[test]
    fn a_badge_is_inked_with_the_label_or_the_current_colour() {
        let star =
            VisualSymbolFacet::VisualSymbolIcon(VisualSymbolIcon { name: "star".to_owned() });
        let stroke = |fill| {
            stencil_badge(&WIDE, Some("visual.datastore"), Some(&star), fill)
                .and_then(|badge| badge.appearance)
                .and_then(|appearance| appearance.stroke)
        };
        assert_eq!(stroke(Some("#123456")).as_deref(), Some("#123456"));
        assert_eq!(stroke(None).as_deref(), Some("currentColor"));
    }

    #[test]
    fn only_a_stencil_wearing_an_icon_in_a_tall_enough_box_draws_a_badge() {
        let star =
            VisualSymbolFacet::VisualSymbolIcon(VisualSymbolIcon { name: "star".to_owned() });
        let emoji =
            VisualSymbolFacet::VisualSymbolEmoji(VisualSymbolEmoji { char: "x".to_owned() });
        let stencil = Some("visual.datastore");
        let badge = stencil_badge(&WIDE, stencil, Some(&star), None);
        assert_eq!(
            badge.map(|b| (b.icon, b.bbox)),
            Some(("star".to_owned(), BoundingBox { x: 102.0, y: 26.0, w: 16.0, h: 16.0 }))
        );
        assert_eq!(stencil_badge(&WIDE, None, Some(&star), None), None);
        assert_eq!(stencil_badge(&WIDE, stencil, Some(&emoji), None), None);
        assert_eq!(stencil_badge(&WIDE, stencil, None, None), None);
        assert_eq!(stencil_badge(&SMALL, stencil, Some(&star), None), None);
    }

    /// Every node wears the `datastore` stencil and the `star` icon.
    struct Starred;

    impl NodeMarks for Starred {
        fn stencil(&self, _: &SpatialNode) -> Option<String> {
            Some("visual.datastore".to_owned())
        }

        fn symbol(&self, _: &SpatialNode) -> Option<VisualSymbolFacet> {
            Some(VisualSymbolFacet::VisualSymbolIcon(VisualSymbolIcon { name: "star".to_owned() }))
        }
    }

    #[test]
    fn the_decoration_places_its_badge_by_the_node_and_inks_it_with_the_label() {
        let node = SpatialNode {
            x: WIDE.x,
            y: WIDE.y,
            width: WIDE.w,
            height: WIDE.h,
            ..SpatialNode::default()
        };
        let context = DecorationContext {
            bounds: SMALL,
            label: Appearance { fill: Some("#123456".to_owned()), ..Appearance::default() },
        };
        let drawn = StencilBadge { marks: &Starred }.decorate(&node, &context);
        let expected = stencil_badge(
            &WIDE,
            Some("visual.datastore"),
            Some(&Starred.symbol(&node).unwrap()),
            Some("#123456"),
        );
        assert_eq!(drawn, expected.map(SceneNode::Icon).into_iter().collect::<Vec<_>>());
        assert_eq!(drawn.len(), 1, "a stencil wearing an icon in a tall box is badged");
    }
}
