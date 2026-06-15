#!/usr/bin/env node
// Packaged smoke for `whiteboard daemon support-bundle --json`. Runs
// against `dist/cli/index.js` so the bin shebang / ESM import / exit
// chain / dispatcher wiring are all on the regression path.
//
// Scenarios:
//   1. Missing daemon record + missing output dir → exit 0, JSON
//      success result, four files on disk, manifest schemaVersion=1.
//   2. Valid record fixture with a leaky token in daemon.json →
//      exit 0, every on-disk file scrubbed of token / Authorization
//      / Bearer / paths / stack frames / canvas-plaintext keys.
//   3. Non-empty output directory → exit 1, generic stderr that does
//      NOT echo the resolved output path or the seeded token, and
//      the canary file is preserved.
//   4. Usage regression: an unknown subcommand prints the USAGE
//      block, which must still list `whiteboard daemon support-bundle`.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANVAS_LEAK_PATTERNS, assertNoLeak } from './smoke-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const CLI_ENTRY = resolve(REPO_ROOT, 'packages/mcp-server/dist/cli/index.js')

if (!existsSync(CLI_ENTRY)) {
  console.error(
    `[packaged-daemon-support-bundle-smoke] FAIL: dist entrypoint missing: ${CLI_ENTRY}\n` +
      'Run `pnpm --filter @kamiazya/whiteboard-mcp build` first.',
  )
  process.exit(1)
}

const RESOLVED_TMP = realpathSync(tmpdir())

function fail(msg, ctx = {}) {
  console.error(`[packaged-daemon-support-bundle-smoke] ${msg}`)
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined || v === '') continue
    console.error(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  process.exit(1)
}

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], { encoding: 'utf-8' })
  if (res.error) fail('CLI spawn failed', { error: String(res.error) })
  return res
}

// assertNoLeak (BASE_LEAK_PATTERNS) is imported from smoke-helpers.mjs.
// This wrapper adds canvas-plaintext checks and the canonical-tmpdir check
// that are specific to this script's scrubbing contract.
function assertNoLeakBundle(label, text, extraLiterals = []) {
  assertNoLeak(label, text, extraLiterals)
  for (const re of CANVAS_LEAK_PATTERNS) {
    if (re.test(text)) fail(`${label} canvas leak: ${re}`, { text })
  }
  if (RESOLVED_TMP && text.includes(RESOLVED_TMP)) {
    fail(`${label} leak: resolved tmpdir path`, { resolvedTmp: RESOLVED_TMP, text })
  }
}

const cleanup = []
function makeTempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'whiteboard-support-bundle-smoke-'))
  cleanup.push(dir)
  return dir
}

