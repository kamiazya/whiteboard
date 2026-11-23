//! The spatial writers as properties over boards written here: a batch of one
//! step writes what the single writer writes, byte for byte, and a run of node
//! removals leaves no edge, line or lock behind on what it removed.
//!
//! Every board holds, by construction, a node `n0` with an edge, a line and a
//! lock on it and two kept nodes joined by an edge, so every draw removes
//! something by cascade and keeps something; the random rest is more nodes,
//! edges and lines between them. The surviving elements are expected from the
//! board as drawn, not read back through the writers they judge.

use std::collections::BTreeSet;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{ExportMode, LoroDoc, WriteAnswer, deep_value_with_id, write_batch};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use whiteboard_proptest::proptest::prelude::{Strategy, any, prop, prop_assert_eq};
use whiteboard_proptest::{Floor, check};

const KEPT: [&str; 2] = ["keep1", "keep2"];

#[cfg(test)]
fn object(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

#[cfg(test)]
fn text(s: &str) -> Value {
    Value::String(s.to_owned())
}

#[cfg(test)]
fn node(id: &str, x: u8) -> Value {
    let n = |v: f64| Value::Number(v);
    object(vec![
        ("id", text(id)),
        ("x", n(f64::from(x))),
        ("y", n(0.5)),
        ("width", n(40.0)),
        ("height", n(20.0)),
    ])
}

#[cfg(test)]
fn end(node: Option<&str>, line: bool) -> Value {
    match (node, line) {
        (Some(id), false) => object(vec![("node", text(id))]),
        (Some(id), true) => object(vec![("kind", text("node")), ("node", text(id))]),
        (None, _) => object(vec![
            ("kind", text("point")),
            ("point", object(vec![("x", Value::Number(1.0)), ("y", Value::Number(2.0))])),
        ]),
    }
}

/// A board as drawn: the extra nodes, the random edges and lines between all
/// nodes (an index past the nodes is a free end), and which extras go.
#[cfg(test)]
#[derive(Debug, Clone)]
struct Board {
    extras: usize,
    edges: Vec<(usize, usize)>,
    lines: Vec<(usize, usize)>,
    gone: Vec<bool>,
    x: u8,
}

#[cfg(test)]
impl Board {
    fn ids(&self) -> Vec<String> {
        let mut ids = vec!["n0".to_owned(), KEPT[0].to_owned(), KEPT[1].to_owned()];
        ids.extend((1..=self.extras).map(|i| format!("n{i}")));
        ids
    }

    /// The nodes removed: `n0` always, and the extras drawn to go.
    fn removed(&self) -> BTreeSet<String> {
        let mut removed = BTreeSet::from(["n0".to_owned()]);
        for (i, gone) in self.gone.iter().take(self.extras).enumerate() {
            if *gone {
                removed.insert(format!("n{}", i + 1));
            }
        }
        removed
    }

    /// Every edge and line with its ends' nodes, the fixed ones first.
    fn elements(&self) -> Vec<(String, bool, Option<String>, Option<String>)> {
        let ids = self.ids();
        let at = |i: usize| ids.get(i).cloned();
        let mut all = vec![
            ("e0".to_owned(), false, Some("n0".to_owned()), Some(KEPT[0].to_owned())),
            ("ek".to_owned(), false, Some(KEPT[0].to_owned()), Some(KEPT[1].to_owned())),
            ("l0".to_owned(), true, None, Some("n0".to_owned())),
        ];
        for (i, (from, to)) in self.edges.iter().enumerate() {
            let (from, to) = (from % ids.len(), to % ids.len());
            all.push((format!("e{}", i + 1), false, at(from), at(to)));
        }
        for (i, (from, to)) in self.lines.iter().enumerate() {
            all.push((format!("l{}", i + 1), true, at(*from), at(*to)));
        }
        all
    }

    fn canvas(&self) -> Value {
        let nodes = self.ids().iter().map(|id| node(id, self.x)).collect();
        let (mut edges, mut lines) = (Vec::new(), Vec::new());
        for (id, line, from, to) in self.elements() {
            let element = object(vec![
                ("id", text(&id)),
                ("from", end(from.as_deref(), line)),
                ("to", end(to.as_deref(), line)),
            ]);
            if line { lines.push(element) } else { edges.push(element) }
        }
        object(vec![
            ("nodes", Value::Seq(nodes)),
            ("edges", Value::Seq(edges)),
            ("lines", Value::Seq(lines)),
        ])
    }
}

#[cfg(test)]
fn board() -> impl Strategy<Value = Board> {
    let pair = || (0_usize..8, 0_usize..8);
    (
        0_usize..4,
        prop::collection::vec(pair(), 0..5),
        prop::collection::vec(pair(), 0..5),
        prop::collection::vec(any::<bool>(), 4),
        any::<u8>(),
    )
        .prop_map(|(extras, edges, lines, gone, x)| Board { extras, edges, lines, gone, x })
}

#[cfg(test)]
fn write(op: WriterName, args: Value) -> Write {
    Write { op, args }
}

#[cfg(test)]
fn lock(op: WriterName, id: &str) -> Write {
    write(op, object(vec![("id", text(id)), ("locked", Value::Bool(true))]))
}

/// The board written, with locks on `n0`, `e0`, `l0` and the kept edge.
#[cfg(test)]
fn written(board: &Board) -> Vec<u8> {
    let batch = [
        write(WriterName::WriteSpatialCanvas, object(vec![("canvas", board.canvas())])),
        lock(WriterName::SetNodeLock, "n0"),
        lock(WriterName::SetEdgeLock, "e0"),
        lock(WriterName::SetEdgeLock, "l0"),
        lock(WriterName::SetEdgeLock, "ek"),
    ];
    let empty = LoroDoc::new().export(ExportMode::Snapshot).expect("an empty snapshot");
    let done = write_batch(&empty, 7, &batch, WriteJudge::None).expect("the board is written");
    done.doc.export(ExportMode::Snapshot).expect("a snapshot")
}

#[cfg(test)]
fn applied(before: &[u8], batch: &[Write]) -> (WriteAnswer, LoroDoc) {
    let done = write_batch(before, 3, batch, WriteJudge::None).expect("answered");
    (done.answer, done.doc)
}

#[cfg(test)]
fn keys(doc: &LoroDoc, map: &str) -> BTreeSet<String> {
    doc.get_map(map).keys().map(|key| key.to_string()).collect()
}

/// The four steps of a batch, each beside the single writer that is its twin.
#[cfg(test)]
fn twins(board: &Board) -> Vec<(Write, Value)> {
    let step = |op: &str, key: &str, value: Value| object(vec![("op", text(op)), (key, value)]);
    let new_edge = object(vec![
        ("id", text("e-new")),
        ("from", end(Some("n0"), false)),
        ("to", end(Some(KEPT[1]), false)),
    ]);
    vec![
        (
            write(
                WriterName::WriteSpatialNode,
                object(vec![("node", node("n0", board.x.wrapping_add(1)))]),
            ),
            step("writeNode", "node", node("n0", board.x.wrapping_add(1))),
        ),
        (
            write(WriterName::WriteSpatialEdge, object(vec![("edge", new_edge.clone())])),
            step("writeEdge", "edge", new_edge),
        ),
        (
            write(WriterName::DeleteSpatialNode, object(vec![("id", text("n0"))])),
            step("deleteNode", "id", text("n0")),
        ),
        (
            write(WriterName::DeleteSpatialEdge, object(vec![("id", text("ek"))])),
            step("deleteEdge", "id", text("ek")),
        ),
    ]
}

#[test]
#[cfg(test)]
fn a_batch_of_one_step_writes_what_its_single_writer_writes() {
    let cascaded = Floor::new("a removal that swept an edge and a line");
    check(board(), None, |board| {
        let before = written(&board);
        for (single, step) in twins(&board) {
            let batch = object(vec![("steps", Value::Seq(vec![step]))]);
            let (one, one_doc) = applied(&before, std::slice::from_ref(&single));
            let (many, many_doc) = applied(&before, &[write(WriterName::WithSpatialBatch, batch)]);
            prop_assert_eq!(&one, &many);
            prop_assert_eq!(deep_value_with_id(&one_doc), deep_value_with_id(&many_doc));
            if single.op == WriterName::DeleteSpatialNode {
                let swept = !keys(&one_doc, "edges").contains("e0")
                    && !keys(&one_doc, "lines").contains("l0");
                cascaded.draw(swept);
            }
        }
        Ok(())
    });
    cascaded.assert(150);
}

#[test]
#[cfg(test)]
fn a_run_of_removals_leaves_nothing_anchored_on_what_it_removed() {
    let mixed = Floor::new("a run that swept an element and kept one");
    check(board(), None, |board| {
        let before = written(&board);
        let removed = board.removed();
        let steps = removed
            .iter()
            .map(|id| object(vec![("op", text("deleteNode")), ("id", text(id))]))
            .collect();
        let batch = object(vec![("steps", Value::Seq(steps))]);
        let (_, doc) = applied(&before, &[write(WriterName::WithSpatialBatch, batch)]);
        let on_removed = |n: &Option<String>| n.as_ref().is_some_and(|n| removed.contains(n));
        let (mut edges, mut lines) = (BTreeSet::new(), BTreeSet::new());
        for (id, line, from, to) in board.elements() {
            if !on_removed(&from) && !on_removed(&to) {
                if line {
                    lines.insert(id)
                } else {
                    edges.insert(id)
                };
            }
        }
        let nodes: BTreeSet<String> =
            board.ids().into_iter().filter(|id| !removed.contains(id)).collect();
        prop_assert_eq!(keys(&doc, "nodes"), nodes);
        prop_assert_eq!(&keys(&doc, "edges"), &edges);
        prop_assert_eq!(&keys(&doc, "lines"), &lines);
        prop_assert_eq!(keys(&doc, "nodeLocks"), BTreeSet::new());
        let locks: BTreeSet<String> =
            ["ek"].iter().map(|id| (*id).to_owned()).filter(|id| edges.contains(id)).collect();
        prop_assert_eq!(keys(&doc, "edgeLocks"), locks);
        mixed.draw(!edges.contains("e0") && edges.contains("ek"));
        Ok(())
    });
    mixed.assert(150);
}
