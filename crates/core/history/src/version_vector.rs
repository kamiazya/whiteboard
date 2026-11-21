//! A version as plain data: per peer, how many of its ops have been seen.
//!
//! A history judgement needs only this much of a document's causal state, so
//! it takes the values and not an engine handle. A peer absent from a vector
//! has had none of its ops seen, the same as a counter of 0. Peers keep the
//! order they were first given in, as a JavaScript `Map` does, because the
//! order of a cut's entries is observable to a caller.

/// Per peer, how many ops have been seen, in the order peers were first set.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VersionVector(Vec<(String, u64)>);

impl VersionVector {
    /// The vector that has seen nothing.
    pub fn new() -> Self {
        Self::default()
    }

    /// A vector over `entries`; a peer given twice keeps its first position
    /// and its last counter, as `Map.set` does.
    pub fn from_entries<P: Into<String>>(entries: impl IntoIterator<Item = (P, u64)>) -> Self {
        let mut vector = Self::new();
        for (peer, seen) in entries {
            vector.set(peer.into(), seen);
        }
        vector
    }

    fn set(&mut self, peer: String, seen: u64) {
        match self.0.iter_mut().find(|(held, _)| *held == peer) {
            Some(entry) => entry.1 = seen,
            None => self.0.push((peer, seen)),
        }
    }

    /// How many of `peer`'s ops have been seen; 0 for a peer never named.
    pub fn get(&self, peer: &str) -> u64 {
        self.0.iter().find(|(held, _)| held == peer).map_or(0, |entry| entry.1)
    }

    /// The entries in the order their peers were first set.
    pub fn iter(&self) -> impl Iterator<Item = (&str, u64)> {
        self.0.iter().map(|(peer, seen)| (peer.as_str(), *seen))
    }

    /// Whether no peer is named, counters of 0 included.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// How one version stands to another in the causal order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionOrder {
    Before,
    Equal,
    After,
    Concurrent,
}

/// How `a` stands to `b` in the causal order.
pub fn compare_versions(a: &VersionVector, b: &VersionVector) -> VersionOrder {
    // Ahead needs an op `a` has seen, so the peer is one `a` names; behind
    // needs an op `b` has seen, so it is one `b` names. Each side is walked
    // for the one verdict it can give.
    let ahead = a.iter().any(|(peer, left)| left > b.get(peer));
    let behind = b.iter().any(|(peer, right)| a.get(peer) < right);
    match (behind, ahead) {
        (true, true) => VersionOrder::Concurrent,
        (true, false) => VersionOrder::Before,
        (false, true) => VersionOrder::After,
        (false, false) => VersionOrder::Equal,
    }
}

/// The latest version no later than both: per peer, the fewest ops either has
/// seen, in `a`'s order. A version is downward-closed in the causal order, so
/// the meet of two is too.
pub fn intersect_versions(a: &VersionVector, b: &VersionVector) -> VersionVector {
    VersionVector::from_entries(a.iter().filter_map(|(peer, left)| {
        let seen = left.min(b.get(peer));
        (seen > 0).then(|| (peer.to_owned(), seen))
    }))
}

#[cfg(test)]
mod tests {
    use super::{VersionOrder, VersionVector, compare_versions, intersect_versions};

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn at(pairs: &[(&str, u64)]) -> VersionVector {
        VersionVector::from_entries(pairs.iter().copied())
    }

    fn entries(vector: &VersionVector) -> Vec<(&str, u64)> {
        vector.iter().collect()
    }

    #[test]
    fn a_peer_given_twice_keeps_its_first_place_and_its_last_counter() {
        let vector = at(&[("2", 1), ("1", 5), ("2", 7)]);
        assert_eq!(entries(&vector), [("2", 7), ("1", 5)]);
        assert_eq!(vector.get("2"), 7);
        assert_eq!(vector.get("3"), 0);
        assert!(!vector.is_empty());
        assert!(VersionVector::new().is_empty());
    }

