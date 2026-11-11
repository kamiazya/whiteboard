#!/usr/bin/env node
// `pnpm rust:build:wasm`: the wasm-bindgen composition root built for the
// browser and Node, as it ships — `cargo xtask dist wasm`, the release build
// with remapped paths, then `wasm-bindgen --target web` into
// <target>/dist/wasm-bindgen/whiteboard-wasm. One build path: the size ledger
// (`cargo xtask size`) and the reproducibility check measure the same bytes.
//
// wasm-bindgen-cli must be EXACTLY the version the crate pins in Cargo.toml
// (the CLI and the macro share a schema); dist checks it and names the
// install command when it differs.
//
// `--oracle` builds the same thing with the `oracle-surface` feature into
// <target>/dist-oracle: the per-module test exports the layer-2 differentials
// call. It is for the test lanes only and is never staged or shipped.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')

const args = process.argv.includes('--oracle') ? ['dist', 'wasm', '--oracle'] : ['dist', 'wasm']
process.stdout.write(`$ cargo xtask ${args.join(' ')}\n`)
const { status } = spawnSync('cargo', ['xtask', ...args], { stdio: 'inherit', cwd: ROOT })
process.exit(status ?? 1)
