//! The record's history reads as properties over draws made here.
//!
//! - What `removedSince` exports brings back exactly the documents the writes
//!   after the version removed, each once, and no survivor: a removed document
//!   rides the bytes of a removed ancestor unless a survivor sits between
//!   them, and a survivor below is cut from them. The removed set is read off
//!   the listings before and after, not off the reader. Every draw nests a
//!   chain whose top two levels are removed (the lower riding the upper) above
//!   a survivor above a removed level, so every draw holds both arrangements.
//! - `organisationChangedSince` answers false after writes that only rename or
//!   stamp documents, and true once a write that places one joins them. Every
//!   draw asks both batches.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{
    ExportMode, LoroDoc, VersionVector, WriteAnswer, organisation_changed_since,
};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert, prop_assert_eq};
use whiteboard_proptest::{Floor, check};
use whiteboard_workspace_index::{WorkspaceRecord, documents_removed_since, write_workspace_batch};

#[cfg(test)]
fn map(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

#[cfg(test)]
fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

#[cfg(test)]
fn id(i: usize) -> String {
    format!("01ARZ3NDEKTSV4RRFFQ69G5F{i:02}")
}

#[cfg(test)]
fn by_id(op: WriterName, i: usize, more: Vec<(&str, Value)>) -> Write {
    let mut entries = vec![("documentId", text(&id(i)))];
    entries.extend(more);
    Write { op, args: map(entries) }
}

#[cfg(test)]
fn applied(before: &LoroDoc, batch: &[Write]) -> LoroDoc {
    let bytes = before.export(ExportMode::Snapshot).expect("a snapshot");
    let done = write_workspace_batch(&bytes, 1, batch, WriteJudge::None, 7.0).expect("answered");
    assert!(matches!(done.answer, WriteAnswer::Applied(_)), "{:?}", done.answer);
    done.doc
}

/// A chain of documents, each below the one before it.
#[cfg(test)]
fn chain(levels: usize) -> LoroDoc {
    let batch: Vec<Write> = (0..levels)
        .map(|i| {
            let path = (0..=i).map(|at| format!("l{at}")).collect::<Vec<_>>().join("/");
            let args = map(vec![
                ("path", text(&path)),
                ("documentId", text(&id(i))),
                ("kind", text("markdown")),
            ]);
            Write { op: WriterName::CreateWorkspaceDocumentAtPath, args }
        })
        .collect();
    applied(&LoroDoc::new(), &batch)
}

#[cfg(test)]
fn live_ids(doc: &LoroDoc) -> Vec<String> {
    WorkspaceRecord::over(doc).documents().into_iter().map(|found| found.document_id).collect()
}

/// Every document id a removed entry's state holds, a tree node's meta's.
#[cfg(test)]
fn ids_in(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Map(entries) => {
            for (key, held) in entries {
                match (key.as_str(), held) {
                    ("documentId", Value::String(id)) => out.push(id.clone()),
                    _ => ids_in(held, out),
                }
            }
        }
        Value::Seq(items) => items.iter().for_each(|item| ids_in(item, out)),
        _ => {}
    }
}

/// The fixed head every draw starts with: removed, removed, kept, removed.
#[cfg(test)]
const HEAD: [bool; 4] = [false, false, true, false];

#[test]
fn what_removed_since_exports_brings_back_exactly_the_removed_documents() {
    let riding = Floor::new("a removed document riding a removed ancestor");
    let cut = Floor::new("a survivor cut from a removed ancestor's bytes");
    let tail = prop::collection::vec(prop::bool::ANY, 0..5);
    check(tail, None, |tail| {
        let kept: Vec<bool> = HEAD.iter().copied().chain(tail).collect();
        let built = chain(kept.len());
        let since = built.oplog_vv();
        let moves = kept.iter().enumerate().filter(|(_, keep)| **keep);
        let deletes = kept.iter().enumerate().filter(|(_, keep)| !**keep);
        let batch: Vec<Write> = moves
            .map(|(i, _)| by_id(WriterName::MoveWorkspaceDocument, i, Vec::new()))
            .chain(deletes.map(|(i, _)| by_id(WriterName::DeleteWorkspaceDocument, i, Vec::new())))
            .collect();
        let after = applied(&built, &batch);
        let now = live_ids(&after);
        let mut gone: Vec<String> =
            live_ids(&built).into_iter().filter(|each| !now.contains(each)).collect();
        let removed = documents_removed_since(&after, &since).expect("answered");
        let mut brought: Vec<String> = Vec::new();
        for entry in &removed {
            ids_in(&entry.state, &mut brought);
        }
        riding.draw(removed.len() < gone.len());
        cut.draw(removed.iter().any(|entry| {
            let mut held = Vec::new();
            ids_in(&entry.state, &mut held);
            entry.document_id == id(0) && held.contains(&id(1)) && !held.contains(&id(2))
        }));
        brought.sort();
        gone.sort();
        prop_assert_eq!(&brought, &gone);
        prop_assert!(removed.iter().all(|entry| gone.contains(&entry.document_id)));
        Ok(())
    });
    riding.assert(200);
    cut.assert(200);
}

/// The writes that leave every document where it is, by kind of write.
#[cfg(test)]
fn content_write(i: usize, rename: bool) -> Write {
    if rename {
        by_id(WriterName::SetWorkspaceDocumentName, i, vec![("name", text("Renamed"))])
    } else {
        let patch = map(vec![("updatedAt", Value::Number(9.0))]);
        by_id(WriterName::UpdateWorkspaceDocumentMeta, i, vec![("patch", patch)])
    }
}

/// A write that places a document, by kind of write.
#[cfg(test)]
fn placing_write(i: usize, kind: usize) -> Write {
    match kind {
        0 => by_id(WriterName::DeleteWorkspaceDocument, i, Vec::new()),
        1 => by_id(WriterName::MoveWorkspaceDocument, i, Vec::new()),
        2 => by_id(WriterName::SetWorkspacePinned, i, vec![("pinned", Value::Bool(true))]),
        _ => {
            let patch = map(vec![("kind", text("spatial"))]);
            by_id(WriterName::UpdateWorkspaceDocumentMeta, i, vec![("patch", patch)])
        }
    }
}

#[test]
fn only_a_placing_write_reorganises_the_record() {
    const LEVELS: usize = 4;
    let floor = Floor::new("a content batch and the same with a placing write");
    let steps = prop::collection::vec((0..LEVELS, prop::bool::ANY), 1..6);
    let draw = (steps, 1..LEVELS, 0..4_usize);
    check(draw.boxed(), None, |(steps, placed, kind)| {
        let built = chain(LEVELS);
        let since: VersionVector = built.oplog_vv();
        let keys = whiteboard_crdt::NodeKeys {
            meta: &[
                "documentId",
                "segment",
                "kind",
                "name",
                "nameChosen",
                "createdAt",
                "updatedAt",
            ],
            placement: &["documentId", "segment", "kind"],
        };
        let mut batch: Vec<Write> =
            steps.iter().map(|&(i, rename)| content_write(i, rename)).collect();
        let quiet = applied(&built, &batch);
        let answer = organisation_changed_since(&quiet, "tree", &since, &keys);
        prop_assert_eq!(answer, Some(false));
        batch.push(placing_write(placed, kind));
        let moved = applied(&built, &batch);
        prop_assert_eq!(organisation_changed_since(&moved, "tree", &since, &keys), Some(true));
        floor.draw(true);
        Ok(())
    });
    floor.assert(200);
}
