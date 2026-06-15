#!/usr/bin/env node
// Packaged smoke for `whiteboard daemon logs --json`.
//
// Goal: catch regressions that source-level tests miss because they
// import the TS helper directly — shebang / ESM resolution / process
// exit chain / built dist artifact behavior. The smoke spawns the
// real packaged bin (dist/cli/index.js) and drives a few scenarios
// against the JSONL contract.
//
// Scenarios:
//   1. Missing daemon record (empty data dir) → 1 JSONL info line,
//      fields.status === 'missing', exit 0, stderr empty.
//   2. Valid record fixture with a leaky token in the on-disk file
//      → 1 JSONL warn line, fields.status === 'process-not-running',
//      stdout never carries the token / Authorization / Bearer / paths
//      / stack frames / canvas-plaintext keys.
//   3. No-array-wrapper guard: run twice, concatenate; the result
//      must form a 2-line JSONL document, NOT a single JSON value.
//   4. Usage regression: an unknown subcommand prints the USAGE
//      block, which must still list `whiteboard daemon logs --json`.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANVAS_LEAK_PATTERNS, assertNoLeak } from './smoke-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const CLI_ENTRY = resolve(REPO_ROOT, 'packages/mcp-server/dist/cli/index.js')

function fail(msg, ctx = {}) {
  console.error(`[packaged-daemon-logs-smoke] ${msg}`)
  for (const [k, v] of Object.entries(ctx)) {
    console.error(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  process.exit(1)
}

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], { encoding: 'utf-8' })
  if (res.error) fail('CLI spawn failed', { error: String(res.error) })
  return res
}

function assertJsonl(stdout, expectedLineCount) {
  if (stdout === '') fail('expected non-empty JSONL stdout, got empty')
  if (!stdout.endsWith('\n')) {
    fail('JSONL stdout must end with a trailing newline', {
      tail: JSON.stringify(stdout.slice(-4)),
    })
  }
  const lines = stdout.slice(0, -1).split('\n')
  if (lines.length !== expectedLineCount) {
    fail(`expected ${expectedLineCount} JSONL line(s), got ${lines.length}`, { stdout })
  }
  return lines.map((line) => {
    try {
      return JSON.parse(line)
    } catch (err) {
      fail('JSONL line failed JSON.parse', { line, error: String(err) })
    }
  })
}

// Resolve `tmpdir()` to its canonical form once. On macOS `/tmp`
// resolves to `/private/tmp`, on Linux it stays `/tmp`, on Windows it
// is something like `C:\Users\<user>\AppData\Local\Temp` — we must
// reject every form a leak could surface in. Resolving once means
// the same canary works regardless of host.
const RESOLVED_TMP = realpathSync(tmpdir())

// assertNoLeak (BASE_LEAK_PATTERNS + 'secret-token-XYZ') is imported from smoke-helpers.mjs.
// This wrapper adds canvas-plaintext checks and the canonical-tmpdir check.
function assertNoLeakLogs(text) {
  assertNoLeak('stdout', text, ['secret-token-XYZ'])
  for (const re of CANVAS_LEAK_PATTERNS) {
    if (re.test(text)) fail(`stdout leak: ${re}`, { stdout: text })
  }
  if (RESOLVED_TMP && text.includes(RESOLVED_TMP)) {
    fail('stdout leak: resolved tmpdir path', { resolvedTmp: RESOLVED_TMP, stdout: text })
  }
}

const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const VALID_SOURCES = new Set(['daemon', 'runtime', 'doctor', 'server', 'mcp'])

function assertSchemaShape(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('parsed line is not a JSON object', { parsed })
  }
  if (parsed.schemaVersion !== 1) fail('schemaVersion !== 1', { parsed })
  if (typeof parsed.timestamp !== 'string') fail('timestamp not string', { parsed })
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(parsed.timestamp)) {
    fail('timestamp is not ISO 8601 with offset', { parsed })
  }
  if (!VALID_LEVELS.has(parsed.level)) fail('bad level', { parsed })
  if (!VALID_SOURCES.has(parsed.source)) fail('bad source', { parsed })
  if (typeof parsed.message !== 'string') fail('message not string', { parsed })
  if (
    parsed.fields === null ||
    typeof parsed.fields !== 'object' ||
    Array.isArray(parsed.fields)
  ) {
    fail('fields not object', { parsed })
  }
}

