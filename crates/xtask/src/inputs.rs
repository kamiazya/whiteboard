//! `cargo xtask inputs`: every untrusted-input entry declares its caps and
//! has a fuzz target, and every fuzz target names an entry.
//!
//! An entry that reads bytes from outside the process is where a hostile
//! document, frame or request first arrives, so each one states how much it
//! will read, how deep it will nest and how long it may run, in
//! `crates/input-caps.json`. That file is also the fuzz registry: the targets
//! under `crates/fuzz` are derived from it, so an entry nobody fuzzes and a
//! target fuzzing nothing listed are both refused here.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Deserialize;

use crate::arch_map;
use crate::metadata;

pub(crate) const LEDGER_PATH: &str = "crates/input-caps.json";
pub(crate) const FUZZ_DIR: &str = "crates/fuzz";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Ledger {
    #[serde(rename = "$comment")]
    _comment: String,
    pub(crate) entries: BTreeMap<String, Caps>,
}

/// Optional so that a missing field is reported by name rather than as a
/// parse error.
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Caps {
    #[serde(rename = "crate")]
    pub(crate) krate: Option<String>,
    pub(crate) fuzz_target: Option<String>,
    #[serde(default)]
    pub(crate) template: bool,
    pub(crate) max_bytes: Option<u64>,
    pub(crate) max_depth: Option<u64>,
    pub(crate) max_millis: Option<u64>,
    /// Only where the entry builds a tree whose size is not bounded by its
    /// input length (a decompressing import, a CRDT update).
    pub(crate) max_nodes: Option<u64>,
    #[serde(default)]
    pub(crate) reason: String,
}

/// The fuzz crate as the check needs to see it.
#[derive(Debug, Default)]
pub(crate) struct FuzzCrate {
    /// `[[bin]]` name to whether its source calls the target body of the
    /// same name.
    pub(crate) bins: BTreeMap<String, bool>,
    /// Names under `[dependencies]`.
    pub(crate) deps: BTreeSet<String>,
    /// Directory names under `regressions/`.
    pub(crate) regression_dirs: BTreeSet<String>,
}

pub(crate) fn check(ledger: &Ledger, known_crates: &[&str], fuzz: &FuzzCrate) -> Vec<String> {
    let mut v = Vec::new();
    let mut targets: BTreeMap<&str, &str> = BTreeMap::new();
    let mut templates = 0usize;
    for (key, caps) in &ledger.entries {
        let krate = key.split("::").next().unwrap_or_default();
        if !key.contains("::") || !known_crates.contains(&krate) {
            v.push(format!("{key}: not `<crate>::<entry>` naming a crate in the architecture map"));
        }
        match caps.krate.as_deref() {
            None => v.push(format!("{key}: declares no crate")),
            Some(c) if c != krate => {
                v.push(format!("{key}: declares crate {c}, but its key names {krate}"));
            }
            Some(c) if !fuzz.deps.contains(c) => {
                v.push(format!(
                    "{key}: {FUZZ_DIR} does not depend on {c}, so no target reaches it"
                ));
            }
            Some(_) => {}
        }
        for (cap, value) in [
            ("maxBytes", caps.max_bytes),
            ("maxDepth", caps.max_depth),
            ("maxMillis", caps.max_millis),
        ] {
            match value {
                None => v.push(format!("{key}: declares no {cap}")),
                Some(0) => v.push(format!("{key}: {cap} of 0 admits no input at all")),
                Some(_) => {}
            }
        }
        if caps.max_nodes == Some(0) {
            v.push(format!("{key}: maxNodes of 0 admits no input at all"));
        }
        if caps.reason.trim().is_empty() {
            v.push(format!("{key}: caps with no reason"));
        }
        if caps.template {
            templates += 1;
        }
        match caps.fuzz_target.as_deref() {
            None => v.push(format!("{key}: names no fuzzTarget")),
            Some(t) => {
                if let Some(other) = targets.insert(t, key) {
                    v.push(format!("{key}: fuzzTarget {t} is already {other}'s"));
                }
                match fuzz.bins.get(t) {
                    None => v.push(format!("{key}: fuzzTarget {t} is not a [[bin]] of {FUZZ_DIR}")),
                    Some(false) => v.push(format!(
                        "{key}: {FUZZ_DIR}/fuzz_targets/{t}.rs does not call whiteboard_fuzz::targets::{t}"
                    )),
                    Some(true) => {}
                }
            }
        }
    }
    if templates > 1 {
        v.push(format!("{templates} entries are marked template; at most one may be"));
    }
    for bin in fuzz.bins.keys() {
        if !targets.contains_key(bin.as_str()) {
            v.push(format!(
                "{FUZZ_DIR}: target {bin} is the fuzzTarget of no entry in {LEDGER_PATH}"
            ));
        }
    }
    for dir in &fuzz.regression_dirs {
        if !fuzz.bins.contains_key(dir) {
            v.push(format!("{FUZZ_DIR}/regressions/{dir}: names no fuzz target"));
        }
    }
    v
}

