//! A bound on the TOTAL raster work an SVG's filters ask for.
//!
//! A rasteriser allocates and blurs a layer the size of a filter's region for
//! every element that references it, so what an export costs is the SUM of
//! those regions. Each element's own region is already its own extent
//! (`glow_of`), and that bounds nothing in total: a corner-to-corner edge's
//! extent is the whole scene, and drop-shadowed comment bubbles stack, so a few
//! hundred elements ask for (elements) x (scene area) of blur.
//!
//! Past the budget the LARGEST regions lose their filter first, and their
//! filter definitions go with them, so a board under it, which is every
//! ordinary board, is returned as the very same tree and its bytes do not move.
//! What is dropped is decoration (a halo, a shadow), never ink.

use super::defs::collect_defs;
use super::paint::DROP_SHADOW_ID;
use super::vnode::{AttrValue, Child, SvgDef, VNode};
use whiteboard_det::math::{compare_numbers, js_max, js_min};
use whiteboard_scene::BoundingBox;

/// The budget, in glow-equivalent DEVICE pixels of filter region, summed over
/// every referencing element and clipped to the drawn box. Measured with resvg:
/// a glow region costs about 270ms per megapixel, and the worst boards it admits
/// spent about 1.75s there. A 150-node board glowing under `visual.neon` sums
/// about 6.2M at scale 1 and keeps all of it; at 200 nodes (8.5M) its longest
/// edges lose their halo first.
const FILTER_REGION_BUDGET_PX: f64 = 8_000_000.0;

/// A drop shadow costs about twice what a glow does per pixel (an offset, a
/// flood and a composite on top of the blur), so its pixels count twice.
const DROP_SHADOW_WEIGHT: f64 = 2.0;

/// The specification's default filter region: -10%, -10%, 120%, 120% of the element.
const DEFAULT_X: f64 = -0.1;
const DEFAULT_Y: f64 = -0.1;
const DEFAULT_W: f64 = 1.2;
const DEFAULT_H: f64 = 1.2;

struct Reference {
    order: usize,
    work: f64,
}

fn clipped_area(region: &BoundingBox, clip: &BoundingBox) -> f64 {
    let w = js_min(region.x + region.w, clip.x + clip.w) - js_max(region.x, clip.x);
    let h = js_min(region.y + region.h, clip.y + clip.h) - js_max(region.y, clip.y);
    if w > 0.0 && h > 0.0 { w * h } else { 0.0 }
}

/// A percentage written as a string (`-30%`) as a fraction, or `fallback`.
fn fraction(value: Option<&AttrValue>, fallback: f64) -> f64 {
    let Some(AttrValue::Str(text)) = value else { return fallback };
    let Some(number) = text.strip_suffix('%') else { return fallback };
    let trimmed = number.trim();
    let parsed = if trimmed.is_empty() { Some(0.0) } else { trimmed.parse::<f64>().ok() };
    match parsed.map(|n| n / 100.0) {
        Some(f) if f.is_finite() => f,
        _ => fallback,
    }
}

