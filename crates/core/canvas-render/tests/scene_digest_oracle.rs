//! `scene_digest` against the recorded TypeScript answers.
//!
//! `packages/canvas-render/src/oracle/scene-digest.jsonl` holds what `sceneDigest`
//! answered, as the text `JSON.stringify` makes of it, in three kinds: `real`,
//! the scenes of `svg.jsonl` (the goldens and every laid-out canvas) by id; `case`,
//! a scene written as a spec; and `chunk`, boards regenerated here from the `meta`
//! record, one digest per chunk. A digest past a few thousand characters is held
//! as its UTF-16 length and an FNV digest. Its TypeScript test fails when the file
//! no longer equals today's answer; this replays it, byte for byte, and a scene the
//! TypeScript throws `RangeError` for must be refused here.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::scene_digest::{DigestError, scene_digest};
use whiteboard_model::spatial::EdgeSide;
use whiteboard_scene::{
    BoundingBox, EdgeEnd, GlyphSceneNode, ProposalChrome, ResolvedEdgeNode, Scene, SceneNode,
    ShapeSceneNode,
};

const RECORDING: &str =
    include_str!("../../../../packages/canvas-render/src/oracle/scene-digest.jsonl");
const SVG_RECORDING: &str = include_str!("../../../../packages/canvas-render/src/oracle/svg.jsonl");

/// A coordinate JSON cannot hold is written by name.
#[derive(Deserialize)]
#[serde(untagged)]
enum Num {
    Number(f64),
    Name(String),
}

impl Num {
    fn value(&self) -> f64 {
        match self {
            Num::Number(n) => *n,
            Num::Name(name) => match name.as_str() {
                "nan" => f64::NAN,
                "inf" => f64::INFINITY,
                "-inf" => f64::NEG_INFINITY,
                _ => -0.0,
            },
        }
    }
}

#[derive(Deserialize)]
struct Node {
    t: String,
    i: Option<String>,
    b: Option<[Num; 4]>,
    f: Option<String>,
    r: Option<u32>,
    d: Option<[f64; 2]>,
}

/// What a record keeps of a digest: its text, nothing for a scene the
/// TypeScript throws on, or its length and FNV digest.
#[derive(Deserialize)]
struct Answer {
    d: Option<String>,
    n: Option<usize>,
    h: Option<u32>,
}

#[derive(Deserialize)]
#[serde(tag = "k", rename_all = "lowercase")]
enum Record {
    Meta {
        seed: u32,
        chunks: u32,
        per: u32,
    },
    Real {
        id: String,
        #[serde(flatten)]
        answer: Answer,
    },
    Case {
        id: String,
        spec: Vec<Node>,
        #[serde(flatten)]
        answer: Answer,
    },
    Chunk {
        c: u32,
        n: u32,
        h: u32,
    },
}

#[derive(Deserialize)]
struct SvgRecord {
    id: String,
    scene: Value,
}

/// FNV-1a over 32-bit words, as the TypeScript digest.
struct Fnv(u32);

impl Fnv {
    fn new() -> Self {
        Self(0x811c_9dc5)
    }
    fn feed(&mut self, word: u32) {
        self.0 = (self.0 ^ word).wrapping_mul(16_777_619);
    }
    fn text(&mut self, text: &str) {
        for unit in text.encode_utf16() {
            self.feed(u32::from(unit));
        }
    }
}

fn scene_of_spec(spec: &[Node]) -> Scene {
    let mut nodes = Vec::new();
    for node in spec {
        for copy in 0..node.r.unwrap_or(1) {
            nodes.push(scene_node(node, f64::from(copy)));
        }
    }
    Scene { nodes, legend: None }
}

