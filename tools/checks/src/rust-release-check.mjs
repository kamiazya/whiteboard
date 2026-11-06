#!/usr/bin/env node
// `pnpm rust:release:check`: the Rust release gates, in the order a release
// job runs them. Not part of `pnpm rust:check`: each builds release
// artifacts from cold target directories (about 2 minutes together).
//
//   dist native     the release build of the native binary (cargo-auditable)
//   harden-check    PIE, full RELRO, NX, no RPATH, stripped, .dep-v0 (QR-28d)
//   repro-check     two builds from two source paths are byte-equal (QR-28e)
//   notices         THIRD-PARTY-NOTICES per artifact (cargo-about)
//
// Each needs a tool beside the toolchain (cargo-auditable, wasm-bindgen-cli,
// cargo-about) and FAILS naming the install command when it is missing. The
// release workflow runs repro-check's two builds in separate jobs as well,
// which is the part a single machine cannot vary.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')

function run(args) {
  process.stdout.write(`\n$ cargo ${args.join(' ')}\n`)
  const status = spawnSync('cargo', args, { cwd: ROOT, stdio: 'inherit' }).status
  if (status !== 0) {
    process.stderr.write(`rust:release:check: \`cargo ${args.join(' ')}\` failed\n`)
    process.exit(status ?? 1)
  }
}

const targetDir = JSON.parse(
  spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout,
).target_directory

run(['xtask', 'dist', 'native'])
run(['xtask', 'harden-check', join(targetDir, 'dist', 'dist-native', 'whiteboard-native-fixture')])
run(['xtask', 'repro-check'])
run(['xtask', 'notices'])
process.stdout.write('\nrust:release:check: every Rust release gate passed\n')
