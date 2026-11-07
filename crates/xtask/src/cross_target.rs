//! `cargo xtask cross-target`: every present core crate's tests pass on
//! `wasm32-unknown-unknown` under Node exactly as they do natively, and the
//! SAME NUMBER of them (ADR-0054, QR-21 layer 3).
//!
//! The wasm run is `cargo test --target wasm32-unknown-unknown`, which
//! `.cargo/config.toml` points at `wasm-bindgen-test-runner`. That runner sees
//! only tests marked for it, so a test module that forgets
//! `use wasm_bindgen_test::wasm_bindgen_test as test;` does not fail there —
//! it simply does not run. Comparing the two counts is what makes that
//! omission a failure instead of a silently narrower cross-target check.

use std::process::Command;

use crate::{arch_map, metadata, wasm_imports};

/// The sum of every `N passed` across a test run's `test result:` lines.
pub(crate) fn passed(output: &str) -> Option<u64> {
    let mut total = 0;
    let mut seen = false;
    for line in output.lines().filter(|l| l.trim_start().starts_with("test result:")) {
        let count = line.split(';').next()?.split_whitespace().rev().nth(1)?.parse::<u64>().ok()?;
        total += count;
        seen = true;
    }
    seen.then_some(total)
}

fn run_tests(name: &str, wasm: bool) -> Result<u64, String> {
    let mut cmd = Command::new(metadata::cargo());
    cmd.args(["test", "--locked", "--package", name]);
    if wasm {
        cmd.args(["--target", metadata::WASM_TARGET]);
    }
    let out = cmd.output().map_err(|e| format!("cargo did not run: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let target = if wasm { metadata::WASM_TARGET } else { "native" };
    if !out.status.success() {
        let tail: Vec<&str> = text.lines().rev().take(30).collect();
        return Err(format!(
            "{name} ({target}): tests failed\n{}\n{}",
            tail.into_iter().rev().collect::<Vec<_>>().join("\n"),
            String::from_utf8_lossy(&out.stderr)
                .lines()
                .rev()
                .take(10)
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    passed(&text).ok_or_else(|| format!("{name} ({target}): no `test result:` line in the output"))
}

pub(crate) fn run() -> Result<Vec<String>, Vec<String>> {
    let meta = metadata::load()?;
    let map = arch_map::load_map(&meta)?;
    let core = wasm_imports::wasm_core_crates(&map);
    let mut report = Vec::new();
    let mut v = Vec::new();
    for name in &core {
        let (native, wasm) = match (run_tests(name, false), run_tests(name, true)) {
            (Ok(n), Ok(w)) => (n, w),
            (n, w) => {
                v.extend(n.err());
                v.extend(w.err());
                continue;
            }
        };
        if native != wasm {
            v.push(format!(
                "{name}: {native} tests pass natively and {wasm} on wasm32; a test module that does not run on wasm needs `#[cfg(target_arch = \"wasm32\")] use wasm_bindgen_test::wasm_bindgen_test as test;`"
            ));
        }
        report.push(format!("  {name}: {native} tests on both targets"));
    }
    if core.is_empty() {
        v.push("no present core crate targets wasm32, so nothing ran".to_owned());
    }
    if v.is_empty() {
        report.insert(
            0,
            format!(
                "cross-target: {} core crates pass the same tests on wasm32 and natively",
                core.len()
            ),
        );
        Ok(report)
    } else {
        Err(v)
    }
}

#[cfg(test)]
mod tests {
    use super::passed;

    #[test]
    fn sums_every_result_line_and_refuses_output_without_one() {
        let native = "running 2 tests\ntest result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\
                      test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n";
        assert_eq!(passed(native), Some(9));
        let wasm = "no tests to run!\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 filtered out; finished in 0.00s\n";
        assert_eq!(passed(wasm), Some(0));
        assert_eq!(passed("error: could not compile"), None);
    }
}
