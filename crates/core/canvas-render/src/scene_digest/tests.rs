//! The behaviours the TypeScript's six digest suites pin, as examples. The
//! recorded oracle holds the port to the TypeScript's bytes; these say what each
//! rule is for, so a failure names it.

use super::{DigestError, scene_digest};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::spatial::EdgeSide;
use whiteboard_scene::{
    BoundingBox, EdgeEnd, GlyphSceneNode, ProposalChrome, ResolvedEdgeNode, Scene, SceneNode,
    ShapeSceneNode,
};

const fn b(x: f64, y: f64, w: f64, h: f64) -> BoundingBox {
    BoundingBox { x, y, w, h }
}

fn glyphs(boxes: &[BoundingBox]) -> Scene {
    Scene {
        nodes: boxes
            .iter()
            .map(|bbox| SceneNode::Glyph(GlyphSceneNode { bbox: *bbox, glyph: "g".into() }))
            .collect(),
        legend: None,
    }
}

fn shape(id: Option<&str>, bbox: BoundingBox) -> ShapeSceneNode {
    ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: id.map(String::from),
        bbox,
        comment_chrome: false,
        proposal_chrome: None,
        radius: None,
        shape: None,
        appearance: None,
        task_box: None,
        ink: None,
    }
}

fn shapes(items: Vec<ShapeSceneNode>) -> Scene {
    Scene {
        nodes: items.into_iter().map(|s| SceneNode::Shape(Box::new(s))).collect(),
        legend: None,
    }
}

fn named(boxes: &[(&str, BoundingBox)]) -> Scene {
    shapes(boxes.iter().map(|(id, bbox)| shape(Some(id), *bbox)).collect())
}

fn json(scene: &Scene) -> String {
    scene_digest(scene).map(|d| d.to_json()).unwrap_or_default()
}

fn edge() -> SceneNode {
    SceneNode::Edge(Box::new(ResolvedEdgeNode {
        id: "e".into(),
        jumps: None,
        path: vec![],
        from_side: EdgeSide::Right,
        to_side: EdgeSide::Left,
        from_end: EdgeEnd::None,
        to_end: EdgeEnd::Arrow,
        rounded: false,
        ink: None,
        comment_chrome: false,
        appearance: None,
    }))
}

#[test]
fn an_empty_scene_has_no_regions_and_no_caveat() {
    assert_eq!(
        json(&glyphs(&[])),
        r#"{"nodes":[],"overlaps":[],"containment":[],"clusters":[],"freeRegions":[],"partial":false}"#
    );
}

#[test]
fn a_digest_is_written_key_for_key_as_json_stringify_writes_it() {
    let mut cut = shape(Some("a\"\u{1}"), b(0.0, 0.0, 10.0, 10.0));
    cut.truncated = true;
    cut.overflows = true;
    let text = json(&shapes(vec![cut]));
    assert_eq!(
        text,
        concat!(
            r#"{"nodes":[{"id":"a\"\u0001","bbox":{"x":0,"y":0,"w":10,"h":10},"z":0,"#,
            r#""truncated":true,"overflows":true}],"overlaps":[],"containment":[],"#,
            r#""clusters":[["a\"\u0001"]],"freeRegions":[],"partial":false}"#
        )
    );
}

