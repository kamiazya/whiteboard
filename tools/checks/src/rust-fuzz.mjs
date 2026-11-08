#!/usr/bin/env node
// `pnpm rust:fuzz:pr` / `pnpm rust:fuzz:nightly`: the fuzz targets of
// crates/fuzz, one per entry of crates/input-caps.json (the registry).
//
//   pr       the targets whose entry the change can reach, ~30 s each
//            (RUST_FUZZ_SECONDS), no sanitizer, debug assertions on.
//   nightly  every target, 600 s each by default, under AddressSanitizer
//            with cargo-fuzz's `--careful` std (debug assertions and the
//            extra UB checks rustc has — Rust has no UBSan of its own; the
//            C/C++ a dependency builds would take `-fsanitize=undefined`
//            through CFLAGS, and none is linked into a target today), then
//            the corpus minimised; `--coverage` adds a per-target llvm-cov
//            summary.
//
// Arguments after the mode: `--all` selects every target, `--targets a,b`
// names them. Without either, `pr` selects from the files changed against
// RUST_FUZZ_BASE (default origin/main) plus the working tree, and FAILS
// CLOSED: a git error, a change to the registry, a lockfile, a toolchain pin
// or the fuzz crate's shared code selects every target.
//
// Every crash, timeout, out-of-memory or leak input libFuzzer writes is
// copied into crates/fuzz/regressions/<target>/, where the stable replay in
// `pnpm rust:check` (crates/fuzz/tests/regressions.rs) turns red until the
// fix lands with the input committed. The run exits non-zero.
//
// The growing corpus is crates/fuzz/corpus/<target>/, git-ignored and kept
// in the CI cache; the committed regressions are read as a second, seed
// corpus that libFuzzer never writes to, and so are the committed inputs under
// crates/fuzz/seeds/<target>/: well-formed inputs encoded from real boards, so
// the fuzzer starts inside the format instead of searching for its first
// valid prefix.

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const FUZZ = join(ROOT, 'crates', 'fuzz')
const REGISTRY = 'crates/input-caps.json'
const MAP = 'crates/architecture-map.json'
const INSTALL_FUZZ = 'cargo install --locked cargo-fuzz --version 0.13.2'

// Files whose change can alter every target's build or behaviour.
const SELECTS_ALL = [
  REGISTRY,
  MAP,
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'crates/fuzz/Cargo.toml',
  'crates/fuzz/Cargo.lock',
  'crates/fuzz/rust-toolchain.toml',
  'crates/fuzz/src/',
  'tools/checks/src/rust-fuzz.mjs',
]

function fail(message) {
  process.stderr.write(`rust:fuzz: ${message}\n`)
  process.exit(1)
}

function capture(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options })
  return r.status === 0 ? r.stdout : undefined
}

const [mode, ...rest] = process.argv.slice(2)
if (mode !== 'pr' && mode !== 'nightly') {
  fail('usage: rust-fuzz.mjs pr|nightly [--all | --targets a,b] [--coverage]')
}

const toolchain = readFileSync(join(FUZZ, 'rust-toolchain.toml'), 'utf8').match(
  /^channel = "([^"]+)"/m,
)?.[1]
if (toolchain === undefined) fail('crates/fuzz/rust-toolchain.toml pins no channel')
if (capture('rustc', [`+${toolchain}`, '--version']) === undefined) {
  fail(
    `toolchain ${toolchain} is not installed. Install it with:\n  rustup toolchain install ${toolchain} --profile minimal --component llvm-tools --component rust-src`,
  )
}
if (capture('cargo', [`+${toolchain}`, 'fuzz', '--version']) === undefined) {
  fail(`cargo-fuzz is not installed. Install it with:\n  ${INSTALL_FUZZ}`)
}

const registry = JSON.parse(readFileSync(join(ROOT, REGISTRY), 'utf8')).entries
const map = JSON.parse(readFileSync(join(ROOT, MAP), 'utf8')).crates
const entries = Object.entries(registry).map(([id, caps]) => ({ id, ...caps }))
if (entries.length === 0) fail(`${REGISTRY} lists no entry, so there is nothing to fuzz`)

