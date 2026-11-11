//! `cargo xtask dist native|wasm [--target-dir <dir>]`: the release build of
//! a shipped artifact, in the one environment every release gate checks.
//!
//! What makes it a release build rather than `cargo build --release`:
//!
//! - **Paths remapped** (`--remap-path-prefix`): the checkout, `CARGO_HOME`
//!   and the target directory become `/whiteboard`, `/cargo` and `/target`,
//!   so a panic location or a build script's `OUT_DIR` does not bake one
//!   machine's paths into the bytes (QR-28e).
//! - **`SOURCE_DATE_EPOCH`** set to the commit time, for any build script
//!   that stamps a date. **`CARGO_INCREMENTAL=0`**: incremental artifacts are
//!   neither reproducible nor what a release ships.
//! - **Native**: built through `cargo auditable` so the binary embeds its
//!   dependency list (`.dep-v0`), with the `dist-native` profile and
//!   `-C relocation-model=pie -C relro-level=full` pinned explicitly — both
//!   are rustc's defaults on Linux today (measured: PIE, `DT_BIND_NOW`,
//!   `PT_GNU_RELRO` with no flags), and pinning them keeps a default change or a
//!   stray `RUSTFLAGS` from silently dropping them. `harden-check` is what
//!   proves they held.
//! - **Wasm**: the release profile for `wasm32-unknown-unknown`, then
//!   `wasm-bindgen` at the version Cargo.toml pins, with the name and
//!   producers sections removed. `pnpm rust:build:wasm` is this build, and
//!   `cargo xtask size` measures what it writes, so the ledgered bytes are
//!   the shipped ones. `dist wasm --oracle` is the same build with the
//!   `oracle-surface` feature, into `target/dist-oracle`, for the layer-2 test
//!   lanes: it carries the per-module test exports no shipped artifact has.
//!
//! `RUSTFLAGS` from the caller's environment is ignored: these flags are the
//! whole set, passed as `CARGO_ENCODED_RUSTFLAGS`.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::metadata::{self, WASM_TARGET};

pub(crate) const NATIVE_PACKAGE: &str = "whiteboard-native-fixture";
pub(crate) const WASM_PACKAGE: &str = "whiteboard-wasm";
const AUDITABLE_INSTALL: &str = "cargo install --locked cargo-auditable --version 0.7.7";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Artifact {
    Native,
    Wasm,
    /// The wasm the layer-2 test lanes load: the shipped build plus the
    /// `oracle-surface` feature's test exports. Never shipped, never measured
    /// by `size` or `repro-check`, and built apart from the shipped one.
    WasmOracle,
}

impl Artifact {
    pub(crate) fn parse(s: &str) -> Option<Self> {
        match s {
            "native" => Some(Self::Native),
            "wasm" => Some(Self::Wasm),
            _ => None,
        }
    }
}

/// The rustflags of a release build from `root` into `target_dir`.
pub(crate) fn rustflags(
    root: &Path,
    cargo_home: &Path,
    target_dir: &Path,
    artifact: Artifact,
) -> Vec<String> {
    let mut flags = vec![
        format!("--remap-path-prefix={}=/whiteboard", root.display()),
        format!("--remap-path-prefix={}=/cargo", cargo_home.display()),
        format!("--remap-path-prefix={}=/target", target_dir.display()),
    ];
    if artifact == Artifact::Native {
        flags.extend(["-Crelocation-model=pie".to_owned(), "-Crelro-level=full".to_owned()]);
    }
    flags
}

/// Where `dist` builds when no `--target-dir` is given: apart from the dev
/// builds, whose rustflags differ.
pub(crate) fn default_target_dir(target_directory: &Path) -> PathBuf {
    target_directory.join("dist")
}

/// Where `dist wasm --oracle` builds by default: beside the shipped build, so
/// neither overwrites the other.
fn oracle_target_dir(target_directory: &Path) -> PathBuf {
    target_directory.join("dist-oracle")
}

fn cargo_home() -> PathBuf {
    std::env::var_os("CARGO_HOME").map_or_else(
        || PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".cargo"),
        PathBuf::from,
    )
}

pub(crate) fn source_date_epoch(root: &Path) -> Result<String, Vec<String>> {
    if let Ok(v) = std::env::var("SOURCE_DATE_EPOCH") {
        return Ok(v);
    }
    let out = Command::new("git")
        .args(["log", "-1", "--format=%ct"])
        .current_dir(root)
        .output()
        .map_err(|e| vec![format!("git did not run: {e}")])?;
    let epoch = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if !out.status.success() || epoch.is_empty() {
        return Err(vec![
            "SOURCE_DATE_EPOCH is unset and git cannot name the commit time".to_owned(),
        ]);
    }
    Ok(epoch)
}

