#!/usr/bin/env node
// `pnpm rust:build:wasm`: the wasm-bindgen composition root built for the
// browser and Node — the cargo release build for wasm32, then
// `wasm-bindgen --target web` into target/wasm-bindgen/whiteboard-wasm.
//
// wasm-bindgen-cli must be EXACTLY the version the crate pins in Cargo.toml:
// the CLI and the macro share a schema, and a mismatch fails at bindgen time
// at best and produces glue that does not match the module at worst. The
// pinned version is read from the manifest, so this cannot drift from it.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const TARGET = 'wasm32-unknown-unknown'

const manifest = readFileSync(join(ROOT, 'Cargo.toml'), 'utf8')
const pinned = manifest.match(/^wasm-bindgen = "=([^"]+)"/m)?.[1]
if (pinned === undefined) {
  process.stderr.write('rust:build:wasm: Cargo.toml no longer pins wasm-bindgen with `=`\n')
  process.exit(1)
}

function run(command, args) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`)
  const status = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT }).status
  if (status !== 0) process.exit(status ?? 1)
}

run('cargo', ['build', '--locked', '--package', 'whiteboard-wasm', '--target', TARGET, '--release'])

const version = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' })
const installed = version.status === 0 ? version.stdout.trim().split(/\s+/)[1] : undefined
if (installed !== pinned) {
  process.stderr.write(
    `rust:build:wasm: wasm-bindgen-cli ${pinned} is required, found ${installed ?? 'none'}. Install it with:\n` +
      `  cargo install --locked wasm-bindgen-cli --version ${pinned}\n`,
  )
  process.exit(1)
}

const targetDir = JSON.parse(
  spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout,
).target_directory
run('wasm-bindgen', [
  '--target',
  'web',
  '--remove-name-section',
  '--remove-producers-section',
  '--out-dir',
  join(targetDir, 'wasm-bindgen', 'whiteboard-wasm'),
  join(targetDir, TARGET, 'release', 'whiteboard_wasm.wasm'),
])
