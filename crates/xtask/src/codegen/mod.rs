//! `cargo xtask codegen [--check]`: Zod source and serde types from the
//! JSON Schema contracts under `contracts/` (ADR-0054 decision 8).
//!
//! Both halves come from this one emitter. typify, spiked for the Rust half,
//! enforced no numeric bound, counted `maxLength` in code points, ignored the
//! `x-wb-*` keywords and emitted fields alphabetically, so it could not hold
//! the dialect (ADR-0054, "The generator spike"). What the dialect accepts is
//! `dialect.rs`; what each construct becomes in each language is `emit.rs`.
//!
//! `--check` regenerates in memory and fails on any difference from the
//! checked-in output, on a file under a `generated` directory that no
//! contract produces, and on a Rust output its crate does not compile — so a
//! hand edit to generated code fails, and so does generated code nothing
//! builds.

mod dialect;
mod emit;

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::metadata;

const CONTRACTS_DIR: &str = "contracts";
const SCHEMA_SUFFIX: &str = ".schema.json";
/// Where generated code may live, as `(root, directories between it and src)`:
/// `packages/<pkg>/src/generated` and `crates/<layer>/<crate>/src/generated`.
/// `dialect.rs` holds every target to these shapes.
const GENERATED_ROOTS: &[(&str, usize)] = &[("packages", 1), ("crates", 2)];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Mode {
    Write,
    Check,
}

/// Every output a contract produces, as `(repo-relative path, content, is the
/// Rust half)`, the Rust half not yet formatted.
fn generate(
    contract: &dialect::Contract,
    source: &str,
) -> Result<Vec<(String, String, bool)>, Vec<String>> {
    let prefix = |v: Vec<String>| -> Vec<String> {
        v.into_iter().map(|e| format!("{source}: {e}")).collect()
    };
    let checked = dialect::check(contract).map_err(prefix)?;
    let zod = emit::zod(&checked, source).map_err(prefix)?;
    Ok(vec![
        (contract.emit.zod.clone(), zod, false),
        (contract.emit.rust.clone(), emit::rust(&checked, source), true),
    ])
}

