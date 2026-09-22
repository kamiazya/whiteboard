#!/usr/bin/env node

// @whiteboard/checks — verify-pack-contents.
//
// Versioned replacement for the inline `node -e` "Verify pack contents" step
// that used to live in .github/workflows/release.yml. Sanity-checks an npm
// pack tarball's file list before publish: every required file is present,
// nothing forbidden slipped in.
//
// tools/checks stays dependency-free (see release-gate-matrix-schema.mjs),
// so JSON parsing/validation here is hand-rolled rather than Zod.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const USAGE = `Usage: node tools/checks/src/verify-pack-contents.mjs [--stdin]

Verifies the file list \`npm pack --dry-run --json\` would produce for the
package in the current working directory: every required file is present
and nothing forbidden (test artifacts, internal _artifacts/, build cache
files) is included.

Options:
  --stdin      Read the \`npm pack --dry-run --json\` document from stdin
               instead of self-spawning npm.
  -h, --help   Show this help and exit.
`

const REQUIRED_FILES = [
  'README.md',
  'LICENSE',
  'package.json',
  'dist/server/mcp/index.js',
  // The stdio process entry, separate from the library entry above since
  // `main` resolves to that one. Both ship: one is imported, one is run.
  'dist/server/mcp/stdio.js',
  // The MCP Apps ui://whiteboard/canvas-view resource (mcp-apps.ts) reads
  // this file at runtime; a tarball missing it would 500 on resources/read
  // with no build-time signal otherwise.
  'dist/widget/canvas-viewer.html',
  // The vendored export text-measurement font (export-font.ts /
  // measure-text.ts). A tarball missing it would silently degrade every
  // export to the constant-ratio fallback measurer with no build-time signal.
  'dist/assets/fonts/Roboto/Roboto-Regular.ttf',
  'dist/assets/fonts/Roboto/Roboto-Bold.ttf',
  'dist/assets/fonts/Roboto/Roboto-Italic.ttf',
  'dist/assets/fonts/Roboto/Roboto-BoldItalic.ttf',
]

// Deliberately does NOT include \.map$ — the packaged tarball legitimately
// ships hundreds of source maps (dist/**/*.js.map); a promise to exclude
// them would fail on every real pack. The _artifacts pattern is anchored to
// match a ROOT-level `_artifacts/...` path too (`(?:^|/)`), not only a
// nested one — `npm pack` paths have no leading `./`, so an unanchored
// `/_artifacts/` pattern silently let a root-level artifacts dir through.
const FORBIDDEN_PATTERNS = [
  /\.test\.js$/,
  /\.test\.d\.ts$/,
  /(?:^|\/)_artifacts\//,
  /\.tsbuildinfo$/,
  /\.DS_Store$/,
]

/**
 * @typedef {{ ok: false, reason: string }} StructuralFailure
 * @typedef {{ ok: boolean, missing: string[], forbidden: string[], fileCount: number, sizeBytes: number }} ContentResult
 * @typedef {StructuralFailure | ContentResult} VerifyResult
 */

/**
 * Validate an already-parsed `npm pack --dry-run --json` document (the root
 * value: an array with one entry per package being packed).
 * @param {unknown} doc
 * @returns {VerifyResult}
 */
export function verifyPackContents(doc) {
  if (!Array.isArray(doc)) {
    return { ok: false, reason: 'pack document root must be an array' }
  }
  if (doc.length === 0) {
    return { ok: false, reason: 'pack document array must not be empty' }
  }
  // Read as UNKNOWN and narrowed, not cast. The cast this replaces claimed
  // `Record<string, unknown>` before anything had checked, which made the
  // `=== null` below read as dead code — `typeof null` is `'object'`, so
  // that half of the guard is the only thing standing between a `[null]`
  // pack document and a TypeError out of the release gate.
  /** @type {unknown} */
  const entry = doc[0]
  if (typeof entry !== 'object' || entry === null) {
    return { ok: false, reason: 'pack document entry [0] must be an object' }
  }
  // Honest now: `entry` really is a non-null object by here.
  const files = /** @type {Record<string, unknown>} */ (entry).files
  if (!Array.isArray(files)) {
    return { ok: false, reason: 'pack document entry [0].files must be an array' }
  }
  /** @type {string[]} */
  const paths = []
  for (const fileEntry of /** @type {unknown[]} */ (files)) {
    if (
      typeof fileEntry !== 'object' ||
      fileEntry === null ||
      typeof (/** @type {Record<string, unknown>} */ (fileEntry).path) !== 'string'
    ) {
      return { ok: false, reason: 'every entry [0].files[] item must have a string path' }
    }
    paths.push(/** @type {{ path: string }} */ (fileEntry).path)
  }
  if (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0) {
    return {
      ok: false,
      reason: 'pack document entry [0].size must be a finite, non-negative number',
    }
  }
  const missing = REQUIRED_FILES.filter((p) => !paths.includes(p))
  const forbidden = paths.filter((p) => FORBIDDEN_PATTERNS.some((rx) => rx.test(p)))
  return {
    ok: missing.length === 0 && forbidden.length === 0,
    missing,
    forbidden,
    fileCount: paths.length,
    sizeBytes: entry.size,
  }
}

// Scan forward from `startIndex` (the character index of the array's opening
// `[`) tracking bracket depth and JSON string/escape state, and return the
// index just past the matching closing `]`. String-aware because a file path
// inside the array can itself contain `[` or `]` (e.g. a workspace glob
// artifact), which a naive bracket count would miscount.
function findMatchingArrayEnd(text, startIndex) {
  let depth = 0
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') i = closingQuote(text, i)
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) return i + 1
  }
  return -1
}

