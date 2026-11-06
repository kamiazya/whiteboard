//! Repository tasks for the Rust workspace, run as `cargo xtask <task>`.

mod arch_map;
mod inputs;
mod metadata;
mod size;
mod unsafe_ledger;
mod wasm_imports;

use std::io::Write;
use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask <task>

tasks:
  codegen --check   generated code is current (no contracts are generated yet)
  arch-map          crates follow crates/architecture-map.json
  inputs            untrusted-input entries declare caps in crates/input-caps.json
  wasm-imports      core crates built for wasm32 import nothing
  size [--update]   wasm artifacts fit crates/wasm-size-ledger.json
  unsafe-ledger [--update]
                    dependency `unsafe` fits crates/unsafe-ledger.json";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["codegen", "--check"] => {
            Ok(vec!["codegen: no contracts are generated yet; nothing to check".to_owned()])
        }
        ["arch-map"] => arch_map::run(),
        ["inputs"] => inputs::run(),
        ["wasm-imports"] => wasm_imports::run(),
        ["size"] => size::run(size::Mode::Check),
        ["size", "--update"] => size::run(size::Mode::Update),
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
