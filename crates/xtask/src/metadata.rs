//! The workspace as cargo reports it, and the paths every task resolves.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub(crate) struct Metadata {
    pub(crate) packages: Vec<Package>,
    pub(crate) workspace_members: Vec<String>,
    pub(crate) workspace_root: PathBuf,
    pub(crate) target_directory: PathBuf,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Package {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) manifest_path: PathBuf,
    pub(crate) dependencies: Vec<Dependency>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Dependency {
    pub(crate) name: String,
    /// `None` for a normal dependency, `"dev"` or `"build"` otherwise.
    pub(crate) kind: Option<String>,
}

impl Dependency {
    pub(crate) fn is_dev(&self) -> bool {
        self.kind.as_deref() == Some("dev")
    }
}

impl Metadata {
    pub(crate) fn members(&self) -> impl Iterator<Item = &Package> {
        self.packages.iter().filter(|p| self.workspace_members.contains(&p.id))
    }

    /// A member's directory relative to the workspace root, `/`-separated.
    pub(crate) fn relative_dir(&self, package: &Package) -> String {
        let dir = package.manifest_path.parent().unwrap_or(Path::new(""));
        let rel = dir.strip_prefix(&self.workspace_root).unwrap_or(dir);
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/")
    }
}

pub(crate) fn load() -> Result<Metadata, Vec<String>> {
    let output = Command::new(cargo())
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .output()
        .map_err(|e| vec![format!("cargo metadata did not run: {e}")])?;
    if !output.status.success() {
        return Err(vec![format!(
            "cargo metadata failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        )]);
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| vec![format!("cargo metadata output did not parse: {e}")])
}

/// The cargo that invoked this task, so a pinned toolchain stays pinned.
pub(crate) fn cargo() -> String {
    std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned())
}

pub(crate) const WASM_TARGET: &str = "wasm32-unknown-unknown";

pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, Vec<String>> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| vec![format!("cannot read {}: {e}", path.display())])?;
    serde_json::from_str(&text).map_err(|e| vec![format!("{} does not parse: {e}", path.display())])
}
