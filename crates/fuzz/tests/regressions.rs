//! Every crash input a fuzzer ever found, replayed on the stable toolchain.
//!
//! `pnpm rust:fuzz:*` copies each crash, timeout and out-of-memory input into
//! `regressions/<target>/`, so this test is red from the moment a finding
//! exists until the fix lands with the input committed beside it.

use std::path::Path;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn every_committed_regression_input_passes_its_target() {
    let mut replayed = 0usize;
    for dir in std::fs::read_dir(root().join("regressions")).unwrap() {
        let dir = dir.unwrap().path();
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let target = whiteboard_fuzz::TARGETS
            .iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("regressions/{name} names no fuzz target"))
            .1;
        for input in std::fs::read_dir(&dir).unwrap() {
            let input = input.unwrap().path();
            if input.file_name().is_some_and(|f| f == ".gitkeep") {
                continue;
            }
            target(&std::fs::read(&input).unwrap());
            replayed += 1;
        }
    }
    // A replay over nothing passes for any target; the committed template
    // input is what proves this walk reaches a target at all.
    assert!(replayed > 0, "no regression input was replayed");
}

#[test]
fn every_target_has_a_binary_and_every_binary_a_target() {
    let manifest = std::fs::read_to_string(root().join("Cargo.toml")).unwrap();
    let mut bins: Vec<&str> = manifest
        .split("[[bin]]")
        .skip(1)
        .filter_map(|block| {
            block.lines().find_map(|l| l.trim().strip_prefix("name = \"")?.strip_suffix('"'))
        })
        .collect();
    bins.sort_unstable();
    let mut targets: Vec<&str> = whiteboard_fuzz::TARGETS.iter().map(|(n, _)| *n).collect();
    targets.sort_unstable();
    assert_eq!(bins, targets);
    assert!(!targets.is_empty());
}