// The local crates each entry's crate reaches, from the fuzz workspace's
// resolved graph: a change in any of them can change what the target runs.
function localDirsReachedFrom() {
  const out = capture('cargo', [
    'metadata',
    '--format-version',
    '1',
    '--locked',
    '--manifest-path',
    join(FUZZ, 'Cargo.toml'),
  ])
  if (out === undefined) return undefined
  const meta = JSON.parse(out)
  const local = new Map(
    meta.packages
      .filter((p) => p.source === null)
      .map((p) => [p.id, { name: p.name, dir: relative(ROOT, join(p.manifest_path, '..')) }]),
  )
  const deps = new Map(meta.resolve.nodes.map((n) => [n.id, n.dependencies]))
  const reached = new Map()
  for (const [id, { name }] of local) {
    const seen = new Set()
    const stack = [id]
    while (stack.length > 0) {
      const next = stack.pop()
      if (seen.has(next) || !local.has(next)) continue
      seen.add(next)
      stack.push(...(deps.get(next) ?? []))
    }
    reached.set(
      name,
      [...seen].map((s) => local.get(s).dir.split(sep).join('/')),
    )
  }
  return reached
}

function changedFiles() {
  const base = process.env.RUST_FUZZ_BASE ?? 'origin/main'
  const committed = capture('git', ['diff', '--name-only', `${base}...HEAD`])
  const working = capture('git', ['status', '--porcelain', '--untracked-files=all'])
  if (committed === undefined || working === undefined) return undefined
  return [
    ...committed.split('\n'),
    ...working.split('\n').map((l) => l.slice(3).split(' -> ').at(-1)),
  ].filter((f) => f !== undefined && f !== '')
}

function select() {
  const all = entries.map((e) => e.fuzzTarget)
  const named = rest.indexOf('--targets')
  if (named !== -1) {
    const wanted = (rest[named + 1] ?? '').split(',').filter(Boolean)
    const unknown = wanted.filter((t) => !all.includes(t))
    if (unknown.length > 0 || wanted.length === 0) {
      fail(`--targets names no registry target: ${unknown.join(', ') || '(empty)'}`)
    }
    return { targets: wanted, why: 'named on the command line' }
  }
  if (mode === 'nightly' || rest.includes('--all')) return { targets: all, why: 'every target' }
  const files = changedFiles()
  if (files === undefined)
    return { targets: all, why: 'git could not list the change (fail closed)' }
  const global = files.find((f) =>
    SELECTS_ALL.some((g) => f === g || (g.endsWith('/') && f.startsWith(g))),
  )
  if (global !== undefined) return { targets: all, why: `${global} changed (selects every target)` }
  const reached = localDirsReachedFrom()
  if (reached === undefined) return { targets: all, why: 'cargo metadata failed (fail closed)' }
  const under = (f, dir) => f === dir || f.startsWith(`${dir}/`)
  const targets = entries
    .filter((e) => {
      const own = [
        `crates/fuzz/fuzz_targets/${e.fuzzTarget}.rs`,
        `crates/fuzz/regressions/${e.fuzzTarget}`,
        ...(reached.get(e.crate) ?? [map[e.crate]?.path ?? 'crates']),
      ]
      return files.some((f) => own.some((dir) => under(f, dir)))
    })
    .map((e) => e.fuzzTarget)
  return { targets, why: `${files.length} changed files` }
}

function run(args) {
  process.stdout.write(`\n$ cargo ${args.join(' ')}\n`)
  return spawnSync('cargo', args, { cwd: ROOT, stdio: 'inherit' }).status
}

const { targets, why } = select()
process.stdout.write(`rust:fuzz ${mode}: ${targets.length} target(s) — ${why}\n`)
if (targets.length === 0) {
  process.stdout.write('rust:fuzz: the change reaches no fuzz entry; nothing to run\n')
  process.exit(0)
}

const seconds = Number(process.env.RUST_FUZZ_SECONDS ?? (mode === 'pr' ? 30 : 600))
const build = mode === 'pr' ? ['-a', '-s', 'none'] : ['-a', '-s', 'address', '--careful']
const findings = []
const report = []

