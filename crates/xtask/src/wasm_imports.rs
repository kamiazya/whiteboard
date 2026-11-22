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
//! modules, which `wasm-bindgen` rewrites into the JS glue, and of what those
//! carry, wasm-bindgen's intrinsics and exactly the host imports
//! [`HOST_IMPORTS`] declares: a hand-written `extern` is a call back into the
//! host mid-operation, which ADR-0054 admits one at a time.

use std::path::{Path, PathBuf};
use std::process::Command;

use wasmparser::{KnownCustom, Name, Parser, Payload};

use crate::arch_map::{self, Status, Target};
use crate::metadata::{self, WASM_TARGET};

/// The import modules wasm-bindgen emits and then replaces with its glue.
const WASM_BINDGEN_MODULES: &[&str] = &["__wbindgen_placeholder__", "__wbindgen_externref_xform__"];

/// The JavaScript functions the bindings call back into, by the name
/// wasm-bindgen gives their import (`__wbg_<name>_<hash>`). `measure` is the
/// host's measurer a host-measured layout asks mid-layout (ADR-0054 step 7,
/// owner decision q77: the browser measures with a canvas context nothing in
/// the core repeats, and the crossing measured under 1.3% of a layout).
const HOST_IMPORTS: &[&str] = &["measure"];

/// Core crates whose wasm32 build may import wasm-bindgen's placeholder
/// modules, each with why. This is the one scoped break of the zero-import
/// rule: `loro-internal` depends on `wasm-bindgen`, `js-sys` and
/// `getrandom`'s `js` backend unconditionally on wasm32 (a peer id is random
/// per document), so the crate that owns the CRDT cannot build without them.
/// An allowance is not a host contract: the artifact that links such a crate
/// must supply the randomness and the clock from its host (a later, separate
/// CRDT artifact; the shipped `whiteboard-wasm` does not link it). It is held
/// from both sides: a crate whose scan makes no import from its modules, or
/// that is no longer a scanned core crate, fails as a stale entry.
pub(crate) const CORE_IMPORT_ALLOWANCES: &[(&str, &[&str])] =
    &[("whiteboard-crdt", WASM_BINDGEN_MODULES)];

/// The modules `name`, a core crate, may import from.
pub(crate) fn core_allowance(name: &str) -> &'static [&'static str] {
    CORE_IMPORT_ALLOWANCES.iter().find(|(n, _)| *n == name).map_or(&[], |(_, modules)| modules)
}

/// An allowance the scan shows unused: no import comes from any of `modules`.
pub(crate) fn unused_allowance(scan: &Scan, modules: &[&str]) -> bool {
    !modules.is_empty()
        && !scan.imports.iter().any(|i| modules.iter().any(|m| i.starts_with(&format!("{m}::"))))
}

/// An allowance naming a crate that is not a scanned core crate.
pub(crate) fn orphan_allowances(core: &[&String]) -> Vec<&'static str> {
    CORE_IMPORT_ALLOWANCES
        .iter()
        .map(|(n, _)| *n)
        .filter(|n| !core.iter().any(|c| c.as_str() == *n))
        .collect()
}

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