// Index of the `"` that closes the JSON string opened at `openIndex`, honouring
// backslash escapes; `text.length` when the string never closes.
function closingQuote(text, openIndex) {
  for (let i = openIndex + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i
  }
  return text.length
}

// `npm pack --dry-run --json` output can be preceded by lifecycle-script
// stdout (e.g. this package's own `prepack` gate prints a status line before
// npm prints its JSON array) and followed by further diagnostic output after
// the array (e.g. post-pack script logging). npm always pretty-prints the
// array with the top-level `[` alone on its own line, so the payload's START
// is anchored on the LAST such line (scanning from the end) rather than a
// global first-`[`/last-`]` scan — a global scan mis-slices when
// prelude/diagnostic output contains its own bracket characters (e.g. a
// `[warn]` tag). The payload's END is then found by bracket-depth scanning
// forward from that start, so trailing non-JSON output never reaches
// JSON.parse. A line that is itself a complete, self-closed `[...]` array is
// also accepted, to tolerate compact (non-pretty-printed) JSON.
/**
 * @param {string} raw
 * @returns {string}
 */
export function extractPackJsonText(raw) {
  const lines = raw.split('\n')
  let offset = 0
  const lineOffsets = lines.map((line) => {
    const start = offset
    offset += line.length + 1 // +1 for the '\n' split away by String#split
    return start
  })
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '[') {
      const startIndex = lineOffsets[i] + lines[i].indexOf('[')
      const endIndex = findMatchingArrayEnd(raw, startIndex)
      if (endIndex !== -1) return raw.slice(startIndex, endIndex)
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      return line
    }
  }
  throw new Error('no JSON array found in npm pack output')
}

/**
 * @param {string[]} argv
 * @returns {{ mode: 'help' } | { mode: 'error', message: string } | { mode: 'run', stdin: boolean }}
 */
export function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { mode: 'help' }
  const known = new Set(['--stdin'])
  const unknown = argv.filter((a) => !known.has(a))
  if (unknown.length > 0) {
    return { mode: 'error', message: `unexpected argument(s): ${unknown.join(' ')}` }
  }
  return { mode: 'run', stdin: argv.includes('--stdin') }
}

/**
 * `npm pack --dry-run --json`'s raw stdout, or why it could not be had.
 * @param {NonNullable<MainOptions['spawn']>} spawn
 * @param {string} platform
 * @param {string} cwd
 * @returns {{ raw: string } | { error: string }}
 */
function runNpmPack(spawn, platform, cwd) {
  // Windows has no bare `npm` executable on PATH — only `npm.cmd` — so
  // spawning 'npm' directly (without shell: true) fails with ENOENT there.
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawn(npmCommand, ['pack', '--dry-run', '--json'], { cwd, encoding: 'utf-8' })
  if (result.error) return { error: `npm pack could not start: ${result.error.message}` }
  if (result.status !== 0) return { error: `npm pack exited with status ${result.status}` }
  return { raw: result.stdout ?? '' }
}

/**
 * The pack document inside `raw`, or why it could not be read.
 * @param {string} raw
 * @returns {{ doc: unknown } | { error: string }}
 */
function packDocument(raw) {
  let jsonText
  try {
    jsonText = extractPackJsonText(raw)
  } catch (err) {
    return { error: /** @type {Error} */ (err).message }
  }
  try {
    return { doc: JSON.parse(jsonText) }
  } catch (err) {
    return { error: `npm pack output is not valid JSON: ${/** @type {Error} */ (err).message}` }
  }
}

/**
 * @param {MainOptions} [options]
 * @typedef {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (chunk: string) => boolean },
 *   stderr?: { write: (chunk: string) => boolean },
 *   spawn?: (cmd: string, args: string[], opts: Record<string, unknown>) => { status: number | null, error?: Error, stdout?: string },
 *   readStdin?: () => string,
 *   platform?: string,
 * }} MainOptions
 * @returns {number} process exit code
 */
export function main(options = {}) {
  const {
    argv = process.argv.slice(2),
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    spawn = spawnSync,
    readStdin = () => readFileSync(0, 'utf-8'),
    platform = process.platform,
  } = options

  const parsed = parseArgs(argv)
  if (parsed.mode === 'help') {
    stdout.write(USAGE)
    return 0
  }
  if (parsed.mode === 'error') {
    stderr.write(`[verify-pack-contents] ${parsed.message}\n\n`)
    stderr.write(USAGE)
    return 1
  }

  const fail = (/** @type {string} */ message) => {
    stderr.write(`[verify-pack-contents] ${message}\n`)
    return 1
  }
  const output = parsed.stdin ? { raw: readStdin() } : runNpmPack(spawn, platform, cwd)
  if ('error' in output) return fail(output.error)
  const parsedDoc = packDocument(output.raw)
  if ('error' in parsedDoc) return fail(parsedDoc.error)

  const result = verifyPackContents(parsedDoc.doc)
  if (!('missing' in result)) return fail(result.reason)
  if (!result.ok) {
    if (result.missing.length > 0) fail(`missing required files: ${result.missing.join(', ')}`)
    if (result.forbidden.length > 0) {
      fail(`forbidden files in tarball: ${result.forbidden.join(', ')}`)
    }
    return 1
  }
  stdout.write(
    `[verify-pack-contents] OK: ${result.fileCount} files, ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB\n`,
  )
  return 0
}

// Direct-run guard: execute only when this file is the CLI entry point,
// never when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
