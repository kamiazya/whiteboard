#!/usr/bin/env node
// `pnpm rust:check`: every gate the Rust workspace has, in the order a
// failure is cheapest to read — formatting, lints, tests, then the xtask
// guards (architecture map, input caps and the fuzz registry, wasm import
// scan, the core crates' tests on wasm32, size ledger, dependency-unsafe ledger) and the supply-chain check
// over both workspaces. Stops at the first failing step.
//
// crates/fuzz is a workspace of its own (its targets need nightly), so its
// formatting, lints and the stable replay of every committed fuzz regression
// are separate steps over its manifest, built without the libFuzzer driver.
//
// `cargo xtask size` measures the shipped wasm, so it runs the release build
// (`cargo xtask dist wasm`) and needs wasm-bindgen-cli at the pinned version;
// it fails naming the install command when that is missing.
//
// cargo-deny is a separate install, not part of the toolchain. When it is
// absent this FAILS and says how to install it, rather than skipping: a
// supply-chain gate that quietly does not run reads exactly like one that
// passed.

import { spawnSync } from 'node:child_process'

const FUZZ = ['--manifest-path', 'crates/fuzz/Cargo.toml']
const FUZZ_STABLE = [...FUZZ, '--no-default-features', '--locked']

const STEPS = [
  ['cargo', ['fmt', '--all', '--check']],
  ['cargo', ['fmt', ...FUZZ, '--check']],
  ['cargo', ['clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings']],
  ['cargo', ['clippy', ...FUZZ_STABLE, '--all-targets', '--', '-D', 'warnings']],
  ['cargo', ['test', '--workspace', '--locked']],
  ['cargo', ['test', ...FUZZ_STABLE]],
  ['cargo', ['xtask', 'codegen', '--check']],
  ['cargo', ['xtask', 'arch-map']],
  ['cargo', ['xtask', 'inputs']],
  ['cargo', ['xtask', 'wasm-imports']],
  ['cargo', ['xtask', 'cross-target']],
  ['cargo', ['xtask', 'size']],
  ['cargo', ['xtask', 'unsafe-ledger']],
  ['cargo', ['deny', '--locked', 'check']],
  ['cargo', ['deny', ...FUZZ, '--locked', 'check']],
]

const DENY_INSTALL = 'cargo install --locked cargo-deny --version 0.20.2'

function run(command, args) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`)
  return spawnSync(command, args, { stdio: 'inherit' }).status
}

for (const [command, args] of STEPS) {
  if (args[0] === 'deny' && spawnSync('cargo', ['deny', '--version']).status !== 0) {
    process.stderr.write(
      `rust:check: cargo-deny is not installed. Install it with:\n  ${DENY_INSTALL}\n`,
    )
    process.exit(1)
  }
  const status = run(command, args)
  if (status !== 0) {
    process.stderr.write(`rust:check: \`${command} ${args.join(' ')}\` failed\n`)
    process.exit(status ?? 1)
  }
}
process.stdout.write('\nrust:check: every Rust gate passed\n')