/// Reads the fuzz crate's manifest and tree. The manifest is read as text
/// (`[[bin]]` blocks and the `[dependencies]` table), which is all this
/// needs and keeps a TOML parser out of the tooling's dependencies.
pub(crate) fn read_fuzz_crate(dir: &Path) -> Result<FuzzCrate, Vec<String>> {
    let manifest_path = dir.join("Cargo.toml");
    let manifest = std::fs::read_to_string(&manifest_path)
        .map_err(|e| vec![format!("cannot read {}: {e}", manifest_path.display())])?;
    let mut fuzz = parse_fuzz_manifest(&manifest);
    let names: Vec<String> = fuzz.bins.keys().cloned().collect();
    for name in names {
        let calls = std::fs::read_to_string(dir.join("fuzz_targets").join(format!("{name}.rs")))
            .is_ok_and(|src| src.contains(&format!("whiteboard_fuzz::targets::{name}(")));
        fuzz.bins.insert(name, calls);
    }
    if let Ok(entries) = std::fs::read_dir(dir.join("regressions")) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                fuzz.regression_dirs.insert(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    Ok(fuzz)
}

pub(crate) fn parse_fuzz_manifest(manifest: &str) -> FuzzCrate {
    let mut fuzz = FuzzCrate::default();
    let mut section = "";
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line;
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if section == "[[bin]]" && key == "name" {
            fuzz.bins.insert(value.trim().trim_matches('"').to_owned(), false);
        } else if section == "[dependencies]" {
            fuzz.deps.insert(key.to_owned());
        }
    }
    fuzz
}

