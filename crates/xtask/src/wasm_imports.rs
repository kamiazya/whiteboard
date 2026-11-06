//! `cargo xtask wasm-imports`: a core crate compiled to wasm imports nothing.
//!
//! A core crate is pure, so its wasm needs nothing from the host. This is the
//! strongest form of that ban: any reach outside — a C dependency, a
//! JS-backed `getrandom`, a hand-written import — lands in the import section
//! however it was spelled in source. It does NOT see `std::fs` and the other
//! OS calls, which on wasm32-unknown-unknown compile to stubs that fail at
//! runtime and import nothing; `crates/core/clippy.toml` bans those.
//!
//! Each core crate is linked on its own as a cdylib under the `wasm-scan`
//! profile: no LTO (which would internalize and drop every function nothing
//! exports), no strip (so the name section says whose functions survived),
//! and linker garbage collection off. Every function the crate defines, and
//! so every import those functions need, reaches the artifact. The scan
//! counts the crate's OWN functions and fails when no core crate contributed
//! any, because an artifact holding only std passes vacuously.
//!
//! The bindings artifact may import only wasm-bindgen's own placeholder
//! modules, which `wasm-bindgen` rewrites into the JS glue.

use std::path::{Path, PathBuf};
use std::process::Command;

use wasmparser::{KnownCustom, Name, Parser, Payload};

use crate::arch_map::{self, Status, Target};
use crate::metadata::{self, WASM_TARGET};

/// The import modules wasm-bindgen emits and then replaces with its glue.
const WASM_BINDGEN_MODULES: &[&str] = &["__wbindgen_placeholder__", "__wbindgen_externref_xform__"];

/// The bindings crates built as a wasm cdylib in their own right.
pub(crate) const WASM_BINDINGS: &[&str] = &["whiteboard-wasm"];

/// The Cargo profile the core scan links under; see the module comment.
const SCAN_PROFILE: &str = "wasm-scan";

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Scan {
    /// `module::name` of every import.
    pub(crate) imports: Vec<String>,
    pub(crate) defined_functions: u32,
    /// Every name in the name section's function map, imports included.
    pub(crate) function_names: Vec<String>,
}

impl Scan {
    /// Functions whose mangled name carries `lib_name`: the crate's own code,
    /// as opposed to the std and allocator code every artifact links.
    pub(crate) fn own_functions(&self, lib_name: &str) -> usize {
        self.function_names.iter().filter(|n| n.contains(lib_name)).count()
    }
}

