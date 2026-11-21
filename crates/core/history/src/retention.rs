//! Which automatic checkpoints a keeper may let go, decided over its rows.
//!
//! Pure passes: a keeper fetches the rows, asks, and deletes what it is told.
//!
//! A checkpoint is disposable in a way a manual save is not, and lineage is
//! not disposable at all: a restore records its merge point as an automatic
//! version, so without the exemption both ENDS of a restore are ordinary sweep
//! candidates — the merge itself, and the point it named. Losing either leaves
//! a history that once explained where a state came from and no longer can.

use std::collections::BTreeSet;

/// The most automatic checkpoints a document keeps, before the oldest go.
pub const MAX_AUTO_PER_DOCUMENT: usize = 50;

/// The most manual versions a document keeps: a CEILING a keeper refuses a
/// save past, not a cap it prunes to, because a manual save is a person's
/// save-point and is never retired. Four times the automatic cap.
pub const MAX_MANUAL_PER_DOCUMENT: usize = 4 * MAX_AUTO_PER_DOCUMENT;

/// The most restore merge points a document keeps. Lineage is never retired
/// by either retention pass, so past this ceiling a keeper records no further
/// merge point and the restore itself still lands.
pub const MAX_RESTORE_POINTS_PER_DOCUMENT: usize = 4 * MAX_AUTO_PER_DOCUMENT;

/// A row as lineage sees it: its id, and the version it restored, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageCandidate {
    pub id: String,
    /// The version this one restored, when it is a restore's merge point.
    pub restored_from: Option<String>,
}

/// A row as the sandwich pass sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandwichCandidate {
    pub row: LineageCandidate,
    pub auto: bool,
}

/// Whether a row is lineage, which neither pass may take: a restore's merge
/// point, or a point some merge names. `referenced` is every id some row of
/// the document names as `restored_from`.
fn is_lineage(row: &LineageCandidate, referenced: &BTreeSet<String>) -> bool {
    row.restored_from.is_some() || referenced.contains(&row.id)
}

/// The options a keeper saves a restore's merge point with: automatic, because
/// the system recorded it, and lineage, so neither pass may take it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestorePointOptions {
    pub auto: bool,
    pub restored_from: String,
}

pub fn restore_point_options(restored_from: &str) -> RestorePointOptions {
    RestorePointOptions { auto: true, restored_from: restored_from.to_owned() }
}

/// The automatic checkpoints past the cap that may be removed.
///
/// `autos_newest_first` is every automatic row of the document, newest first;
/// `referenced` is every id some row names as `restored_from`. Lineage outlives
/// the cap on both ends: a merge point is kept, and so is the point it named.
pub fn auto_versions_over_cap(
    autos_newest_first: &[LineageCandidate],
    referenced: &BTreeSet<String>,
    cap: usize,
) -> Vec<String> {
    autos_newest_first
        .iter()
        .skip(cap)
        .filter(|row| !is_lineage(row, referenced))
        .map(|row| row.id.clone())
        .collect()
}

/// The carried automatic checkpoints to remove so a document is back within
/// the cap after rows from another keeper arrive — taken from the carried rows
/// alone, oldest first. A carried row dated later than this keeper's own would
/// otherwise outrank them in the newest-first cap and evict every genuine
/// checkpoint, so room is made from what arrived, never from what was here.
/// Lineage is spared as in the cap pass.
pub fn carried_auto_versions_over_cap(
    autos_newest_first: &[LineageCandidate],
    carried: &BTreeSet<String>,
    referenced: &BTreeSet<String>,
    cap: usize,
) -> Vec<String> {
    let excess = autos_newest_first.len().saturating_sub(cap);
    let removable: Vec<&LineageCandidate> = autos_newest_first
        .iter()
        .filter(|row| carried.contains(&row.id) && !is_lineage(row, referenced))
        .collect();
    removable
        .iter()
        .skip(removable.len().saturating_sub(excess))
        .map(|row| row.id.clone())
        .collect()
}