pub(crate) fn run() -> Result<Vec<String>, Vec<String>> {
    let metadata = metadata::load()?;
    let map = arch_map::load_map(&metadata)?;
    let ledger: Ledger = metadata::read_json(&metadata.workspace_root.join(LEDGER_PATH))?;
    let fuzz = read_fuzz_crate(&metadata.workspace_root.join(FUZZ_DIR))?;
    let known: Vec<&str> = map.crates.keys().map(String::as_str).collect();
    let mut v = check(&ledger, &known, &fuzz);
    if v.is_empty() {
        Ok(vec![format!(
            "inputs: {} untrusted-input entries declare their caps, each with its fuzz target ({} targets)",
            ledger.entries.len(),
            fuzz.bins.len()
        )])
    } else {
        v.insert(0, format!("inputs: {LEDGER_PATH} and {FUZZ_DIR} disagree:"));
        Err(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: &str = "whiteboard-codec::parse_okf";

    fn ledger(entries: &[(&str, Caps)]) -> Ledger {
        Ledger {
            _comment: String::new(),
            entries: entries.iter().map(|(k, c)| ((*k).to_owned(), c.clone())).collect(),
        }
    }

    fn full() -> Caps {
        Caps {
            krate: Some("whiteboard-codec".to_owned()),
            fuzz_target: Some("codec_okf".to_owned()),
            template: false,
            max_bytes: Some(1 << 20),
            max_depth: Some(64),
            max_millis: Some(250),
            max_nodes: None,
            reason: "measured".to_owned(),
        }
    }

    fn fuzz() -> FuzzCrate {
        FuzzCrate {
            bins: [("codec_okf".to_owned(), true)].into(),
            deps: ["whiteboard-codec".to_owned(), "libfuzzer-sys".to_owned()].into(),
            regression_dirs: ["codec_okf".to_owned()].into(),
        }
    }

    fn violations(caps: Caps, fuzz: &FuzzCrate) -> Vec<String> {
        check(&ledger(&[(ENTRY, caps)]), &["whiteboard-codec"], fuzz)
    }

    #[test]
    fn an_entry_with_every_cap_and_its_target_passes() {
        assert_eq!(violations(full(), &fuzz()), Vec::<String>::new());
    }

    #[test]
    fn a_missing_or_zero_cap_fails_by_name() {
        let caps = Caps { max_depth: None, max_millis: Some(0), max_nodes: Some(0), ..full() };
        assert_eq!(
            violations(caps, &fuzz()),
            vec![
                format!("{ENTRY}: declares no maxDepth"),
                format!("{ENTRY}: maxMillis of 0 admits no input at all"),
                format!("{ENTRY}: maxNodes of 0 admits no input at all"),
            ]
        );
    }

    #[test]
    fn an_entry_must_name_a_mapped_crate() {
        let v = check(
            &ledger(&[("stray::parse", full()), ("noseparator", full())]),
            &["whiteboard-codec"],
            &fuzz(),
        );
        assert!(
            v.iter().filter(|l| l.contains("naming a crate in the architecture map")).count() == 2,
            "{v:?}"
        );
    }

    #[test]
    fn the_crate_field_must_agree_with_the_key_and_be_a_fuzz_dependency() {
        let v = violations(Caps { krate: Some("whiteboard-model".to_owned()), ..full() }, &fuzz());
        assert_eq!(
            v,
            vec![format!(
                "{ENTRY}: declares crate whiteboard-model, but its key names whiteboard-codec"
            )]
        );
        let mut f = fuzz();
        f.deps.remove("whiteboard-codec");
        assert_eq!(
            violations(full(), &f),
            vec![format!(
                "{ENTRY}: crates/fuzz does not depend on whiteboard-codec, so no target reaches it"
            )]
        );
    }

    #[test]
    fn an_entry_without_a_target_fails() {
        assert_eq!(
            violations(Caps { fuzz_target: None, ..full() }, &fuzz()),
            vec![
                format!("{ENTRY}: names no fuzzTarget"),
                "crates/fuzz: target codec_okf is the fuzzTarget of no entry in crates/input-caps.json"
                    .to_owned(),
            ]
        );
        let v = violations(Caps { fuzz_target: Some("codec_gone".to_owned()), ..full() }, &fuzz());
        assert!(
            v.contains(&format!("{ENTRY}: fuzzTarget codec_gone is not a [[bin]] of crates/fuzz")),
            "{v:?}"
        );
    }

    #[test]
    fn a_target_whose_shell_calls_another_body_fails() {
        let mut f = fuzz();
        f.bins.insert("codec_okf".to_owned(), false);
        assert_eq!(
            violations(full(), &f),
            vec![format!(
                "{ENTRY}: crates/fuzz/fuzz_targets/codec_okf.rs does not call whiteboard_fuzz::targets::codec_okf"
            )]
        );
    }

    #[test]
    fn a_target_with_no_entry_and_a_stray_regression_dir_fail() {
        let mut f = fuzz();
        f.bins.insert("codec_extra".to_owned(), true);
        f.regression_dirs.insert("codec_removed".to_owned());
        assert_eq!(
            violations(full(), &f),
            vec![
                "crates/fuzz: target codec_extra is the fuzzTarget of no entry in crates/input-caps.json"
                    .to_owned(),
                "crates/fuzz/regressions/codec_removed: names no fuzz target".to_owned(),
            ]
        );
    }

    #[test]
    fn two_entries_sharing_a_target_or_two_templates_fail() {
        let caps = Caps { template: true, ..full() };
        let v = check(
            &ledger(&[(ENTRY, caps.clone()), ("whiteboard-codec::parse_canvas", caps)]),
            &["whiteboard-codec"],
            &fuzz(),
        );
        assert!(v.iter().any(|l| l.contains("is already")), "{v:?}");
        assert!(v.iter().any(|l| l.contains("2 entries are marked template")), "{v:?}");
    }

    #[test]
    fn the_fuzz_manifest_parse_finds_bins_and_dependencies() {
        let f = parse_fuzz_manifest(
            "[package]\nname = \"whiteboard-fuzz\"\n[dependencies]\nlibfuzzer-sys = { version = \"0.4\" }\nwhiteboard-det = { path = \"../core/det\" }\n[[bin]]\nname = \"a\"\npath = \"fuzz_targets/a.rs\"\n[[bin]]\nname = \"b\"\n",
        );
        assert_eq!(f.bins.keys().collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(f.deps.iter().collect::<Vec<_>>(), ["libfuzzer-sys", "whiteboard-det"]);
    }

    #[test]
    fn the_checked_in_registry_and_fuzz_crate_agree() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let l: Ledger = metadata::read_json(&root.join(LEDGER_PATH)).unwrap();
        let m: arch_map::ArchMap = metadata::read_json(&root.join(arch_map::MAP_PATH)).unwrap();
        let fuzz = read_fuzz_crate(&root.join(FUZZ_DIR)).unwrap();
        let known: Vec<&str> = m.crates.keys().map(String::as_str).collect();
        assert_eq!(check(&l, &known, &fuzz), Vec::<String>::new());
        // The walk reached the real crate: an empty registry over an empty
        // fuzz crate would agree as well.
        assert!(!fuzz.bins.is_empty() && !l.entries.is_empty());
    }
}
