//! `cargo xtask arch-map`: the crates follow `crates/architecture-map.json`.
//!
//! The map declares the whole target graph, planned crates included, so the
//! direction of every edge is decided before the code that would add it. Two
//! halves are checked: the map against itself (layers, direction, acyclicity,
//! targets) and the workspace against the map (membership, internal and
//! third-party dependencies, inherited lints).

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

use crate::metadata::{self, Metadata};

pub(crate) const MAP_PATH: &str = "crates/architecture-map.json";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ArchMap {
    #[serde(rename = "$comment")]
    _comment: String,
    pub(crate) layers: BTreeMap<String, Layer>,
    pub(crate) crates: BTreeMap<String, CrateEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Layer {
    pub(crate) dirs: Vec<String>,
    pub(crate) may_depend_on: Vec<String>,
    pub(crate) description: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Status {
    Present,
    Planned,
}

#[derive(Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord, Clone, Copy)]
pub(crate) enum Target {
    #[serde(rename = "wasm32-unknown-unknown")]
    Wasm32,
    #[serde(rename = "native")]
    Native,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct CrateEntry {
    pub(crate) path: String,
    pub(crate) layer: String,
    pub(crate) status: Status,
    pub(crate) description: String,
    pub(crate) targets: Vec<Target>,
    pub(crate) allowed_internal_deps: Vec<String>,
    pub(crate) allowed_third_party: BTreeMap<String, String>,
    pub(crate) absorbs: Vec<String>,
}

/// One workspace member as the check needs to see it.
#[derive(Debug)]
pub(crate) struct Member {
    pub(crate) name: String,
    pub(crate) dir: String,
    /// `(dependency name, is a dev-dependency)`.
    pub(crate) deps: Vec<(String, bool)>,
    pub(crate) inherits_workspace_lints: bool,
    /// Whether `src/lib.rs` carries [`CORE_TOTALITY_LINTS`].
    pub(crate) declares_core_lints: bool,
}

/// The crate-level attribute every core crate carries. Cargo's `[lints]` is
/// all-or-nothing per crate, so a core-only lint cannot live in
/// `[workspace.lints]`; this check is what keeps the per-crate copy present.
pub(crate) const CORE_TOTALITY_LINTS: &str =
    "#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]";

pub(crate) fn load_map(metadata: &Metadata) -> Result<ArchMap, Vec<String>> {
    metadata::read_json(&metadata.workspace_root.join(MAP_PATH))
}

pub(crate) fn run() -> Result<Vec<String>, Vec<String>> {
    let metadata = metadata::load()?;
    let map = load_map(&metadata)?;
    let mut members = Vec::new();
    for package in metadata.members() {
        let manifest = std::fs::read_to_string(&package.manifest_path)
            .map_err(|e| vec![format!("cannot read {}: {e}", package.manifest_path.display())])?;
        members.push(Member {
            name: package.name.clone(),
            dir: metadata.relative_dir(package),
            deps: package.dependencies.iter().map(|d| (d.name.clone(), d.is_dev())).collect(),
            inherits_workspace_lints: inherits_workspace_lints(&manifest),
            declares_core_lints: package.manifest_path.parent().is_some_and(|dir| {
                std::fs::read_to_string(dir.join("src/lib.rs"))
                    .is_ok_and(|lib| lib.lines().any(|l| l.trim() == CORE_TOTALITY_LINTS))
            }),
        });
    }
    let mut violations = check_map(&map);
    violations.extend(check_members(&map, &members));
    if violations.is_empty() {
        let edges: usize = members.iter().map(|m| m.deps.len()).sum();
        Ok(vec![format!(
            "arch-map: {} members ({} dependency edges) follow {} declared crates",
            members.len(),
            edges,
            map.crates.len()
        )])
    } else {
        violations.insert(0, format!("arch-map: {MAP_PATH} is violated:"));
        Err(violations)
    }
}

/// `[lints]` followed by `workspace = true`, the only way a member inherits
/// `[workspace.lints]`; cargo metadata does not report it.
pub(crate) fn inherits_workspace_lints(manifest: &str) -> bool {
    let mut in_lints = false;
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            in_lints = line == "[lints]";
        } else if in_lints && line.replace(' ', "") == "workspace=true" {
            return true;
        }
    }
    false
}

/// The map against itself.
pub(crate) fn check_map(map: &ArchMap) -> Vec<String> {
    let mut v = Vec::new();
    for (name, layer) in &map.layers {
        if layer.description.trim().is_empty() {
            v.push(format!("layer {name} has no description"));
        }
        for allowed in &layer.may_depend_on {
            if !map.layers.contains_key(allowed) {
                v.push(format!("layer {name} may depend on unknown layer {allowed}"));
            }
        }
    }
    for (name, entry) in &map.crates {
        let Some(layer) = map.layers.get(&entry.layer) else {
            v.push(format!("{name}: unknown layer {}", entry.layer));
            continue;
        };
        if !layer
            .dirs
            .iter()
            .any(|dir| entry.path == *dir || entry.path.starts_with(&format!("{dir}/")))
        {
            v.push(format!(
                "{name}: path {} is outside its layer's directories {:?}",
                entry.path, layer.dirs
            ));
        }
        if entry.description.trim().is_empty() {
            v.push(format!("{name}: no description"));
        }
        if entry.targets.is_empty() {
            v.push(format!("{name}: declares no target"));
        }
        if entry.layer == "core"
            && !(entry.targets.contains(&Target::Wasm32) && entry.targets.contains(&Target::Native))
        {
            v.push(format!("{name}: a core crate must build for both wasm32 and native"));
        }
        for (dep, reason) in &entry.allowed_third_party {
            if reason.trim().is_empty() {
                v.push(format!("{name}: third-party {dep} is allowed without a reason"));
            }
        }
        for dep in &entry.allowed_internal_deps {
            check_declared_edge(map, name, entry, layer, dep, &mut v);
        }
    }
    // What a crate absorbs is where its differential oracle lives; two crates
    // claiming one TypeScript source would each be compared against it.
    let mut absorbed: BTreeMap<&str, &str> = BTreeMap::new();
    for (name, entry) in &map.crates {
        for source in &entry.absorbs {
            if let Some(other) = absorbed.insert(source.as_str(), name.as_str()) {
                v.push(format!("{source} is absorbed by both {other} and {name}"));
            }
        }
    }
    v.extend(cycles(map.crates.iter().map(|(name, entry)| {
        (name.as_str(), entry.allowed_internal_deps.iter().map(String::as_str).collect())
    })));
    v
}

fn check_declared_edge(
    map: &ArchMap,
    name: &str,
    entry: &CrateEntry,
    layer: &Layer,
    dep: &str,
    v: &mut Vec<String>,
) {
    if dep == name {
        v.push(format!("{name}: lists itself as a dependency"));
        return;
    }
    let Some(target) = map.crates.get(dep) else {
        v.push(format!("{name}: allowed dependency {dep} is not in the map"));
        return;
    };
    if !layer.may_depend_on.contains(&target.layer) {
        v.push(format!(
            "{name} ({}) may not depend on {dep} ({}): layer {} may depend only on {:?}",
            entry.layer, target.layer, entry.layer, layer.may_depend_on
        ));
    }
    for t in &entry.targets {
        if !target.targets.contains(t) {
            v.push(format!("{name} builds for {t:?} but its dependency {dep} does not"));
        }
    }
}

/// The workspace against the map.
pub(crate) fn check_members(map: &ArchMap, members: &[Member]) -> Vec<String> {
    let mut v = Vec::new();
    let member_names: BTreeSet<&str> = members.iter().map(|m| m.name.as_str()).collect();
    for member in members {
        let Some(entry) = map.crates.get(&member.name) else {
            v.push(format!("{}: a workspace member the map does not declare", member.name));
            continue;
        };
        if entry.status != Status::Present {
            v.push(format!("{}: exists but the map says planned", member.name));
        }
        if entry.path != member.dir {
            v.push(format!(
                "{}: lives at {} but the map says {}",
                member.name, member.dir, entry.path
            ));
        }
        if entry.layer == "core" && !member.declares_core_lints {
            v.push(format!("{}: src/lib.rs lacks {CORE_TOTALITY_LINTS}", member.name));
        }
        if !member.inherits_workspace_lints {
            v.push(format!("{}: does not inherit [workspace.lints]", member.name));
        }
        let mut used_third_party = BTreeSet::new();
        for (dep, dev) in &member.deps {
            if *dev {
                continue;
            }
            if member_names.contains(dep.as_str()) || map.crates.contains_key(dep) {
                if !entry.allowed_internal_deps.contains(dep) {
                    v.push(format!("{} -> {dep}: not in its allowedInternalDeps", member.name));
                }
            } else if entry.allowed_third_party.contains_key(dep) {
                used_third_party.insert(dep.as_str());
            } else {
                v.push(format!(
                    "{} -> {dep}: third-party dependency not in allowedThirdParty",
                    member.name
                ));
            }
        }
        for dep in entry.allowed_third_party.keys() {
            if !used_third_party.contains(dep.as_str()) {
                v.push(format!(
                    "{}: allowedThirdParty lists {dep}, which it no longer uses",
                    member.name
                ));
            }
        }
    }
    for (name, entry) in &map.crates {
        if entry.status == Status::Present && !member_names.contains(name.as_str()) {
            v.push(format!("{name}: the map says present but it is not a workspace member"));
        }
    }
    // Dev-dependencies are exempt from direction, never from cycles.
    v.extend(cycles(members.iter().map(|m| {
        (
            m.name.as_str(),
            m.deps.iter().map(|(d, _)| d.as_str()).filter(|d| member_names.contains(d)).collect(),
        )
    })));
    v
}

/// Every cycle in a graph, reported once by the node where the walk found it.
fn cycles<'a>(graph: impl Iterator<Item = (&'a str, Vec<&'a str>)>) -> Vec<String> {
    let graph: BTreeMap<&str, Vec<&str>> = graph.collect();
    let mut state: BTreeMap<&str, bool> = BTreeMap::new(); // false = on stack, true = done
    let mut found = Vec::new();
    for &start in graph.keys() {
        visit(&graph, start, &mut state, &mut Vec::new(), &mut found);
    }
    found
}

