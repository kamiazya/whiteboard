use serde_json::{Value as Json, json};
use whiteboard_canvas_render::typeset::FittedBlocks;
use whiteboard_proptest::proptest::prelude::*;
use whiteboard_proptest::{Floor, check};
use whiteboard_scene::{BoundingBox, SceneNode, ThematicBreakNode};

use super::{
    MAX_CACHED_BODIES, MAX_CACHED_BYTES, Resident, Surface, measurer_of, release_layout_cache,
    resident,
};
use crate::json_canvas_wire::canvas_json;
use crate::spatial_layout::host_measure::Host;
use crate::spatial_layout::request::MeasureSpec;
use crate::spatial_layout::tests::{board, m, request, s};
use crate::spatial_layout::{MAX_BODY_BYTES, layout_with_host};
use whiteboard_canvas_render::compose_node::ContentCache;
use whiteboard_model::spatial::{NodeResource, SpatialCanvas, SpatialNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A body told apart from another by its mark.
fn body(mark: usize) -> FittedBlocks {
    let x = f64::from(u32::try_from(mark).unwrap_or(u32::MAX));
    let bbox = BoundingBox { x, y: 0.0, w: 1.0, h: 1.0 };
    let rule = SceneNode::ThematicBreak(ThematicBreakNode { bbox, appearance: None });
    FittedBlocks { nodes: vec![rule], truncated: false, overflows: false }
}

/// One step against the store: a surface, and one of five keys.
#[derive(Debug, Clone)]
enum Op {
    Get(u32, usize),
    Set(u32, usize),
    Release(u32),
}

const BODIES: usize = 4;
const BYTES: usize = 24;

/// The keys' lengths: each fits alone but two of the longest do not fit
/// together, and the last is past the byte cap, so both caps evict and the
/// one key no store keeps is drawn too.
const LENGTHS: [usize; 5] = [2, 5, 9, 14, 25];

fn key(k: usize) -> String {
    format!("{k}{}", "x".repeat(LENGTHS[k] - 1))
}

fn op() -> impl Strategy<Value = Op> {
    // Two surfaces, so a step mostly lands on something kept.
    prop_oneof![
        3 => (0_u32..2, 0..LENGTHS.len()).prop_map(|(s, k)| Op::Get(s, k)),
        4 => (0_u32..2, 0..LENGTHS.len()).prop_map(|(s, k)| Op::Set(s, k)),
        1 => (0_u32..2).prop_map(Op::Release),
    ]
}

/// The reference: what is kept, least recently used first, as a plain list.
#[derive(Default)]
struct Model(Vec<(u32, String, usize)>);

impl Model {
    fn bytes(&self) -> usize {
        self.0.iter().map(|(_, key, _)| key.len()).sum()
    }

    fn get(&mut self, surface: u32, key: &str) -> Option<usize> {
        let at = self.0.iter().position(|(s, k, _)| *s == surface && k == key)?;
        let entry = self.0.remove(at);
        let mark = entry.2;
        self.0.push(entry);
        Some(mark)
    }

    /// Whether keeping `key` forgot another body to make room.
    fn set(&mut self, surface: u32, key: String, mark: usize) -> bool {
        if key.len() > BYTES {
            return false;
        }
        self.0.retain(|(s, k, _)| !(*s == surface && *k == key));
        let mut forgot = false;
        while self.0.len() >= BODIES || self.bytes() + key.len() > BYTES {
            self.0.remove(0);
            forgot = true;
        }
        self.0.push((surface, key, mark));
        forgot
    }

    fn release(&mut self, surface: u32) -> bool {
        let before = self.0.len();
        self.0.retain(|(s, _, _)| *s != surface);
        self.0.len() < before
    }
}

#[test]
fn the_store_answers_as_a_least_recently_used_list_held_to_both_caps() {
    let by_count = Floor::new("a run that forgot a body at the body cap");
    let by_bytes = Floor::new("a run that forgot a body at the byte cap");
    let hit = Floor::new("a run with a hit that reordered what is forgotten next");
    check(prop::collection::vec(op(), 1..48), None, |ops| {
        let mut store = Resident::new(BODIES, BYTES);
        let mut model = Model::default();
        let (mut counted, mut sized, mut reordered) = (false, false, false);
        for (at, op) in ops.iter().enumerate() {
            match *op {
                Op::Get(surface, k) => {
                    let oldest = model.0.first().map(|(s, key, _)| (*s, key.clone()));
                    let want = model.get(surface, &key(k));
                    reordered |=
                        want.is_some() && oldest == Some((surface, key(k))) && model.0.len() > 1;
                    prop_assert_eq!(store.get(surface, &key(k)), want.map(body), "step {}", at);
                }
                Op::Set(surface, k) => {
                    let full = model.0.len() >= BODIES;
                    let forgot = model.set(surface, key(k), at);
                    counted |= forgot && full;
                    sized |= forgot && !full;
                    store.set(surface, key(k), body(at));
                }
                Op::Release(surface) => {
                    prop_assert_eq!(store.release(surface), model.release(surface));
                }
            }
            prop_assert_eq!(store.held(), (model.0.len(), model.bytes()), "step {}", at);
        }
        by_count.draw(counted);
        by_bytes.draw(sized);
        hit.draw(reordered);
        Ok(())
    });
    by_count.assert(20);
    by_bytes.assert(20);
    hit.assert(20);
}

#[test]
fn a_key_past_the_byte_cap_is_not_kept() {
    let mut store = Resident::new(BODIES, BYTES);
    store.set(0, "a".repeat(BYTES), body(0));
    assert_eq!(store.held(), (1, BYTES));
    store.set(0, "b".repeat(BYTES + 1), body(1));
    assert_eq!(store.held(), (1, BYTES));
    assert!(store.holds(0, &"a".repeat(BYTES)));
}

#[test]
fn the_instance_caps_bound_the_bodies_and_their_text() {
    assert_eq!(MAX_CACHED_BODIES, 4096);
    assert_eq!(MAX_CACHED_BYTES, 4 * MAX_BODY_BYTES);
}

#[test]
fn a_key_names_the_measurer_and_the_mode() {
    let names = [
        measurer_of(&MeasureSpec::Fake(0.6)),
        measurer_of(&MeasureSpec::Fake(0.5)),
        measurer_of(&MeasureSpec::Ratio),
        measurer_of(&MeasureSpec::Fonts(1)),
        measurer_of(&MeasureSpec::Fonts(2)),
        measurer_of(&MeasureSpec::Host),
    ];
    assert_eq!(names, ["fake:0.6", "fake:0.5", "ratio", "fonts:1", "fonts:2", "host"]);
    let light = Surface::new(7, &MeasureSpec::Host, false);
    let dark = Surface::new(7, &MeasureSpec::Host, true);
    assert_eq!(light.key("[1]"), "host|light|[1]");
    assert_eq!(dark.key("[1]"), "host|dark|[1]");
}

#[test]
fn a_layout_reads_its_own_writes_and_keeps_them_only_when_told() {
    let surface_id = 0x5150_0001;
    let surface = Surface::new(surface_id, &MeasureSpec::Ratio, false);
    surface.set("[k]", &body(3));
    assert_eq!(surface.get("[k]"), Some(body(3)));
    assert_eq!(resident().kept_by(surface_id), 0);
    surface.keep();
    assert!(resident().holds(surface_id, "ratio|light|[k]"));
    let next = Surface::new(surface_id, &MeasureSpec::Ratio, false);
    assert_eq!(next.get("[k]"), Some(body(3)));
    assert_eq!(Surface::new(surface_id, &MeasureSpec::Ratio, true).get("[k]"), None);
    assert!(release_layout_cache(surface_id));
    assert!(!release_layout_cache(surface_id));
}

/// A host that answers nothing, so every layout it measures is declined.
struct Silent;

impl Host for Silent {
    fn measure(&self, _: &str, _: &str) -> Option<[f64; 4]> {
        None
    }
}

fn lay(surface: u32, body: &str, extra: &[(&str, Json)]) -> Json {
    let mut fields = vec![("cache", json!(surface))];
    fields.extend(extra.iter().cloned());
    serde_json::from_str(&layout_with_host(&request(board(body), &fields), None))
        .unwrap_or(Json::Null)
}

#[test]
fn an_answered_layout_keeps_its_bodies_for_the_next_and_draws_the_same() {
    let surface = 0x5150_0002;
    let first = lay(surface, "# Hello\n\nworld", &[]);
    assert_eq!(first.get(0), Some(&json!("ok")), "{first}");
    assert_eq!(resident().kept_by(surface), 1);
    assert_eq!(lay(surface, "# Hello\n\nworld", &[]), first);
    assert_eq!(resident().kept_by(surface), 1);
    // Another mode is another key.
    let dark = lay(surface, "# Hello\n\nworld", &[("mode", json!("dark"))]);
    assert_eq!(dark.get(0), Some(&json!("ok")));
    assert_eq!(resident().kept_by(surface), 2);
    assert!(release_layout_cache(surface));
    assert_eq!(resident().kept_by(surface), 0);
}

/// A board of a plain body and `other`, side by side.
fn beside(other: &str) -> Json {
    let node = |id: &str, x: f64, body: &str| SpatialNode {
        id: id.to_owned(),
        x,
        width: 160.0,
        height: 80.0,
        resource: Some(NodeResource {
            mime_type: "text/markdown".to_owned(),
            content: Some(body.to_owned()),
            ..NodeResource::default()
        }),
        ..SpatialNode::default()
    };
    let nodes = vec![node("a", 0.0, "plain"), node("b", 400.0, other)];
    canvas_json(&SpatialCanvas { nodes, ..SpatialCanvas::default() })
}

fn lay_board(surface: u32, canvas: Json, host: Option<&dyn Host>, extra: &[(&str, Json)]) -> Json {
    let mut fields = vec![("cache", json!(surface))];
    fields.extend(extra.iter().cloned());
    serde_json::from_str(&layout_with_host(&request(canvas, &fields), host)).unwrap_or(Json::Null)
}

#[test]
fn a_layout_asking_for_fences_keeps_every_body_but_the_fence() {
    let surface = 0x5150_0005;
    let needs = lay_board(surface, beside("```js\nlet x = 1\n```"), None, &[]);
    assert_eq!(needs.get(0), Some(&json!("needs")), "{needs}");
    assert_eq!(resident().kept_by(surface), 1);
    assert!(release_layout_cache(surface));
}

#[test]
fn a_declined_layout_keeps_nothing() {
    let surface = 0x5150_0003;
    // A body past the parser's bounds.
    let deep = format!("{} x", ">".repeat(64));
    let refused = lay_board(surface, beside(&deep), None, &[]);
    assert_eq!(refused.get(0), Some(&json!("declined")), "{refused}");
    // More fragment markup than a layout may place.
    let third = "a".repeat(super::super::MAX_PLACED_BYTES / 3 + 1);
    let row = s(vec![json!("math:x"), m(&[("svg", json!(third))])]);
    let thrice = ["$$\nx\n$$"; 3].join("\n\n");
    let over = lay_board(surface, beside(&thrice), None, &[("fragments", s(vec![row]))]);
    assert_eq!(over, json!(["declined", "fragments"]));
    // A host that did not answer.
    let host = m(&[("kind", json!("host"))]);
    let silent = lay_board(surface, beside("x"), Some(&Silent), &[("measure", host)]);
    assert_eq!(silent, json!(["declined", "host-measure"]));
    assert_eq!(resident().kept_by(surface), 0);
}

#[test]
fn a_body_that_asked_the_fragment_table_is_not_kept() {
    let surface = 0x5150_0004;
    let table = s(vec![s(vec![json!("math:x"), m(&[("svg", json!("<g/>"))])])]);
    let laid = lay(surface, "$$\nx\n$$", &[("fragments", table.clone())]);
    assert_eq!(laid.get(0), Some(&json!("ok")), "{laid}");
    assert_eq!(resident().kept_by(surface), 0);
    lay(surface, "plain", &[("fragments", table)]);
    assert_eq!(resident().kept_by(surface), 1);
    assert!(release_layout_cache(surface));
}

#[test]
fn a_surface_id_is_a_whole_number_a_u32_holds() {
    for bad in [json!(-1), json!(["f", "3ff8000000000000"]), json!(4_294_967_296_u64), json!("1")] {
        let got = lay(0, "x", &[("cache", bad.clone())]);
        assert_eq!(got, json!(["refused", "malformed", "request"]), "{bad}");
    }
}

#[test]
fn a_key_is_hashed_as_fnv_1a_hashes_it() {
    assert_eq!(super::hash_of(""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(super::hash_of("a"), 0xaf63_dc4c_8601_ec8c);
    assert_ne!(super::hash_of("ab"), super::hash_of("ba"));
}
