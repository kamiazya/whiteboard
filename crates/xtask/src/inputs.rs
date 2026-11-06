//! `cargo xtask inputs`: every untrusted-input entry declares its caps.
//!
//! An entry that reads bytes from outside the process is where a hostile
//! document, frame or request first arrives, so each one states how much it
//! will read, how deep it will nest and how long it may run, in
//! `crates/input-caps.json`. A cap that is missing is the bug this exists to
//! refuse; the fuzz target for the same entry is what checks the cap holds.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::arch_map;
use crate::metadata;

pub(crate) const LEDGER_PATH: &str = "crates/input-caps.json";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Ledger {
    #[serde(rename = "$comment")]
    _comment: String,
    pub(crate) entries: BTreeMap<String, Caps>,
}

/// Optional so that a missing cap is reported by name rather than as a
/// parse error.
#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Caps {
    pub(crate) max_bytes: Option<u64>,
    pub(crate) max_depth: Option<u64>,
    pub(crate) max_millis: Option<u64>,
    #[serde(default)]
    pub(crate) reason: String,
}

pub(crate) fn check(ledger: &Ledger, known_crates: &[&str]) -> Vec<String> {
    let mut v = Vec::new();
    for (key, caps) in &ledger.entries {
        let krate = key.split("::").next().unwrap_or_default();
        if !key.contains("::") || !known_crates.contains(&krate) {
            v.push(format!("{key}: not `<crate>::<entry>` naming a crate in the architecture map"));
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
        if caps.reason.trim().is_empty() {
            v.push(format!("{key}: caps with no reason"));
        }
    }
    v
}

pub(crate) fn run() -> Result<Vec<String>, Vec<String>> {
    let metadata = metadata::load()?;
    let map = arch_map::load_map(&metadata)?;
    let ledger: Ledger = metadata::read_json(&metadata.workspace_root.join(LEDGER_PATH))?;
    let known: Vec<&str> = map.crates.keys().map(String::as_str).collect();
    let mut v = check(&ledger, &known);
    if v.is_empty() {
        Ok(vec![format!(
            "inputs: {} untrusted-input entries declare their caps",
            ledger.entries.len()
        )])
    } else {
        v.insert(0, format!("inputs: {LEDGER_PATH} is violated:"));
        Err(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger(entries: &[(&str, Caps)]) -> Ledger {
        Ledger {
            _comment: String::new(),
            entries: entries
                .iter()
                .map(|(k, c)| ((*k).to_owned(), Caps { reason: c.reason.clone(), ..*c }))
                .collect(),
        }
    }

    fn full() -> Caps {
        Caps {
            max_bytes: Some(1 << 20),
            max_depth: Some(64),
            max_millis: Some(250),
            reason: "measured".to_owned(),
        }
    }

    #[test]
    fn an_entry_with_every_cap_passes() {
        assert_eq!(
            check(&ledger(&[("whiteboard-codec::parse_okf", full())]), &["whiteboard-codec"]),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_missing_or_zero_cap_fails_by_name() {
        let caps = Caps { max_depth: None, max_millis: Some(0), ..full() };
        let v = check(&ledger(&[("whiteboard-codec::parse_okf", caps)]), &["whiteboard-codec"]);
        assert_eq!(
            v,
            vec![
                "whiteboard-codec::parse_okf: declares no maxDepth".to_owned(),
                "whiteboard-codec::parse_okf: maxMillis of 0 admits no input at all".to_owned(),
            ]
        );
    }

    #[test]
    fn an_entry_must_name_a_mapped_crate() {
        let v = check(
            &ledger(&[("stray::parse", full()), ("noseparator", full())]),
            &["whiteboard-codec"],
        );
        assert_eq!(v.len(), 2, "{v:?}");
    }

    #[test]
    fn the_checked_in_ledger_parses_and_passes() {
        let crates = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let l: Ledger = crate::metadata::read_json(&crates.join("input-caps.json")).unwrap();
        let m: arch_map::ArchMap =
            crate::metadata::read_json(&crates.join("architecture-map.json")).unwrap();
        let known: Vec<&str> = m.crates.keys().map(String::as_str).collect();
        assert_eq!(check(&l, &known), Vec::<String>::new());
    }
}