/// rustfmt under the workspace's `rustfmt.toml`, so the checked-in Rust is
/// what `cargo fmt --check` expects whatever the contract holds.
fn rustfmt(root: &Path, text: &str) -> Result<String, String> {
    let mut child = Command::new("rustfmt")
        .args(["--edition", "2024", "--emit", "stdout", "--config-path"])
        .arg(root.join("rustfmt.toml"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run rustfmt: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).map_err(|e| format!("cannot feed rustfmt: {e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| format!("rustfmt: {e}"))?;
    if out.status.success() {
        String::from_utf8(out.stdout).map_err(|e| format!("rustfmt: {e}"))
    } else {
        Err(format!("rustfmt refused the output: {}", String::from_utf8_lossy(&out.stderr)))
    }
}

fn read_dir(dir: &Path) -> Result<Vec<std::fs::DirEntry>, String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    entries.collect::<Result<_, _>>().map_err(|e| format!("cannot read {}: {e}", dir.display()))
}

/// Directories only: a symlink is neither walked nor followed.
fn is_dir(entry: &std::fs::DirEntry) -> Result<bool, String> {
    entry
        .file_type()
        .map(|t| t.is_dir())
        .map_err(|e| format!("cannot stat {}: {e}", entry.path().display()))
}

fn contract_files(root: &Path) -> Result<Vec<PathBuf>, Vec<String>> {
    let mut found = Vec::new();
    let mut stack = vec![root.join(CONTRACTS_DIR)];
    while let Some(dir) = stack.pop() {
        for entry in read_dir(&dir).map_err(|e| vec![e])? {
            let path = entry.path();
            if is_dir(&entry).map_err(|e| vec![e])? {
                stack.push(path);
            } else if path.to_string_lossy().ends_with(SCHEMA_SUFFIX) {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

/// Every file under a `generated` directory, repo-relative.
fn generated_files(root: &Path) -> Result<BTreeSet<String>, Vec<String>> {
    let mut files = BTreeSet::new();
    for (top, depth) in GENERATED_ROOTS {
        let mut dirs = vec![root.join(top)];
        for _ in 0..*depth {
            let mut next = Vec::new();
            for dir in &dirs {
                for entry in read_dir(dir).map_err(|e| vec![e])? {
                    if is_dir(&entry).map_err(|e| vec![e])? {
                        next.push(entry.path());
                    }
                }
            }
            dirs = next;
        }
        for dir in dirs {
            let generated = dir.join("src").join("generated");
            if !generated.exists() {
                continue;
            }
            for entry in read_dir(&generated).map_err(|e| vec![e])? {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    files.insert(rel.to_string_lossy().into_owned());
                }
            }
        }
    }
    Ok(files)
}

/// A Rust output its crate never names is generated code nothing compiles:
/// its `src/lib.rs` must reach it as a `#[path = "generated/<file>"]` module.
fn declared_in_crate(root: &Path, target: &str) -> Result<(), String> {
    let (krate, file) = target.split_once("/src/generated/").ok_or("not under src/generated")?;
    let lib = root.join(krate).join("src/lib.rs");
    let text =
        std::fs::read_to_string(&lib).map_err(|e| format!("cannot read {}: {e}", lib.display()))?;
    if text.contains(&format!("#[path = \"generated/{file}\"]")) {
        Ok(())
    } else {
        Err(format!("{krate}/src/lib.rs declares no `#[path = \"generated/{file}\"]` module"))
    }
}

/// Every contract's outputs, keyed by repo-relative target path, formatted.
fn generate_all(root: &Path) -> Result<BTreeMap<String, String>, Vec<String>> {
    let mut outputs = BTreeMap::new();
    let mut v = Vec::new();
    for path in contract_files(root)? {
        let source = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
        let text = std::fs::read_to_string(&path)
            .map_err(|e| vec![format!("cannot read {source}: {e}")])?;
        let files = dialect::parse(&text)
            .map_err(|e| vec![format!("{source}: {e}")])
            .and_then(|contract| generate(&contract, &source));
        for (target, content, is_rust) in files.unwrap_or_else(|errors| {
            v.extend(errors);
            Vec::new()
        }) {
            let content = if is_rust {
                match declared_in_crate(root, &target).and_then(|()| rustfmt(root, &content)) {
                    Ok(formatted) => formatted,
                    Err(e) => {
                        v.push(format!("{target}: {e}"));
                        continue;
                    }
                }
            } else {
                content
            };
            if outputs.insert(target.clone(), content).is_some() {
                v.push(format!("{source}: {target} is also another contract's output"));
            }
        }
    }
    if v.is_empty() { Ok(outputs) } else { Err(v) }
}

pub(crate) fn run(mode: Mode) -> Result<Vec<String>, Vec<String>> {
    let root = metadata::load()?.workspace_root;
    let outputs = generate_all(&root)?;
    let mut v = Vec::new();
    for (target, content) in &outputs {
        let path = root.join(target);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(content.as_str()) {
            continue;
        }
        match mode {
            Mode::Check => v.push(format!(
                "{target}: not what its contract generates; run `cargo xtask codegen`"
            )),
            Mode::Write => {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)
                        .map_err(|e| vec![format!("cannot create {}: {e}", dir.display())])?;
                }
                std::fs::write(&path, content)
                    .map_err(|e| vec![format!("cannot write {target}: {e}")])?;
            }
        }
    }
    for stray in generated_files(&root)? {
        if !outputs.contains_key(&stray) {
            v.push(format!("{stray}: under a generated directory, but no contract produces it"));
        }
    }
    if v.is_empty() {
        Ok(vec![format!("codegen: {} generated files match their contracts", outputs.len())])
    } else {
        Err(v)
    }
}

#[cfg(test)]
mod tests;