fn run(cmd: &mut Command) -> Result<(), Vec<String>> {
    let shown = format!("{cmd:?}");
    let status = cmd.status().map_err(|e| vec![format!("{shown} did not run: {e}")])?;
    if status.success() { Ok(()) } else { Err(vec![format!("{shown} failed: {status}")]) }
}

/// Builds `artifact` from the workspace at `root` into `target_dir` and
/// returns every file that ships. `epoch` is the `SOURCE_DATE_EPOCH` it is
/// stamped with: the caller resolves it, because a root may be a copy of the
/// sources with no `.git` to ask (`repro-check`'s build B).
pub(crate) fn build(
    root: &Path,
    target_dir: &Path,
    artifact: Artifact,
    epoch: &str,
) -> Result<Vec<PathBuf>, Vec<String>> {
    let mut cargo = Command::new(metadata::cargo());
    cargo
        .current_dir(root)
        .env_remove("RUSTFLAGS")
        .env(
            "CARGO_ENCODED_RUSTFLAGS",
            rustflags(root, &cargo_home(), target_dir, artifact).join("\u{1f}"),
        )
        .env("SOURCE_DATE_EPOCH", epoch)
        .env("CARGO_INCREMENTAL", "0");
    match artifact {
        Artifact::Native => {
            let probe = Command::new(metadata::cargo()).args(["auditable", "--version"]).output();
            if !probe.is_ok_and(|o| o.status.success()) {
                return Err(vec![format!(
                    "dist native: cargo-auditable is not installed. Install it with:\n  {AUDITABLE_INSTALL}"
                )]);
            }
            cargo.args([
                "auditable",
                "build",
                "--locked",
                "--package",
                NATIVE_PACKAGE,
                "--profile",
                "dist-native",
            ]);
            run(cargo.arg("--target-dir").arg(target_dir))?;
            Ok(vec![target_dir.join("dist-native").join(NATIVE_PACKAGE)])
        }
        Artifact::Wasm | Artifact::WasmOracle => {
            check_bindgen_version(root)?;
            cargo.args(wasm_build_args(artifact));
            run(cargo.arg("--target-dir").arg(target_dir))?;
            bindgen(target_dir)
        }
    }
}

/// Runs wasm-bindgen over the release cargo artifact in `target_dir` and
/// returns every file that ships: the cargo artifact, then what it emitted.
fn bindgen(target_dir: &Path) -> Result<Vec<PathBuf>, Vec<String>> {
    let wasm = target_dir.join(WASM_TARGET).join("release").join("whiteboard_wasm.wasm");
    let out = target_dir.join("wasm-bindgen").join(WASM_PACKAGE);
    run(Command::new("wasm-bindgen")
        .args([
            "--target",
            "web",
            "--remove-name-section",
            "--remove-producers-section",
            "--out-dir",
        ])
        .arg(&out)
        .arg(&wasm))?;
    let mut emitted: Vec<PathBuf> = std::fs::read_dir(&out)
        .map_err(|e| vec![format!("cannot list {}: {e}", out.display())])?
        .flatten()
        .map(|e| e.path())
        .collect();
    emitted.sort();
    Ok(std::iter::once(wasm).chain(emitted).collect())
}

fn check_bindgen_version(root: &Path) -> Result<(), Vec<String>> {
    let manifest = std::fs::read_to_string(root.join("Cargo.toml"))
        .map_err(|e| vec![format!("cannot read Cargo.toml: {e}")])?;
    let pinned = manifest
        .lines()
        .find_map(|l| l.strip_prefix("wasm-bindgen = \"=")?.strip_suffix('"'))
        .ok_or_else(|| vec!["Cargo.toml no longer pins wasm-bindgen with `=`".to_owned()])?;
    let installed = Command::new("wasm-bindgen").arg("--version").output().ok().map(|o| {
        String::from_utf8_lossy(&o.stdout).split_whitespace().nth(1).unwrap_or_default().to_owned()
    });
    if installed.as_deref() == Some(pinned) {
        Ok(())
    } else {
        Err(vec![format!(
            "wasm-bindgen-cli {pinned} is required, found {}. Install it with:\n  cargo install --locked wasm-bindgen-cli --version {pinned}",
            installed.unwrap_or_else(|| "none".to_owned())
        )])
    }
}