/// The JavaScript function a wasm-bindgen import calls, when it is one a
/// binding declared rather than one of wasm-bindgen's intrinsics.
fn host_import(import: &str) -> Option<&str> {
    let name = import.strip_prefix("__wbindgen_placeholder__::__wbg_")?;
    let (name, hash) = name.rsplit_once('_')?;
    (hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some(name)
}

/// What differs between the host imports `scan` makes and `declared`, both
/// ways: one nothing declared, and one declared that no longer exists.
pub(crate) fn host_import_drift(scan: &Scan, declared: &[&str]) -> Vec<String> {
    let made: Vec<&str> = scan.imports.iter().filter_map(|i| host_import(i)).collect();
    let undeclared = made.iter().filter(|m| !declared.contains(m));
    let unmade = declared.iter().filter(|d| !made.contains(d));
    undeclared
        .map(|m| format!("calls back into the host's `{m}`, which HOST_IMPORTS does not declare"))
        .chain(unmade.map(|d| format!("declares the host import `{d}`, which it no longer makes")))
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

/// The present core crates that target wasm32, in map order.
pub(crate) fn wasm_core_crates(map: &arch_map::ArchMap) -> Vec<&String> {
    map.crates
        .iter()
        .filter(|(_, c)| {
            c.layer == "core" && c.status == Status::Present && c.targets.contains(&Target::Wasm32)
        })
        .map(|(name, _)| name)
        .collect()
}

/// What is wrong with one artifact's scan.
fn judge(name: &str, scan: &Scan, allowed: &[&str], host: &[&str]) -> Vec<String> {
    let mut found = Vec::new();
    if scan.defined_functions == 0 {
        found.push(format!("{name}: the artifact defines no function, so the scan saw nothing"));
    }
    for import in disallowed_imports(scan, allowed) {
        found.push(format!("{name}: imports {import}"));
    }
    // An allowed core crate's imports are the whole of wasm-bindgen's surface
    // that its dependency tree reaches, not declared calls.
    if core_allowance(name).is_empty() {
        for drift in host_import_drift(scan, host) {
            found.push(format!("{name}: {drift}"));
        }
    }
    if unused_allowance(scan, core_allowance(name)) {
        found.push(format!("{name}: CORE_IMPORT_ALLOWANCES allows imports it no longer makes"));
    }
    found
}

pub(crate) fn run() -> Result<Vec<String>, Vec<String>> {
    let metadata = metadata::load()?;
    let map = arch_map::load_map(&metadata)?;
    let core = wasm_core_crates(&map);
    let mut report = Vec::new();
    let mut violations = Vec::new();
    let mut own_total = 0;
    let mut check =
        |name: &str, profile: &str, allowed: &[&str], host: &[&str]| -> Result<(), Vec<String>> {
            let path = artifact(&metadata.target_directory, profile, name);
            let bytes = std::fs::read(&path)
                .map_err(|e| vec![format!("cannot read {}: {e}", path.display())])?;
            let scan = scan(&bytes).map_err(|e| vec![format!("{name}: {e}")])?;
            violations.extend(judge(name, &scan, allowed, host));
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
        check(name, SCAN_PROFILE, core_allowance(name), &[])?;
    }
    for name in WASM_BINDINGS {
        build(&["build", "--quiet", "--package", name, "--target", WASM_TARGET, "--release"])?;
        check(name, "release", WASM_BINDGEN_MODULES, HOST_IMPORTS)?;
    }
    for orphan in orphan_allowances(&core) {
        violations
            .push(format!("{orphan}: CORE_IMPORT_ALLOWANCES names a crate that is not scanned"));
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
        report.insert(
            0,
            format!(
                "wasm-imports: {} core crates import nothing beyond CORE_IMPORT_ALLOWANCES",
                core.len()
            ),
        );
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

    fn importing(imports: &[&str]) -> Scan {
        Scan {
            imports: imports.iter().map(|i| (*i).to_owned()).collect(),
            defined_functions: 1,
            function_names: Vec::new(),
        }
    }

    #[test]
    fn a_binding_calls_back_into_exactly_the_host_imports_it_declares() {
        let measure = "__wbindgen_placeholder__::__wbg_measure_0c4558f2c27659b4";
        let intrinsic = "__wbindgen_placeholder__::__wbindgen_object_drop_ref";
        assert!(host_import_drift(&importing(&[intrinsic, measure]), &["measure"]).is_empty());
        let unmade = host_import_drift(&importing(&[intrinsic]), &["measure"]);
        assert_eq!(unmade, vec!["declares the host import `measure`, which it no longer makes"]);
        let now = "__wbindgen_placeholder__::__wbg_now_00000000000000ff";
        let undeclared = host_import_drift(&importing(&[measure, now]), &["measure"]);
        assert_eq!(undeclared.len(), 1);
        assert!(undeclared[0].contains("`now`"), "{undeclared:?}");
    }

    #[test]
    fn only_a_wasm_bindgen_import_with_its_hash_names_a_host_function() {
        assert_eq!(
            host_import("__wbindgen_placeholder__::__wbg_get_item_0123456789abcdef"),
            Some("get_item")
        );
        assert_eq!(host_import("__wbindgen_placeholder__::__wbg_measure_0c4558f2"), None);
        assert_eq!(host_import("__wbindgen_placeholder__::__wbg_measure_0c4558f2c27659bz"), None);
        assert_eq!(host_import("env::__wbg_measure_0c4558f2c27659b4"), None);
        assert_eq!(host_import("__wbindgen_placeholder__::__wbindgen_describe"), None);
    }

    #[test]
    fn only_the_crate_with_an_allowance_may_import_and_only_from_its_modules() {
        assert_eq!(core_allowance("whiteboard-crdt"), WASM_BINDGEN_MODULES);
        assert!(core_allowance("whiteboard-det").is_empty());
        let s = importing(&["__wbindgen_placeholder__::__wbindgen_throw", "env::now"]);
        assert_eq!(
            disallowed_imports(&s, core_allowance("whiteboard-crdt")),
            vec!["env::now".to_owned()]
        );
        assert_eq!(disallowed_imports(&s, core_allowance("whiteboard-det")).len(), 2);
    }

    #[test]
    fn an_allowance_nothing_uses_is_stale() {
        let used = importing(&["__wbindgen_externref_xform__::__wbindgen_externref_table_grow"]);
        assert!(!unused_allowance(&used, WASM_BINDGEN_MODULES));
        assert!(unused_allowance(&importing(&[]), WASM_BINDGEN_MODULES));
        assert!(unused_allowance(&importing(&["env::now"]), WASM_BINDGEN_MODULES));
        assert!(!unused_allowance(&importing(&[]), &[]));
    }

    #[test]
    fn an_allowance_for_a_crate_that_is_not_scanned_is_an_orphan() {
        let det = "whiteboard-det".to_owned();
        let crdt = "whiteboard-crdt".to_owned();
        assert_eq!(orphan_allowances(&[&det]), vec!["whiteboard-crdt"]);
        assert!(orphan_allowances(&[&det, &crdt]).is_empty());
    }

    #[test]
    fn an_allowed_crate_is_judged_by_its_modules_and_its_staleness_not_by_host_imports() {
        let used = importing(&["__wbindgen_placeholder__::__wbg_now_00000000000000ff"]);
        assert!(judge("whiteboard-crdt", &used, WASM_BINDGEN_MODULES, &[]).is_empty());
        let stale = judge("whiteboard-crdt", &importing(&[]), WASM_BINDGEN_MODULES, &[]);
        assert_eq!(stale.len(), 1);
        assert!(stale[0].contains("no longer makes"), "{stale:?}");
        let other = judge("whiteboard-det", &used, &[], &[]);
        assert_eq!(other.len(), 2, "{other:?}");
    }

    #[test]
    fn garbage_is_an_error_not_an_empty_scan() {
        assert!(scan(b"not wasm").is_err());
    }
}