fn scene_node(node: &Node, copy: f64) -> SceneNode {
    let [x, y, w, h] = node
        .b
        .as_ref()
        .map_or([0.0; 4], |b| [b[0].value(), b[1].value(), b[2].value(), b[3].value()]);
    let [dx, dy] = node.d.unwrap_or([0.0, 0.0]);
    let bbox = BoundingBox { x: x + copy * dx, y: y + copy * dy, w, h };
    let flags = node.f.as_deref().unwrap_or("");
    match node.t.as_str() {
        "e" => SceneNode::Edge(Box::new(ResolvedEdgeNode {
            id: node.i.clone().unwrap_or_else(|| "edge".into()),
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
        })),
        "g" => SceneNode::Glyph(GlyphSceneNode { bbox, glyph: "g".into() }),
        _ => SceneNode::Shape(Box::new(ShapeSceneNode {
            truncated: flags.contains('t'),
            overflows: flags.contains('o'),
            id: node.i.clone(),
            bbox,
            comment_chrome: flags.contains('c'),
            proposal_chrome: flags
                .contains('p')
                .then(|| ProposalChrome { proposal_id: "p1".into() }),
            radius: None,
            shape: None,
            appearance: None,
            task_box: None,
            ink: None,
        })),
    }
}

/// The text of a digest, or `None` where the digest is refused.
fn digest_text(scene: &Scene) -> Option<String> {
    scene_digest(scene).ok().map(|d| d.to_json())
}

/// What disagrees between a recorded answer and the digest of `scene`.
fn disagreement(answer: &Answer, scene: &Scene) -> Option<String> {
    let text = digest_text(scene);
    match (&answer.h, &answer.d, text) {
        (Some(h), _, Some(text)) => {
            let mut fnv = Fnv::new();
            fnv.text(&text);
            let n = text.encode_utf16().count();
            (answer.n != Some(n) || fnv.0 != *h)
                .then(|| format!("held as {:?} chars / {h}, got {n} / {}", answer.n, fnv.0))
        }
        (None, Some(want), Some(text)) => (*want != text).then(|| first_difference(want, &text)),
        (None, None, None) => None,
        (_, _, None) => Some("refused, but the TypeScript answers".into()),
        (_, _, Some(_)) => Some("answered, but the TypeScript throws".into()),
    }
}

/// Where two strings first differ, with a little of each side of it.
fn first_difference(expected: &str, got: &str) -> String {
    let at = expected.chars().zip(got.chars()).take_while(|(a, b)| a == b).count();
    let window =
        |text: &str| text.chars().skip(at.saturating_sub(40)).take(120).collect::<String>();
    format!("at char {at}\n  expected: {}\n  got:      {}", window(expected), window(got))
}

fn records() -> Result<Vec<Record>, String> {
    RECORDING
        .lines()
        .map(|line| serde_json::from_str::<Record>(line).map_err(|e| format!("{e}: {line}")))
        .collect()
}

#[test]
fn every_real_scene_is_digested_as_the_typescript_digested_it() {
    let scenes: BTreeMap<String, Value> = SVG_RECORDING
        .lines()
        .map(|line| serde_json::from_str::<SvgRecord>(line).map(|r| (r.id, r.scene)))
        .collect::<Result<_, _>>()
        .unwrap_or_default();
    let mut count = 0;
    for record in records().expect("the recording is read") {
        let Record::Real { id, answer } = record else { continue };
        let scene: Result<Scene, _> =
            serde_json::from_value(scenes.get(&id).cloned().unwrap_or_default());
        assert!(scene.is_ok(), "{id}: the scene is not read: {:?}", scene.as_ref().err());
        let scene = scene.unwrap_or_default();
        let found = disagreement(&answer, &scene);
        assert!(found.is_none(), "{id}: {}", found.unwrap_or_default());
        count += 1;
    }
    assert!(count >= 135, "the recording holds {count} real scenes");
}

#[test]
fn every_recorded_case_is_digested_as_the_typescript_digested_it() {
    let mut count = 0;
    for record in records().expect("the recording is read") {
        let Record::Case { id, spec, answer } = record else { continue };
        let found = disagreement(&answer, &scene_of_spec(&spec));
        assert!(found.is_none(), "{id}: {}", found.unwrap_or_default());
        count += 1;
    }
    assert!(count >= 170, "the recording holds {count} cases");
}

