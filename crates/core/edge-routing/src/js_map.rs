//! A JavaScript `Map`'s semantics, which the TypeScript edge layer keys its
//! side choices, anchors and crowd counts by: iteration in FIRST-insertion
//! order, and a `set` of a present key replacing the value where it already
//! sits. A `BTreeMap` iterates in key order and a hash map in no order the
//! oracle shares, so neither can stand in for it.

use std::collections::BTreeMap;

/// An insertion-ordered map with `Map.prototype.set` semantics.
#[derive(Debug, Clone, PartialEq)]
pub struct JsMap<K: Ord + Copy, V> {
    index: BTreeMap<K, usize>,
    entries: Vec<(K, V)>,
}

impl<K: Ord + Copy, V> Default for JsMap<K, V> {
    fn default() -> Self {
        Self { index: BTreeMap::new(), entries: Vec::new() }
    }
}

impl<K: Ord + Copy, V> JsMap<K, V> {
    /// `map.set(key, value)`: a present key keeps its position.
    pub fn set(&mut self, key: K, value: V) {
        if let Some(slot) = self.index.get(&key).and_then(|&i| self.entries.get_mut(i)) {
            slot.1 = value;
            return;
        }
        self.index.insert(key, self.entries.len());
        self.entries.push((key, value));
    }

    /// `map.get(key)`.
    #[must_use]
    pub fn get(&self, key: &K) -> Option<&V> {
        self.index.get(key).and_then(|&i| self.entries.get(i)).map(|(_, v)| v)
    }

    /// `map.has(key)`.
    #[must_use]
    pub fn has(&self, key: &K) -> bool {
        self.index.contains_key(key)
    }

    /// `map.size`.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// `map.size === 0`.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The entries in iteration order, as `for (const [k, v] of map)`.
    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }
}

impl<K: Ord + Copy, V> FromIterator<(K, V)> for JsMap<K, V> {
    /// `new Map(entries)`: a repeated key keeps its first position and its
    /// last value.
    fn from_iter<I: IntoIterator<Item = (K, V)>>(entries: I) -> Self {
        let mut map = Self::default();
        for (k, v) in entries {
            map.set(k, v);
        }
        map
    }
}

#[cfg(test)]
mod tests {
    use super::JsMap;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_reset_key_keeps_its_first_position_and_takes_the_new_value() {
        let map: JsMap<u32, &str> = [(3, "a"), (1, "b"), (3, "c")].into_iter().collect();
        assert_eq!(map.iter().map(|(k, v)| (*k, *v)).collect::<Vec<_>>(), vec![(3, "c"), (1, "b")]);
        assert_eq!(map.get(&3), Some(&"c"));
        assert!(map.has(&1) && !map.has(&2));
        assert_eq!(map.len(), 2);
    }
}