for (const target of targets) {
  const entry = entries.find((e) => e.fuzzTarget === target)
  const corpus = join(FUZZ, 'corpus', target)
  const artifacts = join(FUZZ, 'artifacts', target)
  const regressions = join(FUZZ, 'regressions', target)
  const seeds = join(FUZZ, 'seeds', target)
  for (const dir of [corpus, artifacts, regressions]) mkdirSync(dir, { recursive: true })
  const before = new Set(readdirSync(artifacts))
  const started = Date.now()
  const status = run([
    `+${toolchain}`,
    'fuzz',
    'run',
    '--fuzz-dir',
    FUZZ,
    ...build,
    target,
    corpus,
    regressions,
    ...(existsSync(seeds) ? [seeds] : []),
    '--',
    `-max_total_time=${seconds}`,
    `-max_len=${entry.maxBytes}`,
    `-timeout=${Math.ceil(entry.maxMillis / 1000)}`,
    `-artifact_prefix=${artifacts}${sep}`,
  ])
  const found = readdirSync(artifacts).filter((f) => !before.has(f))
  for (const f of found) {
    copyFileSync(join(artifacts, f), join(regressions, f))
    findings.push(`crates/fuzz/regressions/${target}/${f}`)
  }
  if (status !== 0 && found.length === 0) {
    findings.push(`${target}: libFuzzer exited ${status} without writing an input (see its log)`)
  }
  report.push({
    target,
    entry: entry.id,
    seconds: Math.round((Date.now() - started) / 1000),
    status,
    found,
  })
}

if (mode === 'nightly' && findings.length === 0) {
  for (const target of targets) {
    // Minimise the grown corpus in place so the cache does not grow without bound.
    run([
      `+${toolchain}`,
      'fuzz',
      'cmin',
      '--fuzz-dir',
      FUZZ,
      ...build,
      target,
      join(FUZZ, 'corpus', target),
    ])
  }
}

if (rest.includes('--coverage')) {
  const sysroot = capture('rustc', [`+${toolchain}`, '--print', 'sysroot'])?.trim()
  const host = capture('rustc', [`+${toolchain}`, '-vV'])?.match(/^host: (.+)$/m)?.[1]
  const llvmCov = join(sysroot ?? '', 'lib', 'rustlib', host ?? '', 'bin', 'llvm-cov')
  if (!existsSync(llvmCov))
    fail(`--coverage needs llvm-cov from the llvm-tools component of ${toolchain}`)
  for (const row of report) {
    const t = row.target
    if (
      run([`+${toolchain}`, 'fuzz', 'coverage', '--fuzz-dir', FUZZ, t, join(FUZZ, 'corpus', t)]) !==
      0
    ) {
      fail(`cargo fuzz coverage ${t} failed`)
    }
    // cargo-fuzz puts the instrumented build under <target-dir>/<host>/coverage,
    // where <target-dir> is the root workspace's (measured: it ignores
    // `--target-dir`), so the binary is looked up rather than assumed.
    // The summary is scoped to the entry's own crate: what the fuzzer reaches
    // of the code it exists to exercise, not of std or the harness.
    const entry = report.find((r) => r.target === t)
    const crateDir = join(ROOT, map[entries.find((e) => e.id === entry.entry).crate].path)
    const bin = [process.env.CARGO_TARGET_DIR, join(ROOT, 'target'), join(FUZZ, 'target')]
      .filter((d) => d !== undefined)
      .map((d) => join(d, host, 'coverage', host, 'release', t))
      .find((b) => existsSync(b))
    if (bin === undefined) fail(`cargo fuzz coverage ${t} left no instrumented binary`)
    const summary = capture(llvmCov, [
      'report',
      '--summary-only',
      `--instr-profile=${join(FUZZ, 'coverage', t, 'coverage.profdata')}`,
      bin,
      crateDir,
    ])
    row.coverage = summary?.trim().split('\n').at(-1)
    process.stdout.write(`coverage ${t}: ${row.coverage ?? '(llvm-cov failed)'}\n`)
  }
}

writeFileSync(
  join(FUZZ, 'artifacts', 'report.json'),
  `${JSON.stringify({ mode, toolchain, seconds, report }, null, 2)}\n`,
)

if (findings.length > 0) {
  process.stderr.write(
    `\nrust:fuzz: ${findings.length} finding(s):\n${findings.map((f) => `  ${f}\n`).join('')}` +
      '\nEach input is now under crates/fuzz/regressions/, so `pnpm rust:check` replays it and fails\n' +
      'until the fix lands. Minimise it first (`cargo +<nightly> fuzz tmin --fuzz-dir crates/fuzz <target> <input>`),\n' +
      'keep the minimised input in place of the raw one, and commit it with the fix.\n',
  )
  process.exit(1)
}
process.stdout.write(
  `\nrust:fuzz ${mode}: ${targets.length} target(s) ran ${seconds}s each with no finding\n`,
)