#[test]
fn a_grid_that_cannot_be_allocated_is_refused_not_answered() {
    let spec =
        |b: [Num; 4]| vec![Node { t: "g".into(), i: None, b: Some(b), f: None, r: None, d: None }];
    let nan_width =
        [Num::Number(0.0), Num::Number(0.0), Num::Name("nan".into()), Num::Number(10.0)];
    let scene = scene_of_spec(&spec(nan_width));
    assert_eq!(scene_digest(&scene), Err(DigestError::InvalidGrid));
}

/// mulberry32, the seeded stream of the chunks.
fn mulberry32(seed: u32) -> impl FnMut() -> u32 {
    let mut a = seed;
    move || {
        a = a.wrapping_add(0x6d2b_79f5);
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(0x3d | t)) ^ t;
        t ^ (t >> 14)
    }
}

/// Ids chosen to collide and to order differently by code unit than by byte.
const ID_POOL: [&str; 12] = [
    "a",
    "b",
    "c",
    "B",
    "10",
    "9",
    "\u{e9}",
    "\u{e000}",
    "\u{ffff}",
    "\u{1f600}",
    "\u{10000}",
    "q\"\\",
];

/// A spec node over a plain box.
fn node(t: &str, i: Option<&str>, b: [u32; 4], f: Option<&str>) -> Node {
    Node {
        t: t.into(),
        i: i.map(String::from),
        b: Some(b.map(|v| Num::Number(f64::from(v)))),
        f: f.map(String::from),
        r: None,
        d: None,
    }
}

/// One seeded board, drawing from `next` in the order the TypeScript does.
fn seeded_spec(next: &mut impl FnMut() -> u32) -> Vec<Node> {
    let scale = next() % 3;
    let unit = [5_u32, 20, 50][usize::try_from(scale).unwrap_or(0)];
    let size_unit = if scale == 2 { 4 } else { unit };
    let count = 1 + (next() % 16);
    let mut nodes = Vec::new();
    for _ in 0..count {
        let roll = next() % 13;
        let left = (next() % 30) * unit;
        let top = (next() % 30) * unit;
        let width = (next() % 24) * size_unit;
        let height = (next() % 24) * size_unit;
        let b = [left, top, width, height];
        let id = ID_POOL.get(usize::try_from(next()).unwrap_or(0) % ID_POOL.len()).copied();
        let flags = match next() % 7 {
            0 => Some("t"),
            1 => Some("o"),
            2 => Some("to"),
            _ => None,
        };
        nodes.push(match roll {
            12 => Node { b: None, ..node("e", id, b, None) },
            11 => Node { i: None, ..node("g", None, b, None) },
            10 => node("s", id, b, Some("p")),
            9 => node("s", id, b, Some("c")),
            8 => node("s", None, b, flags),
            _ => node("s", id, b, flags),
        });
    }
    nodes
}

#[test]
fn every_seeded_chunk_is_digested_as_the_typescript_digested_it() {
    let records = records().expect("the recording is read");
    let meta = records.first();
    assert!(matches!(meta, Some(Record::Meta { .. })), "the recording opens with its meta record");
    let Some(Record::Meta { seed, chunks, per }) = meta else { return };
    let recorded: BTreeMap<u32, (u32, u32)> = records
        .iter()
        .filter_map(|r| if let Record::Chunk { c, n, h } = r { Some((*c, (*n, *h))) } else { None })
        .collect();
    assert_eq!(recorded.len(), usize::try_from(*chunks).unwrap_or(0));
    for chunk in 0..*chunks {
        let mut next = mulberry32(seed.wrapping_add(chunk));
        let mut fnv = Fnv::new();
        for _ in 0..*per {
            match digest_text(&scene_of_spec(&seeded_spec(&mut next))) {
                Some(text) => fnv.text(&text),
                None => fnv.feed(0xffff_fffe),
            }
            fnv.feed(0xffff_ffff);
        }
        assert_eq!(recorded.get(&chunk), Some(&(*per, fnv.0)), "chunk {chunk}: (boards, digest)");
    }
}