try {
  // ─── Scenario 1: missing record + missing output dir ───
  {
    const dataDir = makeTempDataDir()
    const root = makeTempDataDir()
    const outputDir = join(root, 'bundle')

    const res = runCli([
      'daemon',
      'support-bundle',
      '--json',
      `--data-dir=${dataDir}`,
      `--output-dir=${outputDir}`,
    ])
    if (res.status !== 0) fail('scenario 1 unexpected status', res)
    if (res.stderr !== '') fail('scenario 1 stderr should be empty', { stderr: res.stderr })
    let result
    try {
      result = JSON.parse(res.stdout.trim())
    } catch (err) {
      fail('scenario 1 stdout not JSON', { stdout: res.stdout, error: String(err) })
    }
    if (result.ok !== true) fail('scenario 1 result.ok !== true', result)
    if (result.schemaVersion !== 1) fail('scenario 1 unexpected schemaVersion', result)

    const onDisk = readdirSync(outputDir).sort()
    if (
      onDisk.length !== 4 ||
      !['doctor.json', 'logs.jsonl', 'manifest.json', 'status.json'].every((n) => onDisk.includes(n))
    ) {
      fail('scenario 1 unexpected file set', { onDisk })
    }
    const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf-8'))
    if (manifest.schemaVersion !== 1) fail('scenario 1 manifest.schemaVersion !== 1', manifest)
    if (
      JSON.stringify([...manifest.sections].sort()) !==
      JSON.stringify(['doctor.json', 'logs.jsonl', 'status.json'])
    ) {
      fail('scenario 1 manifest.sections mismatch', manifest)
    }
  }

  // ─── Scenario 2: valid record + leaky token ───
  {
    const dataDir = makeTempDataDir()
    const root = makeTempDataDir()
    const outputDir = join(root, 'bundle')

    writeFileSync(
      join(dataDir, 'daemon.json'),
      JSON.stringify({
        pid: 99999,
        port: 3099,
        token: 'Authorization: Bearer secret-token-XYZ at /opt/wb/server.ts:42',
        version: '0.0.4-smoke',
        startedAt: '2026-05-10T00:00:00.000Z',
      }),
    )

    const res = runCli([
      'daemon',
      'support-bundle',
      '--json',
      `--data-dir=${dataDir}`,
      `--output-dir=${outputDir}`,
    ])
    if (res.status !== 0) fail('scenario 2 unexpected status', res)

    const concatenated = ['manifest.json', 'status.json', 'doctor.json', 'logs.jsonl']
      .map((n) => readFileSync(join(outputDir, n), 'utf-8'))
      .join('')
    assertNoLeakBundle('on-disk bundle', concatenated, ['secret-token-XYZ'])
    // CLI stdout includes the outputDir literal — that path is on
    // the resolved tmpdir, so it WOULD trigger the canonical-tmpdir
    // canary. Allow it for stdout (the user picked this path) but
    // still enforce no token / Bearer leak there.
    if (res.stdout.includes('secret-token-XYZ')) fail('scenario 2 stdout leaked token')
    if (/Bearer/i.test(res.stdout)) fail('scenario 2 stdout leaked Bearer marker')
  }

  // ─── Scenario 3: non-empty output dir ───
  {
    const dataDir = makeTempDataDir()
    const root = makeTempDataDir()
    const outputDir = join(root, 'bundle')
    mkdirSync(outputDir, { recursive: true })
    const canaryPath = join(outputDir, 'pre-existing.txt')
    writeFileSync(canaryPath, 'canary-content')

    const res = runCli([
      'daemon',
      'support-bundle',
      '--json',
      `--data-dir=${dataDir}`,
      `--output-dir=${outputDir}`,
    ])
    if (res.status !== 1) fail('scenario 3 expected exit 1', res)
    if (res.stdout !== '') fail('scenario 3 stdout must be empty on failure', res)
    if (!/output directory must be empty/i.test(res.stderr)) {
      fail('scenario 3 stderr unexpected', res)
    }
    if (res.stderr.includes(outputDir)) fail('scenario 3 stderr leaked outputDir', res)
    if (res.stderr.includes('secret-token-XYZ')) fail('scenario 3 stderr leaked token', res)
    // Canary survives.
    if (readFileSync(canaryPath, 'utf-8') !== 'canary-content') {
      fail('scenario 3 canary mutated')
    }
    if (readdirSync(outputDir).sort().join(',') !== 'pre-existing.txt') {
      fail('scenario 3 unexpected files in target', readdirSync(outputDir))
    }
  }

  // ─── Scenario 4: usage regression ───
  {
    const res = runCli(['daemon', 'this-is-not-a-real-subcommand', '--json'])
    if (res.status !== 64) fail('scenario 4 expected exit 64', res)
    if (res.stdout !== '') fail('scenario 4 stdout must be empty', res)
    if (!/whiteboard daemon support-bundle\s+--json/.test(res.stderr)) {
      fail('scenario 4 usage missing support-bundle line', res)
    }
  }

  console.log('[packaged-daemon-support-bundle-smoke] all scenarios passed')
} finally {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true })
  }
}