fn visit<'a>(
    graph: &BTreeMap<&'a str, Vec<&'a str>>,
    node: &'a str,
    state: &mut BTreeMap<&'a str, bool>,
    stack: &mut Vec<&'a str>,
    found: &mut Vec<String>,
) {
    match state.get(node) {
        Some(true) => return,
        Some(false) => {
            let from = stack.iter().position(|n| *n == node).unwrap_or(0);
            let mut cycle: Vec<&str> = stack.get(from..).unwrap_or_default().to_vec();
            cycle.push(node);
            found.push(format!("dependency cycle: {}", cycle.join(" -> ")));
            return;
        }
        None => {}
    }
    state.insert(node, false);
    stack.push(node);
    for &next in graph.get(node).map(Vec::as_slice).unwrap_or_default() {
        visit(graph, next, state, stack, found);
    }
    stack.pop();
    state.insert(node, true);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(json: &str) -> ArchMap {
        serde_json::from_str(json).unwrap()
    }

    const BASE: &str = r#"{
      "$comment": "test",
      "layers": {
        "core": { "dirs": ["crates/core"], "mayDependOn": ["core"], "description": "pure" },
        "mechanics": { "dirs": ["crates/mechanics"], "mayDependOn": ["core"], "description": "stores" },
        "adapters": { "dirs": ["crates/adapters"], "mayDependOn": ["core"], "description": "translate" }
      },
      "crates": {
        "a": { "path": "crates/core/a", "layer": "core", "status": "present", "description": "a",
               "targets": ["wasm32-unknown-unknown", "native"], "allowedInternalDeps": [],
               "allowedThirdParty": { "libm": "pinned math" }, "absorbs": [] },
        "b": { "path": "crates/core/b", "layer": "core", "status": "present", "description": "b",
               "targets": ["wasm32-unknown-unknown", "native"], "allowedInternalDeps": ["a"],
               "allowedThirdParty": {}, "absorbs": [] },
        "store": { "path": "crates/mechanics/store", "layer": "mechanics", "status": "planned",
               "description": "s", "targets": ["native"], "allowedInternalDeps": ["a"],
               "allowedThirdParty": {}, "absorbs": [] },
        "http": { "path": "crates/adapters/http", "layer": "adapters", "status": "planned",
               "description": "h", "targets": ["native"], "allowedInternalDeps": ["a"],
               "allowedThirdParty": {}, "absorbs": [] }
      }
    }"#;

    fn member(name: &str, dir: &str, deps: &[(&str, bool)]) -> Member {
        Member {
            name: name.to_owned(),
            dir: dir.to_owned(),
            deps: deps.iter().map(|(d, dev)| ((*d).to_owned(), *dev)).collect(),
            inherits_workspace_lints: true,
            declares_core_lints: true,
        }
    }

    fn healthy() -> Vec<Member> {
        vec![
            member("a", "crates/core/a", &[("libm", false)]),
            member("b", "crates/core/b", &[("a", false)]),
        ]
    }

    #[test]
    fn a_consistent_map_and_workspace_pass() {
        let m = map(BASE);
        assert_eq!(check_map(&m), Vec::<String>::new());
        assert_eq!(check_members(&m, &healthy()), Vec::<String>::new());
    }

    #[test]
    fn an_adapter_reaching_a_mechanic_is_refused_before_either_exists() {
        let m = map(&BASE.replace(
            r#""layer": "adapters", "status": "planned",
               "description": "h", "targets": ["native"], "allowedInternalDeps": ["a"]"#,
            r#""layer": "adapters", "status": "planned",
               "description": "h", "targets": ["native"], "allowedInternalDeps": ["a", "store"]"#,
        ));
        let v = check_map(&m);
        assert!(
            v.iter().any(|l| l.starts_with("http (adapters) may not depend on store")),
            "{v:?}"
        );
    }

    #[test]
    fn a_declared_cycle_is_refused() {
        let m = map(&BASE.replace(
            r#""targets": ["wasm32-unknown-unknown", "native"], "allowedInternalDeps": [],"#,
            r#""targets": ["wasm32-unknown-unknown", "native"], "allowedInternalDeps": ["b"],"#,
        ));
        assert!(check_map(&m).iter().any(|l| l.starts_with("dependency cycle:")));
    }

    #[test]
    fn a_core_crate_depending_on_a_native_only_crate_is_refused() {
        let m = map(&BASE.replace(
            r#""allowedInternalDeps": ["a"],
               "allowedThirdParty": {}, "absorbs": [] },
        "store""#,
            r#""allowedInternalDeps": ["a", "store"],
               "allowedThirdParty": {}, "absorbs": [] },
        "store""#,
        ));
        let v = check_map(&m);
        assert!(v.iter().any(|l| l.contains("b (core) may not depend on store")), "{v:?}");
        assert!(
            v.iter().any(|l| l.contains("builds for Wasm32 but its dependency store")),
            "{v:?}"
        );
    }

    #[test]
    fn an_undeclared_internal_edge_is_refused() {
        let mut members = healthy();
        members[0].deps.push(("b".to_owned(), false));
        let v = check_members(&map(BASE), &members);
        assert!(v.contains(&"a -> b: not in its allowedInternalDeps".to_owned()), "{v:?}");
        // The same edge also closes a cycle.
        assert!(v.iter().any(|l| l.starts_with("dependency cycle:")), "{v:?}");
    }

    #[test]
    fn a_dev_dependency_is_exempt_from_direction_but_not_from_cycles() {
        let mut members = healthy();
        members[0].deps.push(("b".to_owned(), true));
        let v = check_members(&map(BASE), &members);
        assert_eq!(v.len(), 1, "{v:?}");
        assert!(v[0].starts_with("dependency cycle:"));
    }

    #[test]
    fn third_party_is_checked_from_both_sides() {
        let mut members = healthy();
        members[1].deps.push(("tokio".to_owned(), false));
        members[0].deps.clear();
        let v = check_members(&map(BASE), &members);
        assert!(
            v.contains(&"b -> tokio: third-party dependency not in allowedThirdParty".to_owned())
        );
        assert!(v.contains(&"a: allowedThirdParty lists libm, which it no longer uses".to_owned()));
    }

    #[test]
    fn membership_is_checked_from_both_sides() {
        let mut members = healthy();
        members.push(member("store", "crates/mechanics/store", &[]));
        members.push(member("stray", "crates/core/stray", &[]));
        members.remove(1);
        let v = check_members(&map(BASE), &members);
        assert!(v.contains(&"store: exists but the map says planned".to_owned()), "{v:?}");
        assert!(v.contains(&"stray: a workspace member the map does not declare".to_owned()));
        assert!(v.contains(&"b: the map says present but it is not a workspace member".to_owned()));
    }

    #[test]
    fn a_member_must_inherit_workspace_lints() {
        assert!(inherits_workspace_lints("[package]\nname = \"a\"\n\n[lints]\nworkspace = true\n"));
        assert!(!inherits_workspace_lints("[package]\nworkspace = true\n[lints.rust]\n"));
        let mut members = healthy();
        members[0].inherits_workspace_lints = false;
        let v = check_members(&map(BASE), &members);
        assert_eq!(v, vec!["a: does not inherit [workspace.lints]".to_owned()]);
    }

    #[test]
    fn one_source_absorbed_by_two_crates_is_refused() {
        let m = map(&BASE
            .replace(
                r#""allowedThirdParty": { "libm": "pinned math" }, "absorbs": []"#,
                r#""allowedThirdParty": { "libm": "pinned math" }, "absorbs": ["packages/x"]"#,
            )
            .replace(
                r#""description": "s", "targets": ["native"], "allowedInternalDeps": ["a"],
               "allowedThirdParty": {}, "absorbs": []"#,
                r#""description": "s", "targets": ["native"], "allowedInternalDeps": ["a"],
               "allowedThirdParty": {}, "absorbs": ["packages/x"]"#,
            ));
        assert_eq!(check_map(&m), vec!["packages/x is absorbed by both a and store".to_owned()]);
    }

    #[test]
    fn a_core_crate_must_declare_the_totality_lints() {
        let mut members = healthy();
        members[1].declares_core_lints = false;
        let v = check_members(&map(BASE), &members);
        assert_eq!(v, vec![format!("b: src/lib.rs lacks {CORE_TOTALITY_LINTS}")]);
    }

    #[test]
    fn the_real_map_is_consistent_and_declares_the_planned_graph() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../architecture-map.json");
        let m: ArchMap = crate::metadata::read_json(&path).unwrap();
        assert_eq!(check_map(&m), Vec::<String>::new());
        // The subject is present: the whole target graph, not just today's crates.
        let planned = m.crates.values().filter(|c| c.status == Status::Planned).count();
        assert!(planned >= 15, "only {planned} planned crates declared");
        // Reserved for the fuzz targets, which build on nightly only.
        assert_eq!(m.crates.get("whiteboard-fuzz").map(|c| c.status), Some(Status::Planned));
    }
}