    #[test]
    fn it_orders_by_every_peer_reading_a_missing_peer_as_nothing_seen() {
        let none = at(&[]);
        let one = at(&[("1", 2)]);
        let both = at(&[("1", 2), ("2", 1)]);
        assert_eq!(compare_versions(&one, &one), VersionOrder::Equal);
        assert_eq!(compare_versions(&none, &one), VersionOrder::Before);
        assert_eq!(compare_versions(&one, &none), VersionOrder::After);
        assert_eq!(compare_versions(&both, &one), VersionOrder::After);
        assert_eq!(compare_versions(&one, &both), VersionOrder::Before);
        assert_eq!(compare_versions(&one, &at(&[("2", 1)])), VersionOrder::Concurrent);
        assert_eq!(compare_versions(&at(&[("1", 0)]), &none), VersionOrder::Equal);
    }

    #[test]
    fn a_peer_only_one_side_names_counts_on_both_sides_of_the_comparison() {
        let a = at(&[("1", 1), ("2", 1)]);
        let b = at(&[("1", 2)]);
        assert_eq!(compare_versions(&a, &b), VersionOrder::Concurrent);
        assert_eq!(compare_versions(&b, &a), VersionOrder::Concurrent);
        // Ahead on a peer both name, behind on one only the other names.
        let c = at(&[("1", 3)]);
        let d = at(&[("1", 1), ("2", 1)]);
        assert_eq!(compare_versions(&c, &d), VersionOrder::Concurrent);
        assert_eq!(compare_versions(&d, &c), VersionOrder::Concurrent);
    }

    /// Every vector over three peers and counters 0..=2, in a fixed spelling.
    fn domain() -> Vec<VersionVector> {
        let mut all = Vec::new();
        for x in 0..=2u64 {
            for y in 0..=2u64 {
                for z in 0..=2u64 {
                    all.push(at(&[("1", x), ("2", y), ("3", z)]));
                    all.push(at(&[("3", z), ("1", x)]));
                }
            }
        }
        all
    }

    fn opposite(order: VersionOrder) -> VersionOrder {
        match order {
            VersionOrder::Before => VersionOrder::After,
            VersionOrder::After => VersionOrder::Before,
            other => other,
        }
    }

    fn no_later(order: VersionOrder) -> bool {
        matches!(order, VersionOrder::Before | VersionOrder::Equal)
    }

    #[test]
    fn the_order_is_the_opposite_when_the_arguments_swap_and_reaches_all_four() {
        let mut seen = Vec::new();
        for a in domain() {
            for b in domain() {
                let order = compare_versions(&a, &b);
                assert_eq!(compare_versions(&b, &a), opposite(order));
                if !seen.contains(&order) {
                    seen.push(order);
                }
            }
        }
        assert_eq!(seen.len(), 4);
    }

    #[test]
    fn it_keeps_per_peer_the_fewest_ops_either_has_seen_and_drops_a_peer_only_one_has() {
        let a = at(&[("1", 5), ("2", 3)]);
        let b = at(&[("1", 2), ("3", 9)]);
        assert_eq!(entries(&intersect_versions(&a, &b)), [("1", 2)]);
        assert_eq!(entries(&intersect_versions(&b, &a)), [("1", 2)]);
    }

    #[test]
    fn it_keeps_the_first_vectors_order_and_drops_peers_at_zero() {
        let a = at(&[("2", 4), ("1", 4), ("3", 0)]);
        let b = at(&[("1", 6), ("2", 5), ("3", 9)]);
        assert_eq!(entries(&intersect_versions(&a, &b)), [("2", 4), ("1", 4)]);
    }

    #[test]
    fn the_meet_is_commutative_idempotent_and_the_latest_version_no_later_than_both() {
        let all = domain();
        for a in &all {
            assert_eq!(compare_versions(&intersect_versions(a, a), a), VersionOrder::Equal);
            for b in &all {
                let meet = intersect_versions(a, b);
                assert_eq!(compare_versions(&meet, &intersect_versions(b, a)), VersionOrder::Equal);
                assert!(no_later(compare_versions(&meet, a)));
                assert!(no_later(compare_versions(&meet, b)));
                for c in &all {
                    if no_later(compare_versions(c, a)) && no_later(compare_versions(c, b)) {
                        assert!(no_later(compare_versions(c, &meet)));
                    }
                }
            }
        }
    }
}
