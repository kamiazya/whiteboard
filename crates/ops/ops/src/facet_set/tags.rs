//! A tag change as a stored set takes it, and what a workspace's tag library
//! holds against the set a write would leave.

use std::collections::{BTreeMap, BTreeSet};

use whiteboard_model::Value;
use whiteboard_model::tags::parse_scoped_tag;

use crate::content::field;

/// The most tags one document, board, node or edge may carry when they are
/// written; a set stored larger before the bound still takes a change that
/// does not grow it.
pub(super) const TAGS_PER_ELEMENT_MAX: usize = 1024;

/// What a caller asked of tags: the errand's shape (add these, drop those,
/// rename these), not the storage's.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TagChange {
    pub add: Vec<String>,
    pub remove: Vec<String>,
    /// `from` to `to`, in the order asked.
    pub rename: Vec<(String, String)>,
}

/// A change in the form applying it reads, built once per call: it is
/// applied to every node and edge a rename reaches, twice (the dry run and
/// the write), so a lookup rebuilt per element would cost elements times
/// renames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TagEdit {
    add: Vec<String>,
    remove: BTreeSet<String>,
    rename_to: BTreeMap<String, String>,
}

impl TagEdit {
    pub(super) fn of(change: &TagChange) -> Self {
        let mut rename_to = BTreeMap::new();
        for (from, to) in &change.rename {
            // Of two renames of one tag the first wins.
            rename_to.entry(from.clone()).or_insert_with(|| to.clone());
        }
        Self { add: change.add.clone(), remove: change.remove.iter().cloned().collect(), rename_to }
    }

    pub(super) fn has_adds(&self) -> bool {
        !self.add.is_empty()
    }

    pub(super) fn renames_any(&self) -> bool {
        !self.rename_to.is_empty()
    }

    /// Whether a rename changes this tag set: only an element that carries a
    /// renamed tag is one the rename touches.
    pub(super) fn reaches(&self, tags: Option<&[String]>) -> bool {
        tags.is_some_and(|tags| tags.iter().any(|tag| self.rename_to.contains_key(tag)))
    }

    /// The rename half alone, which is what reaches every node and edge, or
    /// none when nothing is renamed.
    pub(super) fn renames_only(&self) -> Option<Self> {
        self.renames_any().then(|| Self {
            add: Vec::new(),
            remove: BTreeSet::new(),
            rename_to: self.rename_to.clone(),
        })
    }

    /// The change applied to a stored set: rename first, then remove, then
    /// add, so a rename onto a tag already present merges (one copy survives)
    /// and a removal names the new spelling; a tag added twice is one.
    pub(super) fn apply(&self, current: Option<&[String]>) -> Vec<String> {
        let mut seen = BTreeSet::new();
        let mut kept = Vec::new();
        let mut keep_first = |tag: &String| {
            if seen.insert(tag.clone()) {
                kept.push(tag.clone());
            }
        };
        for tag in current.unwrap_or_default() {
            let renamed = self.rename_to.get(tag).unwrap_or(tag);
            if !self.remove.contains(renamed) {
                keep_first(renamed);
            }
        }
        self.add.iter().for_each(keep_first);
        kept
    }
}

/// The tags a stored value holds, or none for any other shape.
pub(super) fn tags_of(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(Value::Seq(items)) = value else { return None };
    items
        .iter()
        .map(|item| match item {
            Value::String(tag) => Some(tag.clone()),
            _ => None,
        })
        .collect()
}

/// Why the library refuses a tag set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Objection {
    /// A value the key does not admit, with the values it does, sorted.
    Undeclared { tag: String, key: String, admitted: Vec<String> },
    /// Two values or more under a key declared one at a time.
    Exclusive { key: String, carried: Vec<String> },
}

/// What a library holds against the WHOLE set a thing would carry: a value a
/// key does not admit, then two values under an exclusive key. A plain tag
/// and an undeclared key pass, since a rule nobody declared refuses nothing.
pub(super) fn objection(library: &[(String, Value)], tags: &[String]) -> Option<Objection> {
    let mut under: Vec<(&str, Vec<String>)> = Vec::new();
    for tag in tags {
        let Some((key, value)) = parse_scoped_tag(tag) else { continue };
        let Some((_, declared)) = library.iter().find(|(name, _)| name == key) else { continue };
        if let Some(Value::Map(values)) = field(declared, "values")
            && !values.iter().any(|(name, _)| name == value)
        {
            let mut admitted: Vec<String> = values.iter().map(|(name, _)| name.clone()).collect();
            admitted.sort();
            return Some(Objection::Undeclared { tag: tag.clone(), key: key.to_owned(), admitted });
        }
        match under.iter_mut().find(|(held, _)| *held == key) {
            Some((_, carried)) => carried.push(tag.clone()),
            None => under.push((key, vec![tag.clone()])),
        }
    }
    under.into_iter().find_map(|(key, carried)| {
        let exclusive = library
            .iter()
            .find(|(name, _)| name == key)
            .is_some_and(|(_, declared)| field(declared, "exclusive") == Some(&Value::Bool(true)));
        (exclusive && carried.len() > 1)
            .then(|| Objection::Exclusive { key: key.to_owned(), carried })
    })
}

#[cfg(test)]
mod tests;
