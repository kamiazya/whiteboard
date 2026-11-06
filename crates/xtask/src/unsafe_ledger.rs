//! `cargo xtask unsafe-ledger [--update]`: the `unsafe` the dependency tree
//! carries, per crate, against `crates/unsafe-ledger.json` (QR-28c).
//!
//! The method is a COUNT OF TOKENS, not cargo-geiger's analysis: every `.rs`
//! file under each registry dependency's source directory is lexed (comments,
//! string, raw-string and char literals skipped) and each `unsafe` keyword is
//! counted — on blocks, functions, impls, traits and `extern` blocks alike,
//! whether or not the build reaches that code. It over-counts (a feature or
//! platform this repository never compiles still counts) and does not weigh
//! what a block does. What it is for is the one question the ledger asks:
//! did a dependency change bring MORE `unsafe` into the tree than was read
//! and accepted? For that a stable, dependency-free count is enough, and it
//! needs no install beside the toolchain.
//!
//! The ledger is shrink-only, like the size ledger: a count above its entry
//! fails until the entry is raised by hand with a reason; a count below it
//! fails as stale until `--update` banks the saving; a crate with `unsafe`
//! and no entry fails, and so does an entry for a crate no longer in the
//! tree. Both workspaces are counted — the root and the nightly-only fuzz
//! crate — over every platform the lockfiles resolve.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::metadata;