pub(crate) fn scan(bytes: &[u8]) -> Result<Scan, String> {
    let mut out = Scan::default();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(|e| format!("not a valid wasm module: {e}"))? {
            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    let import = import.map_err(|e| format!("bad import: {e}"))?;
                    out.imports.push(format!("{}::{}", import.module, import.name));
                }
            }
            Payload::FunctionSection(reader) => out.defined_functions = reader.count(),
            Payload::CustomSection(custom) => {
                if let KnownCustom::Name(names) = custom.as_known() {
                    for name in names {
                        if let Name::Function(map) = name.map_err(|e| format!("bad names: {e}"))? {
                            for naming in map {
                                let naming = naming.map_err(|e| format!("bad name: {e}"))?;
                                out.function_names.push(naming.name.to_owned());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

/// What an artifact may import: nothing for core, wasm-bindgen's modules for
/// a binding.
pub(crate) fn disallowed_imports(scan: &Scan, allowed_modules: &[&str]) -> Vec<String> {
    scan.imports
        .iter()
        .filter(|i| !allowed_modules.iter().any(|m| i.starts_with(&format!("{m}::"))))
        .cloned()
        .collect()
}

/// Where cargo leaves `crate_name`'s wasm for `profile`.
pub(crate) fn artifact(target_dir: &Path, profile: &str, crate_name: &str) -> PathBuf {
    target_dir
        .join(WASM_TARGET)
        .join(profile)
        .join(format!("{}.wasm", crate_name.replace('-', "_")))
}

fn build(args: &[&str]) -> Result<(), Vec<String>> {
    let status = Command::new(metadata::cargo())
        .args(args)
        .status()
        .map_err(|e| vec![format!("cargo did not run: {e}")])?;
    if status.success() { Ok(()) } else { Err(vec![format!("cargo {} failed", args.join(" "))]) }
}

pub(crate) fn run() -> Result<Vec<String>, Vec<String>> {
    let metadata = metadata::load()?;
    let map = arch_map::load_map(&metadata)?;
    let core: Vec<&String> = map
        .crates
        .iter()
        .filter(|(_, c)| {
            c.layer == "core" && c.status == Status::Present && c.targets.contains(&Target::Wasm32)
        })
        .map(|(name, _)| name)
        .collect();
    let mut report = Vec::new();
    let mut violations = Vec::new();
    let mut own_total = 0;
    let mut check = |name: &str, profile: &str, allowed: &[&str]| -> Result<(), Vec<String>> {
        let path = artifact(&metadata.target_directory, profile, name);
        let bytes = std::fs::read(&path)
            .map_err(|e| vec![format!("cannot read {}: {e}", path.display())])?;
        let scan = scan(&bytes).map_err(|e| vec![format!("{name}: {e}")])?;
        if scan.defined_functions == 0 {
            violations
                .push(format!("{name}: the artifact defines no function, so the scan saw nothing"));
        }
        for import in disallowed_imports(&scan, allowed) {
            violations.push(format!("{name}: imports {import}"));
        }
        let own = scan.own_functions(&name.replace('-', "_"));
        own_total += own;
        report.push(format!(
            "  {name}: {} functions ({own} its own), {} imports",
            scan.defined_functions,
            scan.imports.len()
        ));
        Ok(())
    };
    for name in &core {
        build(&[
            "rustc",
            "--quiet",
            "--package",
            name,
            "--target",
            WASM_TARGET,
            "--profile",
            SCAN_PROFILE,
            "--crate-type",
            "cdylib",
            "--",
            "-C",
            "link-arg=--no-gc-sections",
            "-C",
            "link-dead-code",
        ])?;
        check(name, SCAN_PROFILE, &[])?;
    }
    for name in WASM_BINDINGS {
        build(&["build", "--quiet", "--package", name, "--target", WASM_TARGET, "--release"])?;
        check(name, "release", WASM_BINDGEN_MODULES)?;
    }
    if core.is_empty() {
        violations.push("no present core crate targets wasm32, so nothing was scanned".to_owned());
    }
    if own_total == 0 {
        violations.push(
            "no core crate's own function reached its artifact, so the scan saw only std"
                .to_owned(),
        );
    }
    if violations.is_empty() {
        report.insert(0, format!("wasm-imports: {} core crates import nothing", core.len()));
        Ok(report)
    } else {
        violations.insert(0, "wasm-imports: a core artifact reaches the host:".to_owned());
        Err(violations)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // (module (import "env" "now" (func (result f64))) (func) (func))
    const IMPORTS_ENV_NOW: &[u8] = &[
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
        0x01, 0x08, 0x02, 0x60, 0x00, 0x01, 0x7c, 0x60, 0x00, 0x00, // types
        0x02, 0x0b, 0x01, 0x03, b'e', b'n', b'v', 0x03, b'n', b'o', b'w', 0x00,
        0x00, // import
        0x03, 0x03, 0x02, 0x01, 0x01, // functions
        0x0a, 0x07, 0x02, 0x02, 0x00, 0x0b, 0x02, 0x00, 0x0b, // code
    ];

    #[test]
    fn reads_every_import_and_counts_defined_functions() {
        let s = scan(IMPORTS_ENV_NOW).unwrap();
        assert_eq!(s.imports, vec!["env::now".to_owned()]);
        assert_eq!(s.defined_functions, 2);
    }

    #[test]
    fn core_may_import_nothing_and_bindings_only_wasm_bindgen() {
        let s = Scan {
            imports: vec![
                "__wbindgen_placeholder__::__wbindgen_describe".to_owned(),
                "env::now".to_owned(),
            ],
            defined_functions: 1,
            function_names: Vec::new(),
        };
        assert_eq!(disallowed_imports(&s, &[]).len(), 2);
        assert_eq!(disallowed_imports(&s, WASM_BINDGEN_MODULES), vec!["env::now".to_owned()]);
    }

    #[test]
    fn a_module_name_that_merely_starts_like_an_allowed_one_is_refused() {
        let s = Scan {
            imports: vec!["__wbindgen_placeholder__x::f".to_owned()],
            defined_functions: 1,
            function_names: Vec::new(),
        };
        assert_eq!(disallowed_imports(&s, WASM_BINDGEN_MODULES).len(), 1);
    }

    #[test]
    fn own_functions_are_told_apart_from_linked_std() {
        let s = Scan {
            imports: Vec::new(),
            defined_functions: 3,
            function_names: vec![
                "_ZN14whiteboard_det4math5hypot17h0E".to_owned(),
                "_ZN5alloc7raw_vec11finish_grow17h0E".to_owned(),
                "dlmalloc".to_owned(),
            ],
        };
        assert_eq!(s.own_functions("whiteboard_det"), 1);
        assert_eq!(s.own_functions("whiteboard_log"), 0);
    }

    #[test]
    fn garbage_is_an_error_not_an_empty_scan() {
        assert!(scan(b"not wasm").is_err());
    }
}
