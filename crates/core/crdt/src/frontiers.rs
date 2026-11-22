//! Frontiers and version vectors as the plain pairs the oracle records, over
//! one document's op log: encoding a frontier, reading one back, and turning
//! one into the version it stands for and a version into the frontier that
//! names it.
//!
//! A pair is `(peer, counter)` with the peer a decimal string, as the
//! TypeScript records it: JSON has no 64-bit integer. Frontiers come back peer
//! descending, the order npm loro-crdt answers for every recorded frontier.

use loro::{Frontiers, ID, LoroDoc, VersionVector};

/// Why a pair did not name an op, or bytes did not decode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontiersError(pub String);

impl std::fmt::Display for FrontiersError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FrontiersError {}

fn op_id(peer: &str, counter: i64) -> Result<ID, FrontiersError> {
    let peer = peer.parse::<u64>().map_err(|_| FrontiersError(format!("peer `{peer}`")))?;
    let counter =
        i32::try_from(counter).map_err(|_| FrontiersError(format!("counter {counter}")))?;
    Ok(ID::new(peer, counter))
}

fn frontiers_of(pairs: &[(String, i64)]) -> Result<Frontiers, FrontiersError> {
    let ids: Result<Vec<ID>, FrontiersError> =
        pairs.iter().map(|(peer, counter)| op_id(peer, *counter)).collect();
    Ok(Frontiers::from(ids?))
}

/// Peer descending. A frontier of several peers is a hash map in loro, and
/// the order it iterates in follows the width of `usize`: the order the
/// recording holds is wasm32's, native's differs, and every recorded frontier
/// of more than one peer reads in descending peer order. The order is not a
/// fact of the document (`Frontiers::encode` sorts), so it is fixed here
/// instead of left to the host.
fn pairs_of(frontiers: &Frontiers) -> Vec<(String, i64)> {
    let mut ids: Vec<ID> = frontiers.iter().collect();
    ids.sort_by_key(|id| std::cmp::Reverse(id.peer));
    ids.into_iter().map(|id| (id.peer.to_string(), i64::from(id.counter))).collect()
}

/// The bytes loro encodes `pairs` as: the engine's frontiers, sorted.
pub fn encode_frontiers(pairs: &[(String, i64)]) -> Result<Vec<u8>, FrontiersError> {
    Ok(frontiers_of(pairs)?.encode())
}

/// The frontiers `bytes` encode, or loro's refusal of them.
pub fn decode_frontiers(bytes: &[u8]) -> Result<Vec<(String, i64)>, FrontiersError> {
    Frontiers::decode(bytes)
        .map(|frontiers| pairs_of(&frontiers))
        .map_err(|e| FrontiersError(e.to_string()))
}

fn version_of(vv: &VersionVector) -> Vec<(String, u64)> {
    let mut seen: Vec<(u64, u64)> =
        vv.iter().map(|(peer, counter)| (*peer, u64::from(counter.unsigned_abs()))).collect();
    seen.sort_by_key(|entry| *entry);
    seen.into_iter().map(|(peer, counter)| (peer.to_string(), counter)).collect()
}

/// The version `frontiers` stand for in `doc`'s op log: per peer, how many ops
/// it has seen, peers ascending. `None` when the pairs name no op of this
/// document, or are not an op id at all.
pub fn frontiers_version(doc: &LoroDoc, frontiers: &[(String, i64)]) -> Option<Vec<(String, u64)>> {
    let frontiers = frontiers_of(frontiers).ok()?;
    doc.frontiers_to_vv(&frontiers).as_ref().map(version_of)
}

/// The version of the root a shallow document starts from; empty for a
/// document that holds its whole history. A document always holds its own
/// root, so the version is never unreadable.
pub fn shallow_root_version(doc: &LoroDoc) -> Vec<(String, u64)> {
    doc.frontiers_to_vv(&doc.shallow_since_frontiers()).as_ref().map(version_of).unwrap_or_default()
}

/// The frontiers that name `version` in `doc`'s op log, peer descending, or
/// `None` when the version is not one a counter can spell.
pub fn version_frontiers(doc: &LoroDoc, version: &[(String, u64)]) -> Option<Vec<(String, i64)>> {
    let entries: Option<Vec<(u64, i32)>> = version
        .iter()
        .map(|(peer, seen)| Some((peer.parse().ok()?, i32::try_from(*seen).ok()?)))
        .collect();
    let vv: VersionVector = entries?.into_iter().collect();
    Some(pairs_of(&doc.vv_to_frontiers(&vv)))
}

#[cfg(test)]
mod tests {
    use super::{
        decode_frontiers, encode_frontiers, frontiers_version, shallow_root_version,
        version_frontiers,
    };
    use loro::LoroDoc;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn pairs(entries: &[(&str, i64)]) -> Vec<(String, i64)> {
        entries.iter().map(|(peer, counter)| ((*peer).to_owned(), *counter)).collect()
    }

