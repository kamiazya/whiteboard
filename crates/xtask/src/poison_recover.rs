//! `cargo xtask poison-recover`: the scenario that proves the wasm panic
//! policy's safety net (ADR-0054 decision 20), and a refusal to pretend it
//! has run.
//!
//! The release profile builds wasm with `panic = "abort"`, so a panic traps
//! (`unreachable`) and the instance is unusable from then on. Panics are
//! prevented by the lints; when one happens anyway, the JavaScript shim
//! that owns the instance (`packages/core-wasm`, which does not exist yet)
//! must discard it, re-instantiate, and REHYDRATE from persisted state. That
//! is a property of the shim, so it can only be tested once the shim
//! exists. Until then this task prints the scenario and FAILS: a stub that
//! passed would read exactly like a recovery that had been proven.
//!
//! When `packages/core-wasm` lands, the unit test below fails, and this task
//! is replaced by the real test (one per runtime) that runs [`SCENARIO`].

use std::path::Path;

use crate::metadata;

pub(crate) const SHIM_DIR: &str = "packages/core-wasm";

/// The scenario, step by step. Each step is an assertion the real test makes.
pub(crate) const SCENARIO: &[&str] = &[
    "1. Persist a workspace with one document through the shim, then load it, so the instance holds state that also exists in storage.",
    "2. Call a panicking export that exists only under a `poison-test` cargo feature (never in a release artifact); the call rejects with a WebAssembly.RuntimeError from the abort trap, and the caller receives a typed refusal, not the raw trap.",
    "3. The shim marks the instance poisoned: no later call reaches it (a spy on the old instance's exports records zero calls after the trap).",
    "4. The next call re-instantiates and rehydrates: the document read back is byte-identical to the persisted one, and an operation that had not been persisted before the trap is reported lost to its caller, never silently replayed.",
    "5. Exactly one `error` record is emitted through the log facade per trap, carrying the export name and no document content (redaction).",
    "6. A second trap on the fresh instance recovers again; a trap during rehydration itself surfaces as a failure after a bounded number of attempts instead of looping.",
    "7. Run in every runtime the instance lives in: Node, a real browser (web-browser project) and a Workers runtime.",
    "8. The release artifact exports no `poison-test` symbol (checked over the built wasm's export section).",
];

pub(crate) fn shim_exists(root: &Path) -> bool {
    root.join(SHIM_DIR).join("package.json").is_file()
}

pub(crate) fn run() -> Result<Vec<String>, Vec<String>> {
    let meta = metadata::load()?;
    let mut lines = vec![if shim_exists(&meta.workspace_root) {
        format!(
            "poison-recover: {SHIM_DIR} exists, so this scenario must now be a real test in it; this placeholder still fails until it is replaced:"
        )
    } else {
        format!(
            "poison-recover: not yet: {SHIM_DIR} does not exist, and the recovery under test is the shim's. The scenario to implement with it:"
        )
    }];
    lines.extend(SCENARIO.iter().map(|s| format!("  {s}")));
    Err(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scenario_is_still_owed_while_the_shim_is_absent() {
        // Fails the day packages/core-wasm appears: that change must turn
        // SCENARIO into a real test in each runtime and delete this task.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert!(
            !shim_exists(&root),
            "{SHIM_DIR} exists: implement the poison-and-recover scenario there and retire this placeholder"
        );
        assert!(SCENARIO.len() >= 8);
    }
}
