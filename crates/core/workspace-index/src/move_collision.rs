//! What a move would land on.

use crate::document_path::{parent_of_path, rebase_path};
use crate::index_rules::{Node, NodeKind};
use std::collections::{BTreeMap, BTreeSet};

/// How many nodes sit strictly below a path, and how many of those the move frees.
#[derive(Debug, Clone, Copy, Default)]
struct Below {
    all: usize,
    moving: usize,
}

/// The counts per path, filed by depth so they can climb one level at a time.
#[derive(Default)]
struct Tally {
    below: BTreeMap<String, Below>,
    by_depth: Vec<Vec<String>>,
}

impl Tally {
    fn enter(&mut self, path: &str) -> &mut Below {
        if !self.below.contains_key(path) {
            let depth = path.matches('/').count();
            while self.by_depth.len() <= depth {
                self.by_depth.push(Vec::new());
            }
            if let Some(level) = self.by_depth.get_mut(depth) {
                level.push(path.to_owned());
            }
            self.below.insert(path.to_owned(), Below::default());
        }
        self.below.entry(path.to_owned()).or_default()
    }
}

/// Every path the move frees: the moving nodes' own, and every FOLDER the
/// move empties (something is below it and all of it is leaving). Counted in
/// one pass up from the deepest paths, where "below" is the path's string
/// sense — a `/` in front — so the counts climb through every such prefix,
/// held by a node or not.
fn vacated_paths(nodes: &[Node], moving: &[Node]) -> BTreeSet<String> {
    let moving_paths: BTreeSet<&str> = moving.iter().map(|node| node.path.as_str()).collect();
    let mut tally = Tally::default();
    let mut own: BTreeMap<&str, Below> = BTreeMap::new();
    for node in nodes {
        let mine = own.entry(node.path.as_str()).or_default();
        mine.all = mine.all.saturating_add(1);
        if moving_paths.contains(node.path.as_str()) {
            mine.moving = mine.moving.saturating_add(1);
        }
        tally.enter(&node.path);
    }
    for depth in (1..tally.by_depth.len()).rev() {
        let level = tally.by_depth.get(depth).cloned().unwrap_or_default();
        for path in level {
            let this = tally.below.get(&path).copied().unwrap_or_default();
            let held = own.get(path.as_str()).copied().unwrap_or_default();
            let into = tally.enter(parent_of_path(&path));
            into.all = into.all.saturating_add(this.all).saturating_add(held.all);
            into.moving = into.moving.saturating_add(this.moving).saturating_add(held.moving);
        }
    }
    let mut vacated: BTreeSet<String> = moving_paths.iter().map(|&path| path.to_owned()).collect();
    for node in nodes.iter().filter(|node| node.kind == NodeKind::Folder) {
        let under = tally.below.get(&node.path).copied().unwrap_or_default();
        if under.all > 0 && under.all == under.moving {
            vacated.insert(node.path.clone());
        }
    }
    vacated
}

/// The produced path to refuse the move over, or `None` when it is free.
///
/// Every collision is collected before one is named: the first found is often
/// a folder the destination merely passes through, and a document collision is
/// the real conflict, so it wins the report; a folder-only collision still
/// refuses but is named only when nothing better exists. A path the move is
/// itself emptying is free.
#[must_use]
pub fn move_collision(nodes: &[Node], moving: &[Node], from: &str, to: &str) -> Option<String> {
    let vacated = vacated_paths(nodes, moving);
    // The first node in listing order at each path, as a scan would find it.
    let mut occupants: BTreeMap<&str, NodeKind> = BTreeMap::new();
    for node in nodes {
        occupants.entry(node.path.as_str()).or_insert(node.kind);
    }
    let collisions: Vec<(String, bool)> = moving
        .iter()
        .map(|node| rebase_path(&node.path, from, to))
        .filter(|produced| !vacated.contains(produced))
        .filter_map(|produced| {
            let kind = occupants.get(produced.as_str()).copied()?;
            Some((produced, kind == NodeKind::Folder))
        })
        .collect();
    collisions
        .iter()
        .find(|(_, with_folder)| !with_folder)
        .or_else(|| collisions.first())
        .map(|(produced, _)| produced.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn folder(path: &str) -> Node {
        Node { kind: NodeKind::Folder, path: path.to_owned(), name: None, document_id: None }
    }

    fn document(path: &str) -> Node {
        Node { kind: NodeKind::Document, path: path.to_owned(), name: None, document_id: None }
    }

    #[test]
    fn a_folder_the_move_empties_is_free() {
        let nodes = [folder("a"), document("a/b")];
        let moving = [document("a/b")];
        assert_eq!(move_collision(&nodes, &moving, "a/b", "a"), None);
    }

    #[test]
    fn a_document_collision_is_named_over_a_folder_one() {
        let nodes = [folder("c"), document("c/d"), folder("a"), document("a/d")];
        let moving = [folder("a"), document("a/d")];
        assert_eq!(move_collision(&nodes, &moving, "a", "c").as_deref(), Some("c/d"));
    }
}
