#!/usr/bin/env node
// `pnpm rust:check`: every gate the Rust workspace has, in the order a
// failure is cheapest to read — formatting, lints, tests, then the xtask
// guards (architecture map, input caps, wasm import scan, size ledger) and
// the supply-chain check. Stops at the first failing step.
//
// cargo-deny is a separate install, not part of the toolchain. When it is
// absent this FAILS and says how to install it, rather than skipping: a
// supply-chain gate that quietly does not run reads exactly like one that
// passed.

import { spawnSync } from 'node:child_process'

const STEPS = [
  ['cargo', ['fmt', '--all', '--check']],
  ['cargo', ['clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings']],
  ['cargo', ['test', '--workspace', '--locked']],
  ['cargo', ['xtask', 'codegen', '--check']],
  ['cargo', ['xtask', 'arch-map']],
  ['cargo', ['xtask', 'inputs']],
  ['cargo', ['xtask', 'wasm-imports']],
  ['cargo', ['xtask', 'size']],
  ['cargo', ['deny', '--locked', 'check']],
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