const dataDirs = []
function makeTempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'whiteboard-packaged-daemon-logs-smoke-'))
  dataDirs.push(dir)
  return dir
}
function cleanup() {
  for (const dir of dataDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
}

try {
  // --- Scenario 1: missing daemon record ---
  {
    const dataDir = makeTempDataDir()
    const res = runCli(['daemon', 'logs', '--json', `--data-dir=${dataDir}`])
    if (res.status !== 0) {
      fail('exit code !== 0 for missing record', {
        stdout: res.stdout,
        stderr: res.stderr,
        status: res.status,
      })
    }
    if (res.stderr !== '') fail('stderr not empty for missing record', { stderr: res.stderr })
    const [line] = assertJsonl(res.stdout, 1)
    assertSchemaShape(line)
    if (line.level !== 'info') fail('expected level=info on missing record', { line })
    if (line.fields.status !== 'missing') fail('expected fields.status=missing', { line })
    assertNoLeakLogs(res.stdout)
  }

  // --- Scenario 2: valid record + leaky token in the on-disk file ---
  // The record's `token` field is the obvious leak channel — it must
  // never reach stdout. Using a guaranteed-dead PID keeps the helper
  // on the `process-not-running` branch deterministically.
  {
    const dataDir = makeTempDataDir()
    writeFileSync(
      join(dataDir, 'daemon.json'),
      JSON.stringify({
        pid: 99999,
        port: 3099,
        token: 'Authorization: Bearer secret-token-XYZ',
        version: '0.0.4-smoke',
        startedAt: '2026-05-09T00:00:00.000Z',
      }),
    )

    const res = runCli(['daemon', 'logs', '--json', `--data-dir=${dataDir}`])
    if (res.status !== 0) {
      fail('exit code !== 0 for valid record', {
        stdout: res.stdout,
        stderr: res.stderr,
        status: res.status,
      })
    }
    if (res.stderr !== '') fail('stderr not empty for valid record', { stderr: res.stderr })
    const [line] = assertJsonl(res.stdout, 1)
    assertSchemaShape(line)
    if (line.fields.status !== 'process-not-running') {
      fail('expected fields.status=process-not-running for dead PID', { line })
    }
    const fieldKeys = Object.keys(line.fields).sort().join(',')
    if (fieldKeys !== 'pid,port,status,version') {
      fail('unexpected fields keys', { fields: line.fields, fieldKeys })
    }
    assertNoLeakLogs(res.stdout)
  }

  // --- Scenario 3: no-array-wrapper guard ---
  {
    const dataDir = makeTempDataDir()
    const a = runCli(['daemon', 'logs', '--json', `--data-dir=${dataDir}`])
    const b = runCli(['daemon', 'logs', '--json', `--data-dir=${dataDir}`])
    const concatenated = a.stdout + b.stdout
    if (!concatenated.endsWith('\n')) fail('concatenated stream missing trailing newline')
    let parseError
    try {
      JSON.parse(concatenated)
    } catch (err) {
      parseError = err
    }
    if (!parseError) {
      fail('concatenated stdout parsed as a single JSON document — array wrapper regression', {
        concatenated,
      })
    }
    const lines = assertJsonl(concatenated, 2)
    for (const line of lines) assertSchemaShape(line)
  }

  // --- Scenario 4: usage regression ---
  {
    const res = runCli(['daemon', 'this-is-not-a-real-subcommand', '--json'])
    if (res.status !== 64) {
      fail('expected exit 64 for unknown subcommand', {
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
      })
    }
    if (res.stdout !== '') fail('stdout must be empty on usage error', { stdout: res.stdout })
    if (!/whiteboard daemon logs\s+--json/.test(res.stderr)) {
      fail('usage stderr must list `whiteboard daemon logs --json`', { stderr: res.stderr })
    }
  }

  console.log('[packaged-daemon-logs-smoke] all scenarios passed')
} finally {
  cleanup()
}
