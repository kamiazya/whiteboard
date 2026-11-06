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

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')

process.stdout.write('$ cargo xtask dist wasm\n')
const { status } = spawnSync('cargo', ['xtask', 'dist', 'wasm'], { stdio: 'inherit', cwd: ROOT })
process.exit(status ?? 1)