fn finite(value: Option<&AttrValue>) -> Option<f64> {
    match value {
        Some(AttrValue::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// The region `def` declares when `element` references it. A region this cannot
/// read (a definition it does not hold, an element with no box) is charged as
/// the whole drawn box, so what cannot be measured is never free.
fn region_of(element: &VNode, def: Option<&SvgDef>, clip: &BoundingBox) -> BoundingBox {
    let Some(def) = def else { return *clip };
    let attrs = &def.node.attrs;
    let own = |name| finite(element.attrs.get(name));
    if attrs.get("filterUnits") == Some(&AttrValue::Str("userSpaceOnUse".to_string())) {
        let held = |name| finite(attrs.get(name));
        return match (held("x"), held("y"), held("width"), held("height")) {
            (Some(x), Some(y), Some(w), Some(h)) => BoundingBox { x, y, w, h },
            _ => *clip,
        };
    }
    let (Some(x), Some(y), Some(width), Some(height)) =
        (own("x"), own("y"), own("width"), own("height"))
    else {
        return *clip;
    };
    BoundingBox {
        x: x + fraction(attrs.get("x"), DEFAULT_X) * width,
        y: y + fraction(attrs.get("y"), DEFAULT_Y) * height,
        w: fraction(attrs.get("width"), DEFAULT_W) * width,
        h: fraction(attrs.get("height"), DEFAULT_H) * height,
    }
}

/// The id a node's `filter="url(#id)"` references.
fn referenced_id(node: &VNode) -> Option<&str> {
    let AttrValue::Str(filter) = node.attrs.get("filter")? else { return None };
    let id = filter.strip_prefix("url(#")?.strip_suffix(')')?;
    (!id.is_empty() && !id.contains(')')).then_some(id)
}

/// Every element carrying a filter, in document order (the order `strip` walks).
fn filtered<'a>(children: &'a [Child], out: &mut Vec<&'a VNode>) {
    for child in children {
        match child {
            Child::List(inner) => filtered(inner, out),
            Child::Node(node) => {
                if referenced_id(node).is_some() {
                    out.push(node);
                }
                filtered(node.children.as_deref().unwrap_or(&[]), out);
            }
            Child::Text(_) | Child::Raw(_) => {}
        }
    }
}

/// `node` without its filter reference, or the definition of that filter.
fn unfiltered(node: &VNode, id: &str) -> VNode {
    let defs = node
        .defs
        .iter()
        .filter(|def| !(def.id == id && def.node.tag == "filter"))
        .cloned()
        .collect();
    VNode {
        tag: node.tag,
        attrs: node.attrs.without(&["filter"]),
        children: node.children.clone(),
        defs,
    }
}

/// Rebuilds the tree with the filters at `drop`'s document-order positions removed.
fn strip(children: &[Child], drop: &[usize], counter: &mut usize) -> Vec<Child> {
    children
        .iter()
        .map(|child| match child {
            Child::List(inner) => Child::List(strip(inner, drop, counter)),
            Child::Node(node) => {
                let mut kept = node.clone();
                if let Some(id) = referenced_id(node) {
                    let position = *counter;
                    *counter = counter.saturating_add(1);
                    if drop.contains(&position) {
                        kept = unfiltered(node, id);
                    }
                }
                kept.children = node.children.as_deref().map(|inner| strip(inner, drop, counter));
                Child::Node(kept)
            }
            other => other.clone(),
        })
        .collect()
}

/// A raster scale that is not a positive finite number draws at 1x.
fn sanitize_raster_scale(scale: Option<f64>) -> f64 {
    scale.filter(|s| s.is_finite() && *s > 0.0).unwrap_or(1.0)
}

/// The body with its filter work held to the budget at `raster_scale` device
/// pixels per user unit, and the definitions what is left references. `clip` is
/// the drawn box: nothing outside it is rasterised, so no region is charged
/// past it.
pub(super) fn bound_filter_work(
    body: Vec<Child>,
    clip: &BoundingBox,
    raster_scale: Option<f64>,
) -> (Vec<Child>, Vec<SvgDef>) {
    let defs = collect_defs(&body);
    let scale = sanitize_raster_scale(raster_scale);
    let device_area = scale * scale;
    let mut elements = Vec::new();
    filtered(&body, &mut elements);
    let references: Vec<Reference> = elements
        .iter()
        .enumerate()
        .filter_map(|(order, node)| {
            let id = referenced_id(node)?;
            let weight = if id == DROP_SHADOW_ID { DROP_SHADOW_WEIGHT } else { 1.0 };
            let def = defs.iter().find(|d| d.id == id);
            let work = weight * device_area * clipped_area(&region_of(node, def, clip), clip);
            Some(Reference { order, work })
        })
        .collect();
    let mut total: f64 = references.iter().fold(0.0, |sum, r| sum + r.work);
    if total <= FILTER_REGION_BUDGET_PX {
        return (body, defs);
    }
    // Largest first; among equals the later one, which paints over the earlier.
    let mut ranked: Vec<&Reference> = references.iter().collect();
    ranked.sort_by(|a, b| compare_numbers(b.work, a.work).then(b.order.cmp(&a.order)));
    let mut drop = Vec::new();
    for reference in ranked {
        if total <= FILTER_REGION_BUDGET_PX {
            break;
        }
        drop.push(reference.order);
        total -= reference.work;
    }
    let bounded = strip(&body, &drop, &mut 0);
    let defs = collect_defs(&bounded);
    (bounded, defs)
}

#[cfg(test)]
mod tests {
    use super::bound_filter_work;
    use crate::svg::paint::drop_shadow_defs;
    use crate::svg::serialize::serialize_child;
    use crate::svg::vnode::{Attrs, Child, SvgDef, VNode};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_scene::BoundingBox;

    fn clip() -> BoundingBox {
        BoundingBox { x: 0.0, y: 0.0, w: 10_000.0, h: 10_000.0 }
    }

    /// A glow-shaped filter whose region is `side` square at the origin.
    fn glow(id: &str, side: f64) -> SvgDef {
        let node = VNode::leaf(
            "filter",
            Attrs::new()
                .str("id", id)
                .str("filterUnits", "userSpaceOnUse")
                .num("x", 0.0)
                .num("y", 0.0)
                .num("width", side)
                .num("height", side),
        );
        SvgDef { id: id.into(), node }
    }

    fn user(id: &str, side: f64) -> Child {
        VNode::leaf("rect", Attrs::new().str("filter", &format!("url(#{id})")))
            .with_defs(vec![glow(id, side)])
            .into()
    }

    fn run(body: Vec<Child>, scale: Option<f64>) -> (String, Vec<String>) {
        let (bounded, defs) = bound_filter_work(body, &clip(), scale);
        let text = bounded.iter().map(|c| serialize_child(c).unwrap_or_default()).collect();
        (text, defs.into_iter().map(|d| d.id).collect())
    }

    #[test]
    fn a_board_within_the_budget_is_returned_as_it_was_with_its_definitions() {
        let (text, defs) = run(vec![user("a", 2000.0), user("b", 2000.0)], None);
        assert_eq!(text, "<rect filter=\"url(#a)\"/><rect filter=\"url(#b)\"/>");
        assert_eq!(defs, ["a", "b"]);
    }

    #[test]
    fn past_the_budget_the_largest_region_loses_its_filter_and_its_definition_first() {
        let (text, defs) =
            run(vec![user("small", 2000.0), user("big", 2500.0), user("mid", 2200.0)], None);
        // 4.0M + 6.25M + 4.84M = 15.09M; dropping the largest leaves 8.84M, so the next goes too.
        assert_eq!(text, "<rect filter=\"url(#small)\"/><rect/><rect/>");
        assert_eq!(defs, ["small"]);
    }

    #[test]
    fn only_as_many_filters_are_dropped_as_bring_the_total_to_the_budget() {
        let (text, defs) = run(vec![user("a", 2000.0), user("b", 2000.0), user("c", 2000.0)], None);
        // 12M, one dropped is 8M which is not past the budget; the later of equals goes first.
        assert_eq!(text, "<rect filter=\"url(#a)\"/><rect filter=\"url(#b)\"/><rect/>");
        assert_eq!(defs, ["a", "b"]);
    }

    #[test]
    fn a_region_past_the_drawn_box_is_charged_only_inside_it() {
        let small = BoundingBox { x: 0.0, y: 0.0, w: 100.0, h: 100.0 };
        let (bounded, defs) =
            bound_filter_work(vec![user("a", 9000.0), user("b", 9000.0)], &small, None);
        assert_eq!(bounded.len(), 2);
        assert_eq!(defs.len(), 2);
    }

    #[test]
    fn the_raster_scale_multiplies_device_area_and_an_unusable_one_is_one() {
        let two = || vec![user("a", 1200.0), user("b", 1200.0)];
        let (at_one, _) = run(two(), None);
        assert!(at_one.contains("url(#a)") && at_one.contains("url(#b)"));
        let (at_two, defs) = run(two(), Some(2.0));
        assert_eq!(at_two, "<rect filter=\"url(#a)\"/><rect/>");
        assert_eq!(defs, ["a"]);
        for unusable in [0.0, -2.0, f64::NAN, f64::INFINITY] {
            assert_eq!(run(two(), Some(unusable)).0, at_one, "{unusable}");
        }
    }

    fn shadowed(side: f64) -> Child {
        VNode::leaf(
            "rect",
            Attrs::new()
                .num("x", 0.0)
                .num("y", 0.0)
                .num("width", side)
                .num("height", side)
                .str("filter", "url(#wb-drop-shadow)"),
        )
        .with_defs(drop_shadow_defs())
        .into()
    }

    #[test]
    fn a_drop_shadow_counts_twice_and_its_region_is_a_share_of_the_element() {
        // The region is 160% of the box: 1600 square is 2.56M, twice is 5.12M.
        let (text, _) = run(vec![shadowed(1000.0)], None);
        assert!(text.contains("filter="));
        let (dropped, defs) = run(vec![shadowed(1500.0), shadowed(1500.0)], None);
        // 2 x 2 x 2400^2 = 23M, over the budget: the later element loses it first.
        assert!(dropped.matches("filter=").count() < 2, "{dropped}");
        assert!(defs.len() <= 1);
    }

    #[test]
    fn a_filter_reference_the_budget_cannot_read_is_charged_as_the_whole_drawn_box() {
        // No definition for it, and an element with no box: both cost the clip,
        // here 2000 square, so two fit the budget and a third does not.
        let small = BoundingBox { x: 0.0, y: 0.0, w: 2000.0, h: 2000.0 };
        let orphan: Child = VNode::leaf("rect", Attrs::new().str("filter", "url(#nowhere)")).into();
        let count = |n: usize| {
            let (bounded, _) = bound_filter_work(vec![orphan.clone(); n], &small, None);
            bounded
                .iter()
                .map(|c| serialize_child(c).unwrap_or_default())
                .collect::<String>()
                .matches("filter=")
                .count()
        };
        assert_eq!([count(1), count(2), count(3)], [1, 2, 2]);
    }

    #[test]
    fn a_reference_that_is_not_a_filter_url_is_not_a_filter() {
        let odd: Child = VNode::leaf("rect", Attrs::new().str("filter", "none")).into();
        let (text, defs) = run(vec![odd], None);
        assert_eq!(text, "<rect filter=\"none\"/>");
        assert!(defs.is_empty());
    }

    /// A filter definition with no region of its own: the specification's default
    /// of -10%, -10%, 120% and 120% of the element applies.
    fn plain(id: &str) -> SvgDef {
        SvgDef { id: id.into(), node: VNode::leaf("filter", Attrs::new().str("id", id)) }
    }

    fn boxed(id: &str, x: f64, y: f64, side: f64, def: SvgDef) -> Child {
        VNode::leaf(
            "rect",
            Attrs::new()
                .num("x", x)
                .num("y", y)
                .num("width", side)
                .num("height", side)
                .str("filter", &format!("url(#{id})")),
        )
        .with_defs(vec![def])
        .into()
    }

    fn kept(body: Vec<Child>, clip: &BoundingBox) -> (String, Vec<String>) {
        let (bounded, defs) = bound_filter_work(body, clip, None);
        let text = bounded.iter().map(|c| serialize_child(c).unwrap_or_default()).collect();
        (text, defs.into_iter().map(|d| d.id).collect())
    }

    #[test]
    fn a_region_with_no_declared_percentages_is_the_default_share_of_the_element_box() {
        // Region 800..3200 on each axis, clipped to 900..3400: 2300 square, 5.29M.
        // With the 1703 square beside it that is 8.19M, over the budget, and the
        // larger loses its filter; a region read from 1200 would be 7.96M and keep both.
        let clip = BoundingBox { x: 900.0, y: 900.0, w: 2500.0, h: 2500.0 };
        let filler = {
            let mut def = glow("b", 1703.0);
            if let Some(n) = def.node.attrs.get_num("x") {
                def.node.attrs = def.node.attrs.num("x", n + 900.0).num("y", 900.0);
            }
            def
        };
        let body = vec![
            boxed("a", 1000.0, 1000.0, 2000.0, plain("a")),
            boxed("b", 0.0, 0.0, 10.0, filler),
        ];
        let (text, defs) = kept(body, &clip);
        assert!(!text.contains("url(#a)") && text.contains("url(#b)"), "{text}");
        assert_eq!(defs, ["b"]);
    }

    #[test]
    fn a_region_off_the_drawn_box_on_one_axis_costs_nothing() {
        // C overlaps the box in x and not in y; the four others sum to 8.01M.
        let clip = BoundingBox { x: 0.0, y: 0.0, w: 3000.0, h: 3000.0 };
        let far = SvgDef {
            id: "far".into(),
            node: VNode::leaf(
                "filter",
                Attrs::new()
                    .str("id", "far")
                    .str("filterUnits", "userSpaceOnUse")
                    .num("x", 0.0)
                    .num("y", 5000.0)
                    .num("width", 3000.0)
                    .num("height", 3000.0),
            ),
        };
        let body = vec![
            boxed("far", 0.0, 0.0, 1.0, far),
            user("d", 2000.0),
            user("e", 2000.0),
            user("f", 100.0),
        ];
        let (text, _) = kept(body, &clip);
        assert_eq!(text.matches("filter=").count(), 3, "{text}");
        assert!(text.contains("url(#far)"));
    }

    #[test]
    fn a_reference_that_is_not_one_url_is_left_alone() {
        let clip = BoundingBox { x: 0.0, y: 0.0, w: 2000.0, h: 2000.0 };
        let odd =
            |text: &str| -> Child { VNode::leaf("rect", Attrs::new().str("filter", text)).into() };
        for text in ["url(#a)b)", "url(#)", "url(#a", "xurl(#a)", "url(a)"] {
            let body = vec![odd(text), odd(text), odd(text)];
            let (out, _) = kept(body, &clip);
            assert_eq!(out.matches(&format!("filter=\"{text}\"")).count(), 3, "{text}");
        }
    }

    #[test]
    fn dropping_a_filter_removes_only_its_own_definition() {
        let clip = BoundingBox { x: 0.0, y: 0.0, w: 3000.0, h: 3000.0 };
        let node: Child = VNode::leaf("rect", Attrs::new().str("filter", "url(#big)"))
            .with_defs(vec![glow("big", 3000.0), glow("other", 10.0)])
            .into();
        let (text, defs) = kept(vec![node, user("x", 2500.0)], &clip);
        assert!(text.starts_with("<rect/>"), "{text}");
        assert_eq!(defs, ["other", "x"]);
    }

    #[test]
    fn a_percentage_that_is_not_finite_or_a_box_that_is_not_a_number_charges_the_defaults() {
        let clip = BoundingBox { x: 0.0, y: 0.0, w: 3000.0, h: 3000.0 };
        // `inf%` is no share, so the default 120% applies: 4.84M clipped. Read as
        // infinite it would cost 6.6M, and with the 3.0M beside it the board would
        // be dropped to.
        let infinite = SvgDef {
            id: "a".into(),
            node: VNode::leaf("filter", Attrs::new().str("id", "a").str("width", "inf%")),
        };
        let board = vec![boxed("a", 0.0, 0.0, 2000.0, infinite), user("b", 1733.0)];
        let (text, _) = kept(board, &clip);
        assert!(text.contains("url(#a)"), "{text}");
        // An element whose box is not a number is charged the whole drawn box.
        let small = BoundingBox { x: 0.0, y: 0.0, w: 2000.0, h: 2000.0 };
        let nan = |id: &str| boxed(id, f64::NAN, 0.0, 1000.0, plain(id));
        // Three of them cost 12M against the budget, so the last loses its filter and
        // its definition (the text cannot say: a box that is not a number does not
        // serialize).
        let (_, defs) = kept(vec![nan("n1"), nan("n2"), nan("n3")], &small);
        assert_eq!(defs, ["n1", "n2"]);
    }
}
