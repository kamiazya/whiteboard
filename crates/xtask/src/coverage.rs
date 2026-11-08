//! `cargo xtask coverage`: each crate's line and region coverage of the native
//! test run is at or above its floor in `crates/coverage-floor.json` (QR-18).
//!
//! Floor policy (owner decision): a crate's floor starts at its first measured
//! value rounded down and only goes up. A floor more than the headroom below
//! the measurement fails too, so the PR that earned the coverage raises the
//! floor; `--update` only ever RAISES floors. Lowering one is a hand edit
//! whose reason a reviewer reads.
//!
//! One `cargo llvm-cov --workspace` run measures every crate, the workspace's
//! tests all counting toward each: the edge crate is covered mostly by the
//! wasm crate's replay of the TypeScript's recorded answers, which is how its
//! oracle reaches native tests at all. Coverage is a floor, not the measure
//! of test quality; the mutation gate (QR-17) carries that.

use std::collections::BTreeMap;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::metadata;

pub(crate) const LEDGER_PATH: &str = "crates/coverage-floor.json";
const LLVM_COV_VERSION: &str = "0.9.1";
const LLVM_COV_INSTALL: &str = "cargo install --locked cargo-llvm-cov --version 0.9.1";

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Ledger {
    #[serde(rename = "$comment")]
    comment: String,
    /// Percentage points a floor may sit below the measurement before it is stale.
    pub(crate) headroom_points: u64,
    /// Keyed by the crate's directory under `crates/`, e.g. `core/edge-routing`.
    pub(crate) crates: BTreeMap<String, Floor>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Floor {
    pub(crate) lines: u64,
    pub(crate) regions: u64,
    pub(crate) reason: String,
}

#[derive(Clone, Copy)]
pub(crate) enum Mode {
    Check,
    Update,
}

/// Covered and total counts for one crate.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Counts {
    pub(crate) lines: (u64, u64),
    pub(crate) regions: (u64, u64),
}

/// `covered / count` in basis points (hundredths of a percent), rounded down;
/// a crate with nothing to cover reads as fully covered.
pub(crate) fn basis_points((covered, count): (u64, u64)) -> u64 {
    (covered * 10_000).checked_div(count).unwrap_or(10_000)
}

/// One measure against its floor: `None` when it fits.
pub(crate) fn judge(what: &str, floor: u64, measured_bp: u64, headroom: u64) -> Option<String> {
    let measured = measured_bp / 100;
    if measured_bp < floor * 100 {
        Some(format!(
            "{what} coverage {}.{:02}% is under its floor of {floor}%",
            measured_bp / 100,
            measured_bp % 100
        ))
    } else if measured > floor + headroom {
        Some(format!(
            "{what} coverage {}.{:02}% leaves its floor of {floor}% stale; raise it to {measured} \
             with `cargo xtask coverage --update`",
            measured_bp / 100,
            measured_bp % 100
        ))
    } else {
        None
    }
}

#[derive(Deserialize)]
struct Report {
    data: Vec<ReportData>,
}
#[derive(Deserialize)]
struct ReportData {
    files: Vec<ReportFile>,
}
#[derive(Deserialize)]
struct ReportFile {
    filename: String,
    summary: Summary,
}
#[derive(Deserialize)]
struct Summary {
    lines: Tally,
    regions: Tally,
}
#[derive(Deserialize)]
struct Tally {
    count: u64,
    covered: u64,
}

/// The crate directory (`core/edge-routing`) a source file belongs to.
pub(crate) fn crate_of(filename: &str) -> Option<String> {
    let after = filename.rsplit_once("/crates/").map(|(_, rest)| rest)?;
    let (dir, _) = after.split_once("/src/")?;
    Some(dir.to_owned())
}

/// Per-crate counts out of `cargo llvm-cov --json --summary-only`'s report.
pub(crate) fn tally(report_json: &str) -> Result<BTreeMap<String, Counts>, String> {
    let report: Report = serde_json::from_str(report_json)
        .map_err(|e| format!("unreadable llvm-cov report: {e}"))?;
    let mut by = BTreeMap::<String, Counts>::new();
    for file in report.data.iter().flat_map(|d| &d.files) {
        let Some(name) = crate_of(&file.filename) else { continue };
        let c = by.entry(name).or_default();
        c.lines.0 += file.summary.lines.covered;
        c.lines.1 += file.summary.lines.count;
        c.regions.0 += file.summary.regions.covered;
        c.regions.1 += file.summary.regions.count;
    }
    Ok(by)
}