    fn versions(entries: &[(&str, u64)]) -> Vec<(String, u64)> {
        entries.iter().map(|(peer, counter)| ((*peer).to_owned(), *counter)).collect()
    }

    /// Peer 1 writes three ops, then peer 2 writes two more after seeing them.
    fn two_peers() -> LoroDoc {
        let one = LoroDoc::new();
        one.set_peer_id(1).expect("a peer");
        let list = one.get_list("l");
        for n in 0..3 {
            list.push(n).expect("a push");
        }
        one.commit();
        let two = LoroDoc::new();
        two.set_peer_id(2).expect("a peer");
        two.import(&one.export(loro::ExportMode::Snapshot).expect("a snapshot")).expect("import");
        let list = two.get_list("l");
        for n in 3..5 {
            list.push(n).expect("a push");
        }
        two.commit();
        two
    }

    #[test]
    fn frontiers_encode_sorted_and_decode_peer_descending() {
        let bytes = encode_frontiers(&pairs(&[("1", 3), ("2", 9)])).expect("encodes");
        assert_eq!(bytes, encode_frontiers(&pairs(&[("2", 9), ("1", 3)])).expect("encodes"));
        assert_eq!(decode_frontiers(&bytes), Ok(pairs(&[("2", 9), ("1", 3)])));
        assert_eq!(decode_frontiers(&[0]), Ok(vec![]));
    }

    #[test]
    fn a_pair_that_is_not_an_op_id_does_not_encode() {
        assert!(encode_frontiers(&pairs(&[("peer", 1)])).is_err());
        assert!(encode_frontiers(&pairs(&[("1", 1 << 40)])).is_err());
        assert!(encode_frontiers(&pairs(&[("18446744073709551616", 1)])).is_err());
        assert!(encode_frontiers(&pairs(&[("18446744073709551615", 7)])).is_ok());
    }

    #[test]
    fn bytes_that_are_not_frontiers_do_not_decode() {
        let refusal = decode_frontiers(&[9, 1]).expect_err("a refusal");
        assert_eq!(refusal.to_string(), "Decode error: (Decode Frontiers error)");
    }

    #[test]
    fn a_frontier_stands_for_the_ops_in_its_past_peers_ascending() {
        let doc = two_peers();
        assert_eq!(
            frontiers_version(&doc, &pairs(&[("2", 1)])),
            Some(versions(&[("1", 3), ("2", 2)]))
        );
        assert_eq!(frontiers_version(&doc, &pairs(&[("1", 1)])), Some(versions(&[("1", 2)])));
        assert_eq!(frontiers_version(&doc, &[]), Some(vec![]));
    }

    #[test]
    fn a_frontier_the_document_does_not_hold_stands_for_nothing() {
        let doc = two_peers();
        assert_eq!(frontiers_version(&doc, &pairs(&[("9", 0)])), None);
        assert_eq!(frontiers_version(&doc, &pairs(&[("2", 2)])), None);
        assert_eq!(frontiers_version(&doc, &pairs(&[("x", 0)])), None);
    }

    #[test]
    fn a_whole_history_has_the_empty_root_and_a_shallow_one_its_own() {
        let doc = two_peers();
        assert_eq!(shallow_root_version(&doc), vec![]);
        let shallow = LoroDoc::new();
        let frontiers = doc.oplog_frontiers();
        shallow
            .import(&doc.export(loro::ExportMode::shallow_snapshot(&frontiers)).expect("export"))
            .expect("import");
        assert_eq!(shallow_root_version(&shallow), versions(&[("1", 3), ("2", 2)]));
    }

    #[test]
    fn a_version_is_named_by_the_frontiers_at_its_edge_peer_descending() {
        let doc = two_peers();
        assert_eq!(version_frontiers(&doc, &versions(&[("1", 2)])), Some(pairs(&[("1", 1)])));
        assert_eq!(
            version_frontiers(&doc, &versions(&[("1", 3), ("2", 2)])),
            Some(pairs(&[("2", 1)]))
        );
        assert_eq!(
            version_frontiers(&doc, &versions(&[("1", 1), ("2", 0)])),
            Some(pairs(&[("1", 0)]))
        );
        assert_eq!(version_frontiers(&doc, &[]), Some(vec![]));
    }

    #[test]
    fn a_version_a_counter_cannot_spell_names_no_frontiers() {
        let doc = two_peers();
        assert_eq!(version_frontiers(&doc, &versions(&[("1", 1 << 40)])), None);
        assert_eq!(version_frontiers(&doc, &versions(&[("peer", 1)])), None);
    }

    #[test]
    fn frontiers_of_several_peers_come_back_peer_descending() {
        let ids = pairs(&[("3", 1), ("1", 1), ("12", 5), ("2", 1)]);
        let bytes = encode_frontiers(&ids).expect("encodes");
        assert_eq!(decode_frontiers(&bytes), Ok(pairs(&[("12", 5), ("3", 1), ("2", 1), ("1", 1)])));
    }
}
