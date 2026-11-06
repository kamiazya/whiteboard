//! `cargo xtask repro-check [native|wasm]...`: a release build is
//! reproducible (QR-28e) — built twice, the artifacts are byte-equal.
//!
//! The second build is not just a second run. It is a COPY of the Rust half
//! of the checkout at a different path, built into a different, empty target
//! directory, so anything that leaks a path (the source root, a target
//! directory, `OUT_DIR`) into the bytes shows up as a difference, which a
//! rebuild in place would hide. Both builds go through `cargo xtask dist`,
//! so the flags compared are the flags released. Every file that ships is
//! compared: the native binary, the cargo wasm artifact, and each file
//! wasm-bindgen emits.
//!
//! What it cannot vary locally is the machine: the release workflow runs
//! the two builds in separate jobs and compares their artifacts the same way.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::dist::{self, Artifact};
use crate::metadata;

/// What cargo reads from a checkout to build the workspace.
const RUST_SOURCES: &[&str] =
    &["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/", "crates/"];

/// The first byte offset at which two artifacts differ, or `None`.
pub(crate) fn first_difference(a: &[u8], b: &[u8]) -> Option<usize> {
    a.iter()
        .zip(b)
        .position(|(x, y)| x != y)
        .or_else(|| (a.len() != b.len()).then(|| a.len().min(b.len())))
}

fn copy_rust_sources(root: &Path, dest: &Path) -> Result<usize, Vec<String>> {
    let out = Command::new("git")
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"])
        .args(RUST_SOURCES)
        .current_dir(root)
        .output()
        .map_err(|e| vec![format!("git did not run: {e}")])?;
    if !out.status.success() {
        return Err(vec!["git ls-files failed".to_owned()]);
    }
    let mut copied = 0usize;
    for rel in String::from_utf8_lossy(&out.stdout).split('\0').filter(|s| !s.is_empty()) {
        let from = root.join(rel);
        // A tracked file deleted in the working tree is listed but absent.
        if !from.is_file() {
            continue;
        }
        let to = dest.join(rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| vec![format!("cannot create {}: {e}", parent.display())])?;
        }
        std::fs::copy(&from, &to).map_err(|e| vec![format!("cannot copy {rel}: {e}")])?;
        copied += 1;
    }
    Ok(copied)
}

fn compare(
    a_files: &[PathBuf],
    a_dir: &Path,
    b_files: &[PathBuf],
    b_dir: &Path,
) -> Result<Vec<String>, Vec<String>> {
    let rel = |files: &[PathBuf], dir: &Path| -> Vec<PathBuf> {
        files.iter().map(|f| f.strip_prefix(dir).unwrap_or(f).to_path_buf()).collect()
    };
    let (ra, rb) = (rel(a_files, a_dir), rel(b_files, b_dir));
    if ra != rb {
        return Err(vec![format!("the two builds shipped different file sets: {ra:?} vs {rb:?}")]);
    }
    let mut ok = Vec::new();
    let mut bad = Vec::new();
    for r in &ra {
        let read = |p: PathBuf| {
            std::fs::read(&p).map_err(|e| vec![format!("cannot read {}: {e}", p.display())])
        };
        let (x, y) = (read(a_dir.join(r))?, read(b_dir.join(r))?);
        match first_difference(&x, &y) {
            None => ok.push(format!(
                "repro-check: {} is byte-identical ({} bytes)",
                r.display(),
                x.len()
            )),
            Some(at) => bad.push(format!(
                "{}: the builds differ from byte {at} ({} vs {} bytes)",
                r.display(),
                x.len(),
                y.len()
            )),
        }
    }
    if bad.is_empty() { Ok(ok) } else { Err(bad) }
}

pub(crate) fn run(args: &[&str]) -> Result<Vec<String>, Vec<String>> {
    let artifacts: Vec<Artifact> = if args.is_empty() {
        vec![Artifact::Native, Artifact::Wasm]
    } else {
        args.iter()
            .map(|a| {
                Artifact::parse(a).ok_or_else(|| {
                    vec!["usage: cargo xtask repro-check [native|wasm]...".to_owned()]
                })
            })
            .collect::<Result<_, _>>()?
    };
    let meta = metadata::load()?;
    let base = meta.target_directory.join("repro");
    if base.exists() {
        std::fs::remove_dir_all(&base)
            .map_err(|e| vec![format!("cannot clear {}: {e}", base.display())])?;
    }
    let source_b = base.join("source-b");
    let copied = copy_rust_sources(&meta.workspace_root, &source_b)?;
    let mut lines =
        vec![format!("repro-check: build B is a copy of {copied} files at {}", source_b.display())];
    let mut failures = Vec::new();
    // Build B's copy carries no `.git`, so the checkout answers for both.
    let epoch = dist::source_date_epoch(&meta.workspace_root)?;
    for artifact in artifacts {
        let (dir_a, dir_b) = (base.join("target-a"), base.join("target-b"));
        let a = dist::build(&meta.workspace_root, &dir_a, artifact, &epoch)?;
        let b = dist::build(&source_b, &dir_b, artifact, &epoch)?;
        match compare(&a, &dir_a, &b, &dir_b) {
            Ok(ok) => lines.extend(ok),
            Err(bad) => failures.extend(bad),
        }
    }
    if failures.is_empty() {
        Ok(lines)
    } else {
        failures.insert(0, "repro-check: a release build is not reproducible:".to_owned());
        Err(failures)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_difference_is_found_including_a_length_difference() {
        assert_eq!(first_difference(b"abc", b"abc"), None);
        assert_eq!(first_difference(b"abc", b"abd"), Some(2));
        assert_eq!(first_difference(b"abc", b"abcd"), Some(3));
        assert_eq!(first_difference(b"", b""), None);
    }
}
