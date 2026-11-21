//! Where a keeper may cut the workspace record's history.
//!
//! A shallow snapshot keeps the ops AFTER its root, so a version stays
//! restorable only when the root is in that version's past. The cut is
//! therefore chosen by causality, never by a version's date: a date is a claim
//! a carried row makes, and the row dated earliest can stand anywhere in the
//! history.
//!
//! The cut is the intersection of every version's version vector, which lies
//! in every version's past. Over plain vectors: turning a frontier into one
//! needs the op log, so the keeper that holds it converts the points and the
//! root in, and the cut back out.

use crate::version_vector::{VersionOrder, VersionVector, compare_versions, intersect_versions};

/// The version every point descends from, or `None` when there is no cut
/// worth taking: no points, no op every point has seen, or a cut that would
/// fall before the record's existing shallow root (`root`, the version of that
/// root itself, which the record cannot check out anything earlier than).
pub fn compaction_cut(points: &[VersionVector], root: &VersionVector) -> Option<VersionVector> {
    let (first, rest) = points.split_first()?;
    // Meeting `first` with itself drops zero counters, as every other meet
    // does: a lone point is otherwise returned as spelled, and `{peer: 0}` is
    // not empty.
    let common = rest
        .iter()
        .fold(intersect_versions(first, first), |meet, point| intersect_versions(&meet, point));
    if common.is_empty() {
        return None;
    }
    match compare_versions(&common, root) {
        VersionOrder::Before | VersionOrder::Concurrent => None,
        VersionOrder::Equal | VersionOrder::After => Some(common),
    }
}

#[cfg(test)]
mod tests {
    use super::compaction_cut;
    use crate::version_vector::VersionVector;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn at(pairs: &[(&str, u64)]) -> VersionVector {
        VersionVector::from_entries(pairs.iter().copied())
    }

    #[test]
    fn it_is_the_per_peer_fewest_ops_any_point_has_seen() {
        let cut = compaction_cut(
            &[at(&[("1", 5), ("2", 3)]), at(&[("1", 2), ("2", 9)])],
            &VersionVector::new(),
        );
        assert_eq!(cut, Some(at(&[("1", 2), ("2", 3)])));
    }

    #[test]
    fn it_meets_every_point_not_only_the_first_two() {
        let cut = compaction_cut(
            &[at(&[("1", 5)]), at(&[("1", 4)]), at(&[("1", 2)])],
            &VersionVector::new(),
        );
        assert_eq!(cut, Some(at(&[("1", 2)])));
    }

    #[test]
    fn it_is_no_cut_for_no_points_or_for_points_that_share_no_op() {
        let none = VersionVector::new();
        assert_eq!(compaction_cut(&[], &none), None);
        assert_eq!(compaction_cut(&[at(&[("1", 2)]), at(&[("2", 2)])], &none), None);
    }

    #[test]
    fn it_is_the_root_itself_when_the_points_all_stand_at_it_and_no_cut_before_it() {
        let root = at(&[("1", 4)]);
        assert_eq!(compaction_cut(&[at(&[("1", 4)]), at(&[("1", 8)])], &root), Some(root.clone()));
        assert_eq!(compaction_cut(&[at(&[("1", 3)]), at(&[("1", 8)])], &root), None);
    }

    #[test]
    fn it_is_a_cut_after_the_root() {
        let root = at(&[("1", 2)]);
        assert_eq!(compaction_cut(&[at(&[("1", 5)])], &root), Some(at(&[("1", 5)])));
    }

    #[test]
    fn it_is_no_cut_concurrent_with_the_root_which_no_record_can_check_out() {
        assert_eq!(compaction_cut(&[at(&[("2", 3)])], &at(&[("1", 4)])), None);
    }

    #[test]
    fn it_is_no_cut_for_a_lone_point_that_has_seen_no_op_however_it_is_spelled() {
        let none = VersionVector::new();
        assert_eq!(compaction_cut(&[at(&[])], &none), None);
        assert_eq!(compaction_cut(&[at(&[("1", 0)])], &none), None);
    }

    #[test]
    fn it_is_a_lone_point_itself_when_it_has_seen_an_op() {
        assert_eq!(
            compaction_cut(&[at(&[("1", 3)])], &VersionVector::new()),
            Some(at(&[("1", 3)]))
        );
    }
}