/// The automatic checkpoints strictly BETWEEN a document's first and last
/// manual save — the sandwich a person's own saves already bracket, where an
/// automatic one adds a row and no information. Lineage is spared as in the
/// cap pass; `rows` being the whole document, the ids merges name are read
/// from them.
///
/// `rows` are every row of the document in the order they are kept (time, then
/// id). A document with fewer than two manual saves has no sandwich.
pub fn sandwiched_auto_version_ids(rows: &[SandwichCandidate]) -> Vec<String> {
    let mut manual = rows.iter().enumerate().filter(|(_, row)| !row.auto).map(|(i, _)| i);
    let Some(first) = manual.next() else { return Vec::new() };
    let last = manual.next_back().unwrap_or(first);
    let referenced: BTreeSet<String> =
        rows.iter().filter_map(|candidate| candidate.row.restored_from.clone()).collect();
    // The bracketing saves are manual, so the `auto` filter drops them and
    // the span can name both ends.
    rows.iter()
        .take(last)
        .skip(first)
        .filter(|candidate| candidate.auto && !is_lineage(&candidate.row, &referenced))
        .map(|candidate| candidate.row.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        LineageCandidate, MAX_AUTO_PER_DOCUMENT, MAX_MANUAL_PER_DOCUMENT,
        MAX_RESTORE_POINTS_PER_DOCUMENT, SandwichCandidate, auto_versions_over_cap,
        carried_auto_versions_over_cap, restore_point_options, sandwiched_auto_version_ids,
    };
    use std::collections::BTreeSet;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn row(id: &str, restored_from: Option<&str>) -> LineageCandidate {
        LineageCandidate { id: id.to_owned(), restored_from: restored_from.map(str::to_owned) }
    }

    fn autos(n: usize) -> Vec<LineageCandidate> {
        (0..n).map(|i| row(&format!("a{i}"), None)).collect()
    }

    fn set(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn the_ceilings_are_the_cap_and_four_times_it() {
        assert_eq!(MAX_AUTO_PER_DOCUMENT, 50);
        assert_eq!(MAX_MANUAL_PER_DOCUMENT, 200);
        assert_eq!(MAX_RESTORE_POINTS_PER_DOCUMENT, 200);
    }

    #[test]
    fn it_keeps_everything_at_or_under_the_cap() {
        assert!(auto_versions_over_cap(&autos(MAX_AUTO_PER_DOCUMENT), &set(&[]), 50).is_empty());
    }

    #[test]
    fn it_removes_the_oldest_past_the_cap_newest_first_being_kept() {
        assert_eq!(auto_versions_over_cap(&autos(52), &set(&[]), 50), ids(&["a50", "a51"]));
    }

    #[test]
    fn it_spares_lineage_on_both_ends_a_merge_point_and_the_point_it_named() {
        let mut rows = autos(3);
        rows.push(row("merge", Some("named")));
        rows.push(row("named", None));
        rows.push(row("plain", None));
        assert_eq!(auto_versions_over_cap(&rows, &set(&["named"]), 2), ids(&["a2", "plain"]));
    }

    fn sandwich(id: &str, auto: bool, restored_from: Option<&str>) -> SandwichCandidate {
        SandwichCandidate { row: row(id, restored_from), auto }
    }

    #[test]
    fn the_sandwich_removes_the_automatic_rows_strictly_between_the_first_and_last_manual_save() {
        let rows = [
            sandwich("a1", true, None),
            sandwich("m1", false, None),
            sandwich("a2", true, None),
            sandwich("a3", true, None),
            sandwich("m2", false, None),
            sandwich("a4", true, None),
        ];
        assert_eq!(sandwiched_auto_version_ids(&rows), ids(&["a2", "a3"]));
    }

    #[test]
    fn the_sandwich_never_removes_a_manual_save_that_sits_inside_it() {
        let rows = [
            sandwich("m1", false, None),
            sandwich("a1", true, None),
            sandwich("m2", false, None),
            sandwich("m3", false, None),
        ];
        assert_eq!(sandwiched_auto_version_ids(&rows), ids(&["a1"]));
    }

    #[test]
    fn a_document_with_fewer_than_two_manual_saves_has_no_sandwich() {
        let one = [sandwich("a1", true, None), sandwich("m1", false, None)];
        assert!(sandwiched_auto_version_ids(&one).is_empty());
        let none = [sandwich("a1", true, None), sandwich("a2", true, None)];
        assert!(sandwiched_auto_version_ids(&none).is_empty());
        assert!(sandwiched_auto_version_ids(&[]).is_empty());
    }

    #[test]
    fn the_sandwich_spares_lineage_on_both_ends() {
        let rows = [
            sandwich("m1", false, None),
            sandwich("named", true, None),
            sandwich("m2", false, None),
            sandwich("merge", true, Some("named")),
            sandwich("plain", true, None),
            sandwich("m3", false, None),
        ];
        assert_eq!(sandwiched_auto_version_ids(&rows), ids(&["plain"]));
    }

    #[test]
    fn a_restore_point_is_automatic_and_names_what_it_restored() {
        let options = restore_point_options("v-past");
        assert!(options.auto);
        assert_eq!(options.restored_from, "v-past");
    }

    #[test]
    fn carried_makes_room_from_the_oldest_carried_rows_however_new_against_the_own_ones() {
        let rows = [row("c2", None), row("c1", None), row("own2", None), row("own1", None)];
        assert_eq!(
            carried_auto_versions_over_cap(&rows, &set(&["c1", "c2"]), &set(&[]), 3),
            ids(&["c1"])
        );
    }

    #[test]
    fn carried_removes_no_own_row_even_when_the_carried_ones_cannot_make_up_the_excess() {
        let rows = [row("c1", None), row("own3", None), row("own2", None), row("own1", None)];
        assert_eq!(
            carried_auto_versions_over_cap(&rows, &set(&["c1"]), &set(&[]), 2),
            ids(&["c1"])
        );
    }

    #[test]
    fn carried_removes_nothing_within_the_cap_and_spares_carried_lineage() {
        assert!(
            carried_auto_versions_over_cap(&[row("c1", None)], &set(&["c1"]), &set(&[]), 1)
                .is_empty()
        );
        let rows = [row("c2", Some("own1")), row("c1", None), row("own1", None)];
        assert_eq!(
            carried_auto_versions_over_cap(&rows, &set(&["c1", "c2"]), &set(&["own1"]), 1),
            ids(&["c1"])
        );
    }

    #[test]
    fn carried_removes_as_many_as_the_excess_oldest_first() {
        let rows = [row("c3", None), row("c2", None), row("c1", None), row("own", None)];
        assert_eq!(
            carried_auto_versions_over_cap(&rows, &set(&["c1", "c2", "c3"]), &set(&[]), 2),
            ids(&["c2", "c1"])
        );
    }
}