/// The cargo arguments of a wasm build: the shipped one, or the oracle one
/// with the `oracle-surface` feature's test exports.
fn wasm_build_args(artifact: Artifact) -> Vec<&'static str> {
    let mut args =
        vec!["build", "--locked", "--package", WASM_PACKAGE, "--target", WASM_TARGET, "--release"];
    if artifact == Artifact::WasmOracle {
        args.extend(["--features", "oracle-surface"]);
    }
    args
}

/// `dist`'s arguments: the artifact, and the target directory when one was
/// named (`None` takes the artifact's default, `default_dir_for`).
fn parse_args(args: &[&str]) -> Option<(Artifact, Option<PathBuf>)> {
    let (mut artifact, mut rest) = match args {
        [a, rest @ ..] => (Artifact::parse(a)?, rest),
        [] => return None,
    };
    if let ["--oracle", after @ ..] = rest {
        if artifact != Artifact::Wasm {
            return None;
        }
        artifact = Artifact::WasmOracle;
        rest = after;
    }
    match rest {
        [] => Some((artifact, None)),
        ["--target-dir", dir] => Some((artifact, Some(PathBuf::from(dir)))),
        _ => None,
    }
}

/// Where `artifact` builds when no `--target-dir` is named.
fn default_dir_for(artifact: Artifact, target_directory: &Path) -> PathBuf {
    if artifact == Artifact::WasmOracle {
        oracle_target_dir(target_directory)
    } else {
        default_target_dir(target_directory)
    }
}

pub(crate) fn run_task(args: &[&str]) -> Result<Vec<String>, Vec<String>> {
    let usage =
        || vec!["usage: cargo xtask dist native|wasm [--oracle] [--target-dir <dir>]".to_owned()];
    let (artifact, named) = parse_args(args).ok_or_else(usage)?;
    let meta = metadata::load()?;
    let target_dir = named.unwrap_or_else(|| default_dir_for(artifact, &meta.target_directory));
    let epoch = source_date_epoch(&meta.workspace_root)?;
    let files = build(&meta.workspace_root, &target_dir, artifact, &epoch)?;
    Ok(files.iter().map(|f| format!("dist: {}", f.display())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_machine_path_is_remapped_and_native_pins_its_mitigations() {
        let f = rustflags(
            Path::new("/src/wb"),
            Path::new("/home/u/.cargo"),
            Path::new("/t"),
            Artifact::Native,
        );
        assert_eq!(
            f,
            [
                "--remap-path-prefix=/src/wb=/whiteboard",
                "--remap-path-prefix=/home/u/.cargo=/cargo",
                "--remap-path-prefix=/t=/target",
                "-Crelocation-model=pie",
                "-Crelro-level=full",
            ]
        );
        let w = rustflags(Path::new("/src/wb"), Path::new("/c"), Path::new("/t"), Artifact::Wasm);
        assert_eq!(w.len(), 3, "{w:?}");
    }

    #[test]
    fn the_oracle_flag_is_wasm_only_and_selects_its_own_directory() {
        assert_eq!(parse_args(&["wasm"]), Some((Artifact::Wasm, None)));
        assert_eq!(parse_args(&["wasm", "--oracle"]), Some((Artifact::WasmOracle, None)));
        assert_eq!(
            parse_args(&["wasm", "--oracle", "--target-dir", "/t"]),
            Some((Artifact::WasmOracle, Some(PathBuf::from("/t"))))
        );
        assert_eq!(parse_args(&["native"]), Some((Artifact::Native, None)));
        assert_eq!(parse_args(&["native", "--oracle"]), None);
        assert_eq!(parse_args(&["wasm", "--target-dir"]), None);
        assert_eq!(parse_args(&[]), None);
        let target = Path::new("/target");
        assert_eq!(default_dir_for(Artifact::WasmOracle, target), target.join("dist-oracle"));
        assert_eq!(default_dir_for(Artifact::Wasm, target), target.join("dist"));
        assert_eq!(default_dir_for(Artifact::Native, target), target.join("dist"));
    }

    #[test]
    fn only_the_oracle_build_turns_the_test_exports_on() {
        let feature =
            |a| wasm_build_args(a).windows(2).any(|w| w == ["--features", "oracle-surface"]);
        assert!(feature(Artifact::WasmOracle));
        assert!(!feature(Artifact::Wasm));
        assert!(wasm_build_args(Artifact::Wasm).contains(&"--release"));
    }
}