#[test]
fn every_control_character_and_both_quotes_are_escaped() {
    let text = json(&named(&[("\u{8}\u{c}\n\r\t\\\u{1f}", b(0.0, 0.0, 1.0, 1.0))]));
    assert!(text.contains(r#""id":"\b\f\n\r\t\\\u001f""#), "{text}");
}

#[test]
fn a_number_that_is_not_finite_is_null_and_a_negative_zero_is_zero() {
    let text = json(&glyphs(&[b(-0.0, 0.0, f64::INFINITY, 10.0)]));
    assert!(text.contains(r#""bbox":{"x":0,"y":0,"w":null,"h":10}"#), "{text}");
}

#[test]
fn entries_are_numbered_in_scene_order_and_named_by_position_without_ids() {
    let digest = scene_digest(&glyphs(&[b(0.0, 0.0, 5.0, 5.0), b(50.0, 0.0, 5.0, 5.0)]));
    let ids: Vec<(String, usize)> =
        digest.map(|d| d.nodes.into_iter().map(|n| (n.id, n.z)).collect()).unwrap_or_default();
    assert_eq!(ids, [("n0".to_string(), 0), ("n1".to_string(), 1)]);
}

#[test]
fn identified_shapes_hide_the_unidentified_and_content_boxes() {
    let mut nodes =
        vec![shape(Some("named"), b(0.0, 0.0, 10.0, 10.0)), shape(None, b(50.0, 50.0, 1.0, 1.0))];
    nodes.push(shape(Some("late"), b(90.0, 0.0, 10.0, 10.0)));
    let mut scene = shapes(nodes);
    scene.nodes.insert(
        1,
        SceneNode::Glyph(GlyphSceneNode { bbox: b(1.0, 1.0, 2.0, 2.0), glyph: "g".into() }),
    );
    let ids: Vec<String> = scene_digest(&scene)
        .map(|d| d.nodes.into_iter().map(|n| n.id).collect())
        .unwrap_or_default();
    assert_eq!(ids, ["named", "late"]);
}

#[test]
fn comment_and_proposal_chrome_are_not_nodes_but_count_as_unidentified() {
    let mut comment = shape(Some("c"), b(0.0, 0.0, 9.0, 9.0));
    comment.comment_chrome = true;
    let mut proposal = shape(Some("p"), b(20.0, 0.0, 9.0, 9.0));
    proposal.proposal_chrome = Some(ProposalChrome { proposal_id: "q".into() });
    let beside =
        shapes(vec![shape(Some("n"), b(40.0, 0.0, 9.0, 9.0)), comment.clone(), proposal.clone()]);
    let ids = |scene: &Scene| -> Vec<String> {
        scene_digest(scene).map(|d| d.nodes.into_iter().map(|n| n.id).collect()).unwrap_or_default()
    };
    assert_eq!(ids(&beside), ["n"]);
    assert_eq!(ids(&shapes(vec![comment, proposal])), ["n0", "n1"]);
}

#[test]
fn an_edge_has_no_box_and_is_never_an_entry() {
    let mut scene = glyphs(&[b(0.0, 0.0, 5.0, 5.0)]);
    scene.nodes.insert(0, edge());
    assert_eq!(scene_digest(&scene).map(|d| d.nodes.len()), Ok(1));
    let alone = Scene { nodes: vec![edge()], legend: None };
    assert_eq!(scene_digest(&alone).map(|d| (d.nodes.len(), d.partial)), Ok((0, false)));
}

#[test]
fn touching_boxes_do_not_overlap_but_one_pixel_of_shared_area_does() {
    let touching = scene_digest(&glyphs(&[b(0.0, 0.0, 10.0, 10.0), b(10.0, 0.0, 10.0, 10.0)]));
    assert_eq!(touching.map(|d| d.overlaps.len()), Ok(0));
    let sharing = scene_digest(&glyphs(&[b(0.0, 0.0, 10.0, 10.0), b(9.0, 9.0, 10.0, 10.0)]));
    assert_eq!(sharing.map(|d| d.overlaps), Ok(vec![["n0".to_string(), "n1".to_string()]]));
}

#[test]
fn identical_boxes_overlap_and_neither_contains_the_other() {
    let digest =
        scene_digest(&named(&[("a", b(0.0, 0.0, 10.0, 10.0)), ("b", b(0.0, 0.0, 10.0, 10.0))]));
    let (overlaps, contained) =
        digest.map(|d| (d.overlaps.len(), d.containment.len())).unwrap_or_default();
    assert_eq!((overlaps, contained), (1, 0));
}

#[test]
fn a_cluster_forms_at_a_gap_of_exactly_24_and_not_past_it() {
    let at = scene_digest(&glyphs(&[b(0.0, 0.0, 10.0, 10.0), b(34.0, 0.0, 10.0, 10.0)]));
    assert_eq!(at.map(|d| d.clusters.len()), Ok(1));
    let past = scene_digest(&glyphs(&[b(0.0, 0.0, 10.0, 10.0), b(34.5, 0.0, 10.0, 10.0)]));
    assert_eq!(past.map(|d| d.clusters.len()), Ok(2));
}

#[test]
fn proximity_is_the_diagonal_gap() {
    // 16 by 16 is 22.6 and joins; 18 by 18 is 25.5 and, though each axis is
    // under 24, does not.
    let joined = scene_digest(&glyphs(&[b(0.0, 0.0, 10.0, 10.0), b(26.0, 26.0, 10.0, 10.0)]));
    assert_eq!(joined.map(|d| d.clusters.len()), Ok(1));
    let apart = scene_digest(&glyphs(&[b(0.0, 0.0, 10.0, 10.0), b(28.0, 28.0, 10.0, 10.0)]));
    assert_eq!(apart.map(|d| d.clusters.len()), Ok(2));
}

#[test]
fn a_box_ending_on_a_grid_line_leaves_the_next_cell_free() {
    let digest = scene_digest(&glyphs(&[b(0.0, 0.0, 40.0, 20.0), b(60.0, 20.0, 20.0, 20.0)]));
    let regions = digest.map(|d| d.free_regions).unwrap_or_default();
    assert_eq!(regions, [b(40.0, 0.0, 40.0, 20.0), b(0.0, 20.0, 60.0, 20.0)]);
}

#[test]
fn the_cell_budget_is_a_maximum_and_one_past_it_drops_the_regions() {
    let at = scene_digest(&glyphs(&[b(0.0, 0.0, 20.0, 20.0), b(9980.0, 9980.0, 20.0, 20.0)]));
    assert_eq!(at.map(|d| (d.free_regions.is_empty(), d.partial)), Ok((false, false)));
    let past = scene_digest(&glyphs(&[b(0.0, 0.0, 20.0, 20.0), b(9980.0, 10_000.0, 20.0, 20.0)]));
    assert_eq!(past.map(|d| (d.free_regions.len(), d.partial)), Ok((0, true)));
}

#[test]
fn the_region_cap_keeps_the_largest_in_position_order_and_says_partial() {
    let at_cap = glyphs(&[
        b(20.0, 0.0, 20.0, 501.0 * 20.0),
        b(0.0, 0.0, 20.0, 20.0),
        b(40.0, 0.0, 20.0, 20.0),
    ]);
    assert_eq!(scene_digest(&at_cap).map(|d| (d.free_regions.len(), d.partial)), Ok((1000, false)));
    let wide_right = glyphs(&[
        b(20.0, 0.0, 20.0, 601.0 * 20.0),
        b(0.0, 0.0, 20.0, 20.0),
        b(40.0, 0.0, 40.0, 20.0),
    ]);
    let digest = scene_digest(&wide_right);
    let first: Vec<BoundingBox> = digest
        .as_ref()
        .map(|d| d.free_regions.iter().take(4).copied().collect())
        .unwrap_or_default();
    assert_eq!(
        first,
        [
            b(0.0, 20.0, 20.0, 20.0),
            b(40.0, 20.0, 40.0, 20.0),
            b(0.0, 40.0, 20.0, 20.0),
            b(40.0, 40.0, 40.0, 20.0)
        ]
    );
    assert_eq!(digest.map(|d| (d.free_regions.len(), d.partial)), Ok((1000, true)));
}

#[test]
fn the_overlap_cap_stops_the_scan_one_pair_past_it() {
    let chain = |n: usize| {
        let boxes: Vec<BoundingBox> = (0..n)
            .map(|i| b(f64::from(u32::try_from(i).unwrap_or(0)) * 9.0, 0.0, 10.0, 10.0))
            .collect();
        scene_digest(&glyphs(&boxes)).map(|d| (d.overlaps.len(), d.partial))
    };
    assert_eq!(chain(1001), Ok((1000, false)));
    assert_eq!(chain(1002), Ok((1000, true)));
}

#[test]
fn past_the_entry_cap_the_pairwise_fields_are_empty_and_the_digest_partial() {
    let row = |n: u32| {
        glyphs(&(0..n).map(|i| b(f64::from(i) * 30.0, 0.0, 10.0, 10.0)).collect::<Vec<_>>())
    };
    let at = scene_digest(&row(2000));
    assert_eq!(at.map(|d| (d.clusters.len(), d.partial)), Ok((1, false)));
    let past = scene_digest(&row(2001));
    assert_eq!(
        past.map(|d| (d.clusters.len(), d.overlaps.len(), d.containment.len(), d.partial)),
        Ok((0, 0, 0, true))
    );
}

#[test]
fn a_grid_that_cannot_be_allocated_is_refused_and_a_nan_height_is_answered() {
    let nan = f64::NAN;
    assert_eq!(scene_digest(&glyphs(&[b(0.0, 0.0, nan, 10.0)])), Err(DigestError::InvalidGrid));
    assert_eq!(
        scene_digest(&glyphs(&[b(f64::INFINITY, 0.0, 10.0, 10.0)])),
        Err(DigestError::InvalidGrid)
    );
    let height = scene_digest(&glyphs(&[b(0.0, 0.0, 10.0, nan), b(5.0, 5.0, 5.0, 5.0)]));
    assert_eq!(height.map(|d| (d.free_regions.len(), d.partial)), Ok((0, false)));
}

#[test]
fn ids_order_by_code_unit_and_not_by_utf8_byte() {
    // U+1F600 is the pair D83D DE00 in UTF-16, which sorts before U+E000;
    // as UTF-8 bytes it sorts after.
    let digest = scene_digest(&named(&[
        ("\u{e000}", b(0.0, 0.0, 50.0, 50.0)),
        ("\u{1f600}", b(10.0, 10.0, 50.0, 50.0)),
    ]));
    assert_eq!(
        digest.map(|d| d.overlaps),
        Ok(vec![["\u{1f600}".to_string(), "\u{e000}".to_string()]])
    );
}

#[test]
fn overlaps_are_scanned_at_exactly_the_entry_cap_and_dropped_one_past_it() {
    let stack = |n: usize| {
        let boxes = vec![b(0.0, 0.0, 10.0, 10.0); n];
        scene_digest(&glyphs(&boxes)).map(|d| d.overlaps.len())
    };
    assert_eq!(stack(2000), Ok(1000));
    assert_eq!(stack(2001), Ok(0));
}

#[test]
fn containment_is_derived_at_exactly_the_entry_cap_and_dropped_one_past_it() {
    let inside = |n: usize| {
        let mut boxes = vec![b(0.0, 0.0, 100.0, 100.0)];
        boxes.extend(std::iter::repeat_n(b(10.0, 10.0, 5.0, 5.0), n.saturating_sub(1)));
        scene_digest(&glyphs(&boxes)).map(|d| d.containment.len())
    };
    assert_eq!(inside(2000), Ok(1999));
    assert_eq!(inside(2001), Ok(0));
}