pub(crate) const LEDGER_PATH: &str = "crates/unsafe-ledger.json";
const NESTED_WORKSPACES: &[&str] = &["crates/fuzz/Cargo.toml"];

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Ledger {
    #[serde(rename = "$comment")]
    pub(crate) comment: String,
    pub(crate) crates: BTreeMap<String, Entry>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct Entry {
    /// The most `unsafe` tokens the crate's source may hold.
    pub(crate) ceiling: u64,
    pub(crate) reason: String,
}

#[derive(Debug, Deserialize)]
struct FullMetadata {
    packages: Vec<FullPackage>,
}

#[derive(Debug, Deserialize)]
struct FullPackage {
    name: String,
    version: String,
    /// `None` for this repository's own crates.
    source: Option<String>,
    manifest_path: PathBuf,
}

/// Crate name to its `unsafe` token count and the versions summed into it.
pub(crate) type Counts = BTreeMap<String, (u64, Vec<String>)>;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Mode {
    Check,
    Update,
}

/// Counts `unsafe` keyword tokens in Rust source, skipping comments and
/// literals. Lifetimes (`'a`) are told from char literals (`'a'`) by the
/// closing quote.
pub(crate) fn count_unsafe(src: &str) -> u64 {
    let b = src.as_bytes();
    let mut i = 0usize;
    let mut n = 0u64;
    let at = |k: usize| b.get(k).copied().unwrap_or(0);
    while i < b.len() {
        let c = at(i);
        if c == b'/' && at(i + 1) == b'/' {
            while i < b.len() && at(i) != b'\n' {
                i += 1;
            }
        } else if c == b'/' && at(i + 1) == b'*' {
            let mut depth = 1u32;
            i += 2;
            while i < b.len() && depth > 0 {
                if at(i) == b'/' && at(i + 1) == b'*' {
                    depth += 1;
                    i += 2;
                } else if at(i) == b'*' && at(i + 1) == b'/' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if c == b'"' {
            i = skip_string(b, i + 1);
        } else if c == b'\'' {
            if at(i + 1) == b'\\' {
                // Quote, backslash and the escaped char, then up to the
                // close (`'\u{1F600}'` runs past one char).
                i += 3;
                while i < b.len() && at(i) != b'\'' {
                    i += 1;
                }
                i += 1;
            } else if at(i + 2) == b'\'' {
                i += 3;
            } else {
                // A lifetime, or a multi-byte char literal: skip one UTF-8
                // char and its closing quote if one follows.
                i += 1;
                let start = i;
                while i < b.len() && (at(i).is_ascii_alphanumeric() || at(i) == b'_') {
                    i += 1;
                }
                if i == start {
                    while i < b.len() && at(i) != b'\'' && i < start + 4 {
                        i += 1;
                    }
                    i += 1;
                }
            }
        } else if c.is_ascii_alphabetic() || c == b'_' {
            let start = i;
            while i < b.len() && (at(i).is_ascii_alphanumeric() || at(i) == b'_') {
                i += 1;
            }
            let word = src.get(start..i).unwrap_or_default();
            // Raw strings and byte/C strings start with an identifier-looking
            // prefix: r"..", r#".."#, b"..", br"..", c"..", cr#"..."#.
            if matches!(word, "r" | "br" | "cr") && matches!(at(i), b'"' | b'#') {
                i = skip_raw_string(b, i);
            } else if matches!(word, "b" | "c") && at(i) == b'"' {
                i = skip_string(b, i + 1);
            } else if word == "b" && at(i) == b'\'' {
                i += 1;
                while i < b.len() && at(i) != b'\'' {
                    i += if at(i) == b'\\' { 2 } else { 1 };
                }
                i += 1;
            } else if word == "unsafe" && !(start >= 2 && src.get(start - 2..start) == Some("r#")) {
                n += 1;
            }
        } else {
            i += 1;
        }
    }
    n
}

/// From just inside an opening `"` to just past its closing one.
fn skip_string(b: &[u8], mut i: usize) -> usize {
    while let Some(&c) = b.get(i) {
        i += match c {
            b'\\' => 2,
            b'"' => return i + 1,
            _ => 1,
        };
    }
    i
}

/// From the `#`s or `"` after an `r` prefix to past the matching close.
fn skip_raw_string(b: &[u8], mut i: usize) -> usize {
    let mut hashes = 0usize;
    while b.get(i) == Some(&b'#') {
        hashes += 1;
        i += 1;
    }
    if b.get(i) != Some(&b'"') {
        return i;
    }
    i += 1;
    while i < b.len() {
        if b.get(i) == Some(&b'"') && (1..=hashes).all(|k| b.get(i + k) == Some(&b'#')) {
            return i + 1 + hashes;
        }
        i += 1;
    }
    i
}

fn count_dir(dir: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries =
            std::fs::read_dir(&d).map_err(|e| format!("cannot list {}: {e}", d.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|x| x == "rs") {
                // Not every .rs file is UTF-8 (test fixtures); count what reads.
                let bytes = std::fs::read(&path)
                    .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
                total += count_unsafe(&String::from_utf8_lossy(&bytes));
            }
        }
    }
    Ok(total)
}

/// Every registry dependency of both workspaces with its count, summed over
/// the versions the lockfiles hold.
fn measure(root: &Path) -> Result<Counts, Vec<String>> {
    let mut manifests = vec![root.join("Cargo.toml")];
    manifests.extend(NESTED_WORKSPACES.iter().map(|m| root.join(m)));
    let mut seen = BTreeMap::<(String, String), PathBuf>::new();
    for manifest in manifests {
        let output = Command::new(metadata::cargo())
            .args(["metadata", "--format-version", "1", "--locked", "--manifest-path"])
            .arg(&manifest)
            .output()
            .map_err(|e| vec![format!("cargo metadata did not run: {e}")])?;
        if !output.status.success() {
            return Err(vec![format!(
                "cargo metadata --manifest-path {} failed:\n{}",
                manifest.display(),
                String::from_utf8_lossy(&output.stderr)
            )]);
        }
        let meta: FullMetadata = serde_json::from_slice(&output.stdout)
            .map_err(|e| vec![format!("cargo metadata output did not parse: {e}")])?;
        for p in meta.packages {
            if p.source.is_some() {
                let dir = p.manifest_path.parent().map(Path::to_path_buf).unwrap_or_default();
                seen.insert((p.name, p.version), dir);
            }
        }
    }
    let mut counts = BTreeMap::<String, (u64, Vec<String>)>::new();
    for ((name, version), dir) in seen {
        let n = count_dir(&dir).map_err(|e| vec![e])?;
        let slot = counts.entry(name).or_default();
        slot.0 += n;
        slot.1.push(version);
    }
    Ok(counts)
}

pub(crate) fn check(ledger: &Ledger, counts: &Counts) -> Vec<String> {
    let mut v = Vec::new();
    for (name, (count, versions)) in counts {
        let versions = versions.join(", ");
        match ledger.crates.get(name) {
            None if *count > 0 => v.push(format!(
                "{name} {versions}: {count} unsafe tokens and no ledger entry; read them and add one with a reason"
            )),
            Some(e) if *count > e.ceiling => v.push(format!(
                "{name} {versions}: {count} unsafe tokens is over its ceiling of {}; read what arrived and raise the entry with a reason",
                e.ceiling
            )),
            Some(e) if *count < e.ceiling => v.push(format!(
                "{name} {versions}: {count} unsafe tokens is under its ceiling of {}; bank it with `cargo xtask unsafe-ledger --update`",
                e.ceiling
            )),
            // No unsafe and no entry, or a count exactly at its ceiling.
            None | Some(_) => {}
        }
    }
    for (name, e) in &ledger.crates {
        if !counts.contains_key(name) {
            v.push(format!("{name}: in the ledger but no longer in the dependency tree"));
        }
        if e.reason.trim().is_empty() {
            v.push(format!("{name}: ledger entry with no reason"));
        }
        if e.ceiling == 0 {
            v.push(format!("{name}: a ceiling of 0 needs no entry"));
        }
    }
    v
}

/// Lowers ceilings to the measured count and drops entries for crates that
/// left the tree. Never raises one or adds one: that is a decision.
pub(crate) fn lower(ledger: &mut Ledger, counts: &Counts) {
    ledger.crates.retain(|name, _| counts.get(name).is_some_and(|(n, _)| *n > 0));
    for (name, e) in &mut ledger.crates {
        if let Some((n, _)) = counts.get(name) {
            e.ceiling = e.ceiling.min(*n);
        }
    }
}

pub(crate) fn run(mode: Mode) -> Result<Vec<String>, Vec<String>> {
    let meta = metadata::load()?;
    let path = meta.workspace_root.join(LEDGER_PATH);
    let mut ledger: Ledger = metadata::read_json(&path)?;
    let counts = measure(&meta.workspace_root)?;
    if mode == Mode::Update {
        lower(&mut ledger, &counts);
        let text = serde_json::to_string_pretty(&ledger).map_err(|e| vec![e.to_string()])?;
        std::fs::write(&path, format!("{text}\n"))
            .map_err(|e| vec![format!("cannot write {LEDGER_PATH}: {e}")])?;
    }
    let mut v = check(&ledger, &counts);
    let total: u64 = counts.values().map(|(n, _)| n).sum();
    if v.is_empty() {
        Ok(vec![format!(
            "unsafe-ledger: {} registry crates carry {total} unsafe tokens, {} of them ledgered",
            counts.len(),
            ledger.crates.len()
        )])
    } else {
        v.insert(0, format!("unsafe-ledger: {LEDGER_PATH} is violated:"));
        Err(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_the_keyword_and_skips_comments_and_literals() {
        let src = r##"
            // unsafe in a line comment
            /* unsafe /* nested unsafe */ still comment */
            let s = "unsafe \" unsafe";
            let r = r#"unsafe "# ;
            let b = b"unsafe";
            let c = 'u';
            let q = '\'';
            fn f<'a>(x: &'a u8) {}
            let r#unsafe = 1;
            unsafe fn g() {}
            unsafe { g() }
            unsafe impl Send for X {}
            let not_unsafe_ident = 1;
        "##;
        assert_eq!(count_unsafe(src), 3);
    }

    #[test]
    fn a_lifetime_does_not_swallow_the_code_after_it() {
        assert_eq!(count_unsafe("impl<'a> X<'a> { unsafe fn f(&'a self) {} }"), 1);
        assert_eq!(count_unsafe("let c = '\u{e9}'; unsafe {}"), 1);
    }

    fn counts(rows: &[(&str, u64)]) -> Counts {
        rows.iter().map(|(n, c)| ((*n).to_owned(), (*c, vec!["1.0.0".to_owned()]))).collect()
    }

    fn ledger(rows: &[(&str, u64)]) -> Ledger {
        Ledger {
            comment: String::new(),
            crates: rows
                .iter()
                .map(|(n, c)| ((*n).to_owned(), Entry { ceiling: *c, reason: "read".to_owned() }))
                .collect(),
        }
    }

    #[test]
    fn a_matching_ledger_passes_and_a_safe_crate_needs_no_entry() {
        assert_eq!(
            check(&ledger(&[("libc", 10)]), &counts(&[("libc", 10), ("serde", 0)])),
            Vec::<String>::new()
        );
    }

    #[test]
    fn more_unsafe_than_ledgered_fails_and_less_is_stale() {
        let v = check(&ledger(&[("libc", 10), ("cc", 5)]), &counts(&[("libc", 11), ("cc", 4)]));
        assert!(v.iter().any(|l| l.starts_with("libc 1.0.0: 11 unsafe tokens is over")), "{v:?}");
        assert!(v.iter().any(|l| l.starts_with("cc 1.0.0: 4 unsafe tokens is under")), "{v:?}");
    }

    #[test]
    fn the_ledger_is_checked_from_both_sides() {
        let v = check(&ledger(&[("gone", 3)]), &counts(&[("new", 2)]));
        assert!(
            v.iter().any(|l| l.starts_with("new 1.0.0: 2 unsafe tokens and no ledger entry")),
            "{v:?}"
        );
        assert!(
            v.iter().any(|l| l == "gone: in the ledger but no longer in the dependency tree"),
            "{v:?}"
        );
    }

    #[test]
    fn update_lowers_and_drops_but_never_raises_or_adds() {
        let mut l = ledger(&[("libc", 10), ("cc", 5), ("gone", 3)]);
        lower(&mut l, &counts(&[("libc", 12), ("cc", 4), ("new", 7)]));
        assert_eq!(l.crates.get("libc").map(|e| e.ceiling), Some(10));
        assert_eq!(l.crates.get("cc").map(|e| e.ceiling), Some(4));
        assert!(!l.crates.contains_key("gone") && !l.crates.contains_key("new"));
    }

    #[test]
    fn the_checked_in_ledger_parses_and_names_crates_with_reasons() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let l: Ledger = metadata::read_json(&root.join(LEDGER_PATH)).unwrap();
        // The subject is present: the tree already carries wasm-bindgen.
        assert!(l.crates.contains_key("wasm-bindgen"), "{:?}", l.crates.keys());
        assert!(l.crates.values().all(|e| !e.reason.trim().is_empty() && e.ceiling > 0));
    }
}