fn measure(root: &std::path::Path) -> Result<String, Vec<String>> {
    let version = Command::new(metadata::cargo()).args(["llvm-cov", "--version"]).output();
    let found = version.as_ref().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
    match found {
        Ok(v) if v.ends_with(LLVM_COV_VERSION) => {}
        Ok(v) if !v.is_empty() => {
            return Err(vec![format!(
                "coverage: cargo-llvm-cov {LLVM_COV_VERSION} is required, found `{v}`. Install it \
                 with:\n  {LLVM_COV_INSTALL}"
            )]);
        }
        _ => {
            return Err(vec![format!(
                "coverage: cargo-llvm-cov is not installed. Install it with:\n  {LLVM_COV_INSTALL}"
            )]);
        }
    }
    let out = Command::new(metadata::cargo())
        .current_dir(root)
        .args(["llvm-cov", "--workspace", "--locked", "--json", "--summary-only"])
        .output()
        .map_err(|e| vec![format!("cannot run cargo llvm-cov: {e}")])?;
    if !out.status.success() {
        return Err(vec![format!(
            "cargo llvm-cov failed:\n{}",
            String::from_utf8_lossy(&out.stderr)
        )]);
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The ledger's crates and the measured ones, from both sides.
pub(crate) fn coverage_of_ledger(
    ledger: &Ledger,
    measured: &BTreeMap<String, Counts>,
) -> Vec<String> {
    let mut v = Vec::new();
    for name in measured.keys() {
        if !ledger.crates.contains_key(name) {
            v.push(format!("{name}: a measured crate with no floor in {LEDGER_PATH}"));
        }
    }
    for (name, floor) in &ledger.crates {
        if !measured.contains_key(name) {
            v.push(format!("{name}: a floor for a crate the run did not measure"));
        }
        if floor.reason.trim().is_empty() {
            v.push(format!("{name}: a floor with no reason"));
        }
    }
    v
}

pub(crate) fn run(mode: Mode) -> Result<Vec<String>, Vec<String>> {
    let metadata = metadata::load()?;
    let ledger_path = metadata.workspace_root.join(LEDGER_PATH);
    let mut ledger: Ledger = metadata::read_json(&ledger_path)?;
    let measured = tally(&measure(&metadata.workspace_root)?).map_err(|e| vec![e])?;
    let mut violations = coverage_of_ledger(&ledger, &measured);
    let mut report = Vec::new();
    let mut changed = false;
    for (name, counts) in &measured {
        let Some(floor) = ledger.crates.get_mut(name) else { continue };
        let (lines, regions) = (basis_points(counts.lines), basis_points(counts.regions));
        report.push(format!(
            "  {name}: lines {}.{:02}% (floor {}), regions {}.{:02}% (floor {})",
            lines / 100,
            lines % 100,
            floor.lines,
            regions / 100,
            regions % 100,
            floor.regions
        ));
        if let Mode::Update = mode {
            for (f, bp) in [(&mut floor.lines, lines), (&mut floor.regions, regions)] {
                if bp / 100 > *f {
                    *f = bp / 100;
                    changed = true;
                }
            }
        }
        let headroom = ledger.headroom_points;
        for (what, f, bp) in [("line", floor.lines, lines), ("region", floor.regions, regions)] {
            if let Some(v) = judge(what, f, bp, headroom) {
                violations.push(format!("{name}: {v}"));
            }
        }
    }
    if changed {
        let text = serde_json::to_string_pretty(&ledger)
            .map_err(|e| vec![format!("cannot serialise {LEDGER_PATH}: {e}")])?;
        std::fs::write(&ledger_path, format!("{text}\n"))
            .map_err(|e| vec![format!("cannot write {}: {e}", ledger_path.display())])?;
    }
    if violations.is_empty() {
        report.insert(0, "coverage: every crate is at or above its floor".to_owned());
        Ok(report)
    } else {
        Err(violations)
    }
}

#[cfg(test)]
mod tests {
    use super::{basis_points, crate_of, judge, tally};

    #[test]
    fn a_floor_fits_between_itself_and_its_headroom() {
        assert_eq!(judge("line", 94, 9_447, 2), None);
        assert_eq!(judge("line", 94, 9_400, 2), None);
        assert_eq!(judge("line", 94, 9_699, 2), None);
    }

    #[test]
    fn a_measurement_under_its_floor_fails() {
        assert!(judge("line", 94, 9_399, 2).is_some_and(|v| v.contains("under its floor")));
    }

    #[test]
    fn a_floor_more_than_the_headroom_below_fails_as_stale() {
        assert!(judge("line", 94, 9_700, 2).is_some_and(|v| v.contains("stale")));
    }

    #[test]
    fn counts_round_down_to_basis_points() {
        assert_eq!(basis_points((3706, 3923)), 9_446);
        assert_eq!(basis_points((0, 0)), 10_000);
    }

    #[test]
    fn a_file_is_counted_toward_the_crate_whose_src_holds_it() {
        assert_eq!(
            crate_of("/w/crates/core/edge-routing/src/generated/geometry.rs").as_deref(),
            Some("core/edge-routing")
        );
        assert_eq!(crate_of("/w/crates/xtask/src/main.rs").as_deref(), Some("xtask"));
        assert_eq!(crate_of("/rustc/library/core/src/lib.rs"), None);
        let json = r#"{"data":[{"files":[
          {"filename":"/w/crates/core/log/src/a.rs","summary":{"lines":{"count":4,"covered":3},"regions":{"count":2,"covered":1}}},
          {"filename":"/w/crates/core/log/src/b.rs","summary":{"lines":{"count":6,"covered":6},"regions":{"count":2,"covered":2}}}
        ]}]}"#;
        let by = tally(json).unwrap_or_default();
        let log = by.get("core/log").copied().unwrap_or_default();
        assert_eq!((log.lines, log.regions), ((9, 10), (3, 4)));
    }
}
