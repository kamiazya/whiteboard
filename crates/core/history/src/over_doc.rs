//! The compaction cut over a document's op log: frontiers in, frontiers out.
//!
//! A frontier is a point in the op log; only the document can say which ops
//! lie in its past. This turns each point and the shallow root into a
//! [`VersionVector`], takes the cut over those, and names it again as the
//! frontiers that stand for it.

use crate::compaction_cut::compaction_cut;
use crate::version_vector::VersionVector;
use whiteboard_crdt::{LoroDoc, frontiers_version, shallow_root_version, version_frontiers};

/// The frontiers of the version every point descends from, or `None` when
/// there is no cut worth taking, or when a point names an op this document
/// does not hold (a version it cannot restore is no point to cut at).
pub fn compaction_cut_over_doc(
    doc: &LoroDoc,
    points: &[Vec<(String, i64)>],
) -> Option<Vec<(String, i64)>> {
    let versions: Option<Vec<VersionVector>> = points
        .iter()
        .map(|point| frontiers_version(doc, point).map(VersionVector::from_entries))
        .collect();
    let root = VersionVector::from_entries(shallow_root_version(doc));
    let cut = compaction_cut(&versions?, &root)?;
    let spelled: Vec<(String, u64)> =
        cut.iter().map(|(peer, seen)| (peer.to_owned(), seen)).collect();
    version_frontiers(doc, &spelled)
}

#[cfg(test)]
mod tests {
    use super::compaction_cut_over_doc;
    use whiteboard_crdt::{ExportMode, LoroDoc};

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn at(entries: &[(&str, i64)]) -> Vec<(String, i64)> {
        entries.iter().map(|(peer, counter)| ((*peer).to_owned(), *counter)).collect()
    }

    /// Peer 1 writes ops 0..=3; peer 2 then writes ops 0..=1 after seeing them.
    fn two_peers() -> LoroDoc {
        let one = LoroDoc::new();
        one.set_peer_id(1).expect("a peer");
        let list = one.get_list("l");
        for n in 0..4 {
            list.push(n).expect("a push");
        }
        one.commit();
        let two = LoroDoc::new();
        two.set_peer_id(2).expect("a peer");
        two.import(&one.export(ExportMode::Snapshot).expect("a snapshot")).expect("import");
        let list = two.get_list("l");
        for n in 4..6 {
            list.push(n).expect("a push");
        }
        two.commit();
        two
    }

    #[test]
    fn it_is_the_frontiers_of_what_every_point_has_seen() {
        let doc = two_peers();
        let cut = compaction_cut_over_doc(&doc, &[at(&[("2", 1)]), at(&[("1", 1)])]);
        assert_eq!(cut, Some(at(&[("1", 1)])));
    }

    #[test]
    fn a_lone_point_is_its_own_cut() {
        let doc = two_peers();
        assert_eq!(compaction_cut_over_doc(&doc, &[at(&[("2", 1)])]), Some(at(&[("2", 1)])));
    }

    #[test]
    fn it_is_no_cut_for_no_points_or_for_a_point_that_has_seen_nothing() {
        let doc = two_peers();
        assert_eq!(compaction_cut_over_doc(&doc, &[]), None);
        assert_eq!(compaction_cut_over_doc(&doc, &[at(&[])]), None);
    }

    #[test]
    fn it_is_no_cut_when_a_point_names_an_op_the_document_does_not_hold() {
        let doc = two_peers();
        assert_eq!(compaction_cut_over_doc(&doc, &[at(&[("1", 1)]), at(&[("9", 0)])]), None);
        assert_eq!(compaction_cut_over_doc(&doc, &[at(&[("peer", 0)])]), None);
    }

    #[test]
    fn it_is_no_cut_before_the_shallow_root_and_the_root_itself_at_it() {
        let doc = LoroDoc::new();
        doc.set_peer_id(1).expect("a peer");
        let list = doc.get_list("l");
        for n in 0..2 {
            list.push(n).expect("a push");
        }
        doc.commit();
        let root = doc.oplog_frontiers();
        for n in 2..4 {
            list.push(n).expect("a push");
        }
        doc.commit();
        let shallow = LoroDoc::new();
        shallow
            .import(&doc.export(ExportMode::shallow_snapshot(&root)).expect("a shallow snapshot"))
            .expect("import");
        assert_eq!(compaction_cut_over_doc(&shallow, &[at(&[("1", 0)])]), None);
        assert_eq!(compaction_cut_over_doc(&shallow, &[at(&[("1", 1)])]), Some(at(&[("1", 1)])));
        assert_eq!(compaction_cut_over_doc(&shallow, &[at(&[("1", 3)])]), Some(at(&[("1", 3)])));
    }
}
