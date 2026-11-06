//! `cargo xtask size`: every shipped wasm artifact fits its ledgered ceiling.
//!
//! What it measures is the cargo artifact `cargo xtask dist wasm` writes —
//! the release build, with its remapped paths — not a plain `cargo build
//! --release`, whose bytes differ (by 8 B on the skeleton, the length of the
//! paths it bakes in) and never ship.
//!
//! The browser downloads and Workers instantiate every byte, so growth is a
//! decision rather than drift. The ledger is shrink-only with headroom: an
//! artifact over its ceiling fails, and so does a ceiling more than the
//! headroom above the artifact, so a saving is banked instead of becoming
//! room for the next regression. `--update` only ever LOWERS a ceiling;
//! raising one is a hand edit whose reason a reviewer reads.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::dist;
use crate::metadata;
use crate::wasm_imports::{WASM_BINDINGS, artifact};

pub(crate) const LEDGER_PATH: &str = "crates/wasm-size-ledger.json";

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Ledger {
    #[serde(rename = "$comment")]
    comment: String,
    pub(crate) headroom_percent: u64,
    pub(crate) headroom_min_bytes: u64,
    pub(crate) artifacts: BTreeMap<String, Entry>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Entry {
    pub(crate) ceiling_bytes: u64,
    pub(crate) reason: String,
}

#[derive(Clone, Copy)]
pub(crate) enum Mode {
    Check,
    Update,
}

impl Ledger {
    pub(crate) fn headroom(&self, actual: u64) -> u64 {
        (actual * self.headroom_percent / 100).max(self.headroom_min_bytes)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Fits,
    Over { ceiling: u64 },
    Stale { ceiling: u64, tightened: u64 },
}

pub(crate) fn judge(ledger: &Ledger, entry: &Entry, actual: u64) -> Verdict {
    let tightened = actual + ledger.headroom(actual);
    if actual > entry.ceiling_bytes {
        Verdict::Over { ceiling: entry.ceiling_bytes }
    } else if entry.ceiling_bytes > tightened {
        Verdict::Stale { ceiling: entry.ceiling_bytes, tightened }
    } else {
        Verdict::Fits
    }
}

/// The ledger's artifact names and the built artifacts, from both sides.
pub(crate) fn coverage(ledger: &Ledger, built: &[&str]) -> Vec<String> {
    let mut v = Vec::new();
    for name in built {
        if !ledger.artifacts.contains_key(*name) {
            v.push(format!("{name}: a shipped wasm artifact with no ledger entry"));
        }
    }
    for (name, entry) in &ledger.artifacts {
        if !built.contains(&name.as_str()) {
            v.push(format!("{name}: a ledger entry for an artifact nothing builds"));
        }
        if entry.reason.trim().is_empty() {
            v.push(format!("{name}: a ceiling with no reason"));
        }
    }
    v
}

/// The byte size of `name`'s cargo artifact as `cargo xtask dist wasm` wrote
/// it into `dist_dir`, refusing any file that build did not ship.
fn shipped_bytes(name: &str, dist_dir: &Path, shipped: &[PathBuf]) -> Result<u64, String> {
    if name != dist::WASM_PACKAGE {
        return Err(format!(
            "{name}: `cargo xtask dist wasm` does not build it, so its shipped bytes cannot be \
             measured; teach dist to build it"
        ));
    }
    let path = artifact(dist_dir, "release", name);
    if !shipped.contains(&path) {
        return Err(format!(
            "{name}: {} is not a file `cargo xtask dist wasm` ships",
            path.display()
        ));
    }
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("cannot stat {}: {e}", path.display()))
}

pub(crate) fn run(mode: Mode) -> Result<Vec<String>, Vec<String>> {
    let metadata = metadata::load()?;
    let ledger_path = metadata.workspace_root.join(LEDGER_PATH);
    let mut ledger: Ledger = metadata::read_json(&ledger_path)?;
    let mut violations = coverage(&ledger, WASM_BINDINGS);
    let mut report = Vec::new();
    let mut changed = false;
    let dist_dir = dist::default_target_dir(&metadata.target_directory);
    let shipped = dist::build(&metadata.workspace_root, &dist_dir, dist::Artifact::Wasm)?;
    for name in WASM_BINDINGS {
        let actual = match shipped_bytes(name, &dist_dir, &shipped) {
            Ok(bytes) => bytes,
            Err(violation) => {
                violations.push(violation);
                continue;
            }
        };
        let Some(entry) = ledger.artifacts.get(*name).cloned() else {
            continue;
        };
        match (judge(&ledger, &entry, actual), mode) {
            (Verdict::Fits, _) => {
                report.push(format!("  {name}: {actual} bytes (ceiling {})", entry.ceiling_bytes));
            }
            (Verdict::Over { ceiling }, _) => violations.push(format!(
                "{name}: {actual} bytes is over its ceiling of {ceiling}. Shrink it, or raise the \
                 ceiling by hand in {LEDGER_PATH} with the reason the growth is worth it"
            )),
            (Verdict::Stale { ceiling, tightened }, Mode::Check) => violations.push(format!(
                "{name}: {actual} bytes leaves its ceiling of {ceiling} stale; bank the saving \
                 with `cargo xtask size --update` (ceiling {tightened})"
            )),
            (Verdict::Stale { tightened, .. }, Mode::Update) => {
                if let Some(e) = ledger.artifacts.get_mut(*name) {
                    e.ceiling_bytes = tightened;
                }
                changed = true;
                report.push(format!("  {name}: {actual} bytes, ceiling lowered to {tightened}"));
            }
        }
    }
    if !violations.is_empty() {
        violations.insert(0, "size: the wasm size ledger is violated:".to_owned());
        return Err(violations);
    }
    if changed {
        let text = serde_json::to_string_pretty(&ledger)
            .map_err(|e| vec![format!("cannot serialize the ledger: {e}")])?;
        std::fs::write(&ledger_path, format!("{text}\n"))
            .map_err(|e| vec![format!("cannot write {}: {e}", ledger_path.display())])?;
    }
    report.insert(0, format!("size: {} wasm artifacts fit {LEDGER_PATH}", WASM_BINDINGS.len()));
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger(ceiling: u64) -> (Ledger, Entry) {
        let entry = Entry { ceiling_bytes: ceiling, reason: "measured".to_owned() };
        let ledger = Ledger {
            comment: String::new(),
            headroom_percent: 5,
            headroom_min_bytes: 1024,
            artifacts: BTreeMap::from([("a".to_owned(), entry.clone())]),
        };
        (ledger, entry)
    }

    #[test]
    fn headroom_is_a_percentage_with_a_floor() {
        let (l, _) = ledger(0);
        assert_eq!(l.headroom(100), 1024);
        assert_eq!(l.headroom(100_000), 5_000);
    }

    #[test]
    fn an_artifact_over_its_ceiling_fails() {
        let (l, e) = ledger(10_000);
        assert_eq!(judge(&l, &e, 10_001), Verdict::Over { ceiling: 10_000 });
        assert_eq!(judge(&l, &e, 10_000), Verdict::Fits);
    }

    #[test]
    fn a_ceiling_beyond_the_headroom_is_stale() {
        let (l, e) = ledger(10_000);
        assert_eq!(judge(&l, &e, 8_976), Verdict::Fits);
        assert_eq!(judge(&l, &e, 8_975), Verdict::Stale { ceiling: 10_000, tightened: 9_999 });
    }

    #[test]
    fn the_ledger_and_the_built_artifacts_are_checked_from_both_sides() {
        let (l, _) = ledger(1);
        assert_eq!(coverage(&l, &["a"]), Vec::<String>::new());
        let v = coverage(&l, &["b"]);
        assert!(v.contains(&"b: a shipped wasm artifact with no ledger entry".to_owned()));
        assert!(v.contains(&"a: a ledger entry for an artifact nothing builds".to_owned()));
    }

    #[test]
    fn the_ledger_measures_the_artifact_the_release_build_ships() {
        // `size` reads the bytes `cargo xtask dist wasm` writes, so a
        // ledgered artifact dist does not build would have nothing to measure.
        assert_eq!(WASM_BINDINGS, [crate::dist::WASM_PACKAGE]);
        let target = std::path::Path::new("/t");
        assert_eq!(
            artifact(&crate::dist::default_target_dir(target), "release", WASM_BINDINGS[0]),
            std::path::Path::new("/t/dist/wasm32-unknown-unknown/release/whiteboard_wasm.wasm"),
        );
    }

    #[test]
    fn the_checked_in_ledger_covers_every_shipped_artifact() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../wasm-size-ledger.json");
        let l: Ledger = crate::metadata::read_json(&path).unwrap();
        assert_eq!(coverage(&l, WASM_BINDINGS), Vec::<String>::new());
    }
}
