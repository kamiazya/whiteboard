//! Repository tasks for the Rust workspace, run as `cargo xtask <task>`.

mod arch_map;
mod codegen;
mod cross_target;
mod dist;
mod harden;
mod inputs;
mod metadata;
mod notices;
mod poison_recover;
mod repro;
mod size;
mod unsafe_ledger;
mod wasm_imports;

use std::io::Write;
use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask <task>

tasks:
  codegen [--check] Zod and serde types from contracts/; --check fails on drift
  arch-map          crates follow crates/architecture-map.json
  cross-target      every core crate's tests pass on wasm32 (Node) as natively, same count
  inputs            untrusted-input entries declare caps in crates/input-caps.json
  wasm-imports      core crates built for wasm32 import nothing
  size [--update]   wasm artifacts fit crates/wasm-size-ledger.json
  harden-check [--require-stack-protector] <binary>...
                    a release binary carries PIE, full RELRO, NX, no RPATH,
                    stripped symbols and its embedded dependency list
  dist native|wasm [--target-dir <dir>]
                    the release build of a shipped artifact (remapped paths,
                    SOURCE_DATE_EPOCH, cargo-auditable for native)
  repro-check [native|wasm]...
                    two release builds, from two source paths, are byte-equal
  notices           THIRD-PARTY-NOTICES for the wasm and native artifacts
  poison-recover    the wasm panic-recovery scenario (fails: not yet runnable)
  unsafe-ledger [--update]
                    dependency `unsafe` fits crates/unsafe-ledger.json";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["codegen"] => codegen::run(codegen::Mode::Write),
        ["codegen", "--check"] => codegen::run(codegen::Mode::Check),
        ["arch-map"] => arch_map::run(),
        ["cross-target"] => cross_target::run(),
        ["inputs"] => inputs::run(),
        ["wasm-imports"] => wasm_imports::run(),
        ["size"] => size::run(size::Mode::Check),
        ["size", "--update"] => size::run(size::Mode::Update),
        ["harden-check", rest @ ..] => harden::run(rest),
        ["dist", rest @ ..] => dist::run_task(rest),
        ["repro-check", rest @ ..] => repro::run(rest),
        ["notices"] => notices::run(),
        ["poison-recover"] => poison_recover::run(),
        ["unsafe-ledger"] => unsafe_ledger::run(unsafe_ledger::Mode::Check),
        ["unsafe-ledger", "--update"] => unsafe_ledger::run(unsafe_ledger::Mode::Update),
        _ => Err(vec![USAGE.to_owned()]),
    };
    let (lines, code) = match result {
        Ok(lines) => (lines, ExitCode::SUCCESS),
        Err(lines) => (lines, ExitCode::FAILURE),
    };
    let mut out = std::io::stdout().lock();
    for line in lines {
        // A closed stdout leaves nothing to report the failure to.
        let _ = writeln!(out, "{line}");
    }
    code
}
