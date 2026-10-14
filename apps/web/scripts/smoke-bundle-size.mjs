#!/usr/bin/env node
// Bundle-size gate for the built dist/. Run after `pnpm build`.
//
// Budgets (gzip): the entry chunk dominates first paint, so it gets a hard
// ceiling; CSS has its own. The daemon-only feature chunk (DaemonDocumentPage,
// loaded via React.lazy) is named `daemon-document-*.js` by vite.config.ts's
// chunkFileNames so it can never leak into first paint unnoticed — this
// budget is `required: true` because the chunk exists as of this gate.
//
// The per-file entry-JS budget checks ONLY the literal index-*.js file, which
// is misleading on its own: Vite/Rollup splits shared dependencies (React,
// loro-crdt...) into separate chunk files, and index.html
// <link rel="modulepreload"> forces the browser to fetch every one of them
// alongside the entry script before first paint — so they are part of the
// same critical-path payload even though they live in different files. The
// CRITICAL_PATH_BUDGET below sums entry + every modulepreloaded JS chunk
// referenced from dist/index.html, which is the number that actually
// reflects what a fresh visitor downloads before the app can render.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { isRunAsScript } from '../../../tools/checks/src/is-run-as-script.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'dist')
const ASSETS = resolve(DIST, 'assets')

const KB = 1024
const BUDGETS = [
  // The entry file holds the first-paint modules that reach a dynamic import
  // (main, boot, App and the screens that `lazy()` pages), about 6 KB gz;
  // everything else first paint loads is in `shell-*` and `vendor-*` (see
  // vite-manual-chunks.ts). 30 KB leaves headroom for App.tsx growth without
  // going back to the old 560 KB ceiling, which stopped meaning anything once
  // the entry stopped containing loro-crdt (and, later, the editor's own
  // diagramming library).
  { label: 'entry JS (index-*.js)', pattern: /^index-.*\.js$/, limit: 30 * KB, required: true },
  { label: 'CSS (index-*.css)', pattern: /^index-.*\.css$/, limit: 30 * KB, required: true },
  {
    label: 'daemon lazy chunk (daemon-document-*.js)',
    pattern: /^daemon-document-.*\.js$/,
    limit: 40 * KB,
    required: true,
  },
]

// Regression stop on the critical path (entry + every modulepreloaded chunk),
// set ~10% above the measured size rather than at the aspirational floor: a
// budget with no headroom is a tripwire on whoever commits next, not a
// regression stop, so a raise restores that headroom instead of adding one byte.
// Measured at 136.1 KB in 9 files (local build, 2026-10-14). The critical path
// is not thin by choice — react-router, zod, the workspace-address parser and
// the identity resolver have to be on it, because boot decides which page to
// lazy-load and which workspace it means before first paint.
//
// How first paint is cut into chunks, and the two minified-build-only
// defects that decide it (lucide's icons beside loro's top-level await, and a
// shared chunk rewritten for a dynamic import), are vite-manual-chunks.ts.
//
// Whether this much critical path is the right size is a product call about
// first paint, and this gate is the wrong place to make it. `measure-critical-path.mjs`
// turns that question into a number. Measured on one container, 10 runs at
// CPU x4 / 10 Mbps: LCP 512 ms with a 2% spread, and appending 17.9 KB gzipped
// to the entry moved it to 600 ms with the spread unchanged. Two things follow
// for anyone reaching for the budget:
//
// - A gate on LCP would be COARSER than this one, not finer: respecting a 2%
//   band, it detects roughly a 2.5 KB gzipped regression and would miss a
//   few hundred bytes. Replacing bytes with LCP trades resolution away.
// - The two answer different questions. Bytes answer "did this change grow
//   the critical path" — fine, deterministic. LCP answers "is first paint
//   still good" — coarse, absolute, and the only one of the two that can go
//   red for a change that reorders work without adding any.
const CRITICAL_PATH_BUDGET_KB = 150

// The same path counted in FILES, because first paint on CI tracked the
// number of modulepreload requests far more closely than their bytes — see
// `measure-critical-path.mjs` — and the byte budget cannot see a request.
// Deterministic for a given build, unlike a timing. Nine today (the entry,
// the rolldown runtime, the four groups vite-manual-chunks.ts names, and the
// first-paint chunks that reach a dynamic import), so one file of headroom.
// A new file here usually means a first-paint module started reaching an
// `import()` and fell out of those groups, which is worth reading before it
// is worth a raise.
const CRITICAL_PATH_FILE_BUDGET = 10

// Attribute-order-, quote-style-, and case-insensitive: extract each tag
// first, then match attributes independently, so a Vite/minifier formatting
// change (or a producer that emits upper/mixed-case tags or attributes —
// both HTML tag names and attribute names are case-insensitive per spec)
// cannot silently zero out the file list and let the budget pass vacuously.
export function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined
}

/** Every `<script src>` JS file under /assets/ in a built index.html. */
function extractEntryScripts(html) {
  const entryScripts = []
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(tag, 'src')
    if (src?.startsWith('/assets/') && src.endsWith('.js')) entryScripts.push(src)
  }
  return entryScripts
}

// Extracts every entry <script src> and modulepreload <link href> JS file
// referenced from a built index.html — the critical-path payload a fresh
// visitor downloads before first paint. Tag names, attribute names, and the
// `rel` attribute value are all matched case-insensitively per the HTML spec.
export function extractCriticalPathFiles(html) {
  const modulepreloads = []
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = attr(tag, 'href')
    const rel = attr(tag, 'rel')
    if (
      rel?.toLowerCase() === 'modulepreload' &&
      href?.startsWith('/assets/') &&
      href.endsWith('.js')
    ) {
      modulepreloads.push(href)
    }
  }
  return [...new Set([...extractEntryScripts(html), ...modulepreloads])]
}

/**
 * Every entry script awaits the `__tla` promise of each chunk it imports
 * that exports one.
 *
 * vite-plugin-top-level-await turns a chunk holding a top-level await OR a
 * dynamic import into an async body whose exports are assigned only when that
 * body runs, and exports `__tla` for it. An importer it did not rewrite the
 * same way reads those exports before they are assigned. A lazy page gets
 * away with it, since it loads long after the body ran; the entry runs in
 * the same tick, so its first call into such a chunk throws and the page
 * never mounts — in a minified build only, which no source-level test runs.
 */
export function entryAwaitFailures(dist) {
  const lines = []
  let failures = 0
  const indexHtmlPath = join(dist, 'index.html')
  if (!existsSync(indexHtmlPath)) return { failures, lines }
  const fail = (text) => {
    lines.push({ stream: 'error', text })
    failures++
  }
  // A missing asset is a broken build, said as a failure rather than an
  // ENOENT that ends the gate before it reports anything.
  const readAsset = (file) => {
    const path = join(dist, 'assets', file)
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  }
  // The export clause ends the module, but a comment (a source map pointer,
  // a licence banner) may follow it.
  const deferred = (source) =>
    /export\s*\{[^}]*\b__tla\b[^}]*\}\s*;?(?:\s*(?:\/\/[^\r\n]*|\/\*[\s\S]*?\*\/))*\s*$/.test(
      source,
    )
  for (const src of extractEntryScripts(readFileSync(indexHtmlPath, 'utf8'))) {
    const entry = src.replace(/^\/assets\//, '')
    const entrySource = readAsset(entry)
    if (entrySource === undefined) {
      fail(`  FAIL  entry ${entry} is named by index.html but missing from dist/assets`)
      continue
    }
    for (const [, names, file] of entrySource.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*["']\.\/([^"']+)["']/g,
    )) {
      if (/\b__tla\b/.test(names)) continue
      const imported = readAsset(file)
      if (imported === undefined) {
        fail(`  FAIL  entry ${entry} imports ${file}, which is missing from dist/assets`)
        continue
      }
      if (!deferred(imported)) continue
      fail(
        `  FAIL  entry ${entry} reads ${file} without awaiting its __tla — the page will not mount`,
      )
    }
  }
  return { failures, lines }
}

function gzipSize(path) {
  return gzipSync(readFileSync(path)).length
}

/** Each declared budget against the chunks that match its pattern. */
function perChunkFailures() {
  let failures = 0
  const files = readdirSync(ASSETS)
  for (const { label, pattern, limit, required } of BUDGETS) {
    const matches = files.filter((f) => pattern.test(f))
    if (matches.length === 0) {
      if (required) {
        console.error(`  FAIL  ${label}: no file matching ${pattern} in dist/assets`)
        failures++
      } else {
        console.log(`  skip  ${label}: no matching chunk yet`)
      }
      continue
    }
    for (const f of matches) {
      const size = gzipSize(join(ASSETS, f))
      const sizeKb = (size / KB).toFixed(1)
      const limitKb = (limit / KB).toFixed(0)
      if (size > limit) {
        console.error(`  FAIL  ${label}: ${f} is ${sizeKb} KB gzip (budget ${limitKb} KB)`)
        failures++
      } else {
        console.log(`  pass  ${label}: ${f} is ${sizeKb} KB gzip (budget ${limitKb} KB)`)
      }
    }
  }
  return failures
}

/** How close to the byte budget a pass still lists every file. */
const NEAR_BUDGET = 0.97

/** One budget's line: FAIL over it, pass otherwise. */
function judge(what, measured, budget) {
  const over = measured > budget
  const text = `  ${over ? 'FAIL' : 'pass'}  ${what}`
  return { over, line: { stream: over ? 'error' : 'log', text } }
}

/** Each file with its gzipped size, in the order given. */
function fileBreakdown(files, stream) {
  return files.map(({ href, bytes }) => ({
    stream,
    text: `        ${(bytes / KB).toFixed(1).padStart(6)} KB  ${href}`,
  }))
}

/**
 * The entry script plus every modulepreloaded JS chunk, as listed in
 * `<dist>/index.html`, judged against both critical-path budgets.
 *
 * This is what actually determines first-paint transfer, and the per-file
 * entry-JS budget cannot catch a regression here — a statically imported
 * loro-crdt page would inflate this total without ever growing `index-*.js`
 * itself.
 *
 * A failure, or a pass within 3% of the byte budget, lists every file with
 * its gzipped size, largest first. The PR that tips the total over is often
 * not the one that grew a chunk, and without the list its author has to
 * rebuild main and diff `index.html` by hand to find out which one did.
 *
 * Returns the lines rather than printing them so the judgement is testable
 * against a fixture `dist/`.
 */
export function criticalPathReport(dist, { byteBudgetKb, fileBudget }) {
  const lines = []
  const fail = (text) => lines.push({ stream: 'error', text })
  const indexHtmlPath = join(dist, 'index.html')
  if (!existsSync(indexHtmlPath)) {
    fail(`  FAIL  dist/index.html not found at ${indexHtmlPath} — run \`pnpm build\` first`)
    return { failures: 1, lines }
  }

  let failures = 0
  const hrefs = extractCriticalPathFiles(readFileSync(indexHtmlPath, 'utf8'))
  if (hrefs.length === 0) {
    fail(
      '  FAIL  no entry <script src> or <link rel="modulepreload"> JS found in dist/index.html — the parser is broken or the build output changed shape; refusing to pass a vacuous budget',
    )
    failures++
  }

  const files = hrefs
    .map((href) => ({ href, bytes: gzipSize(join(dist, href.replace(/^\//, ''))) }))
    .sort((a, b) => b.bytes - a.bytes)
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const byBytes = judge(
    `critical-path JS (entry + modulepreload, ${files.length} files): ${(bytes / KB).toFixed(1)} KB gzip (budget ${byteBudgetKb} KB)`,
    bytes,
    byteBudgetKb * KB,
  )
  const byCount = judge(
    `critical-path files: ${files.length} (budget ${fileBudget})`,
    files.length,
    fileBudget,
  )
  // Near is for bytes only: a count of ten has no 3% to be within.
  const near = !byBytes.over && bytes >= byteBudgetKb * KB * NEAR_BUDGET
  if (near) byBytes.line.text += ' — within 3% of the budget'
  lines.push(byBytes.line, byCount.line)
  failures += [byBytes, byCount].filter((verdict) => verdict.over).length
  if (failures > 0 || near) lines.push(...fileBreakdown(files, failures > 0 ? 'error' : 'log'))
  return { failures, lines }
}

// Guarded behind the import.meta.url check below so importing this module
// (e.g. from smoke-bundle-size.test.ts to exercise extractCriticalPathFiles)
// never runs the gate or calls process.exit as an import side effect.
function main() {
  let failures = 0

  if (!existsSync(ASSETS)) {
    console.error(`  FAIL  dist/assets not found at ${ASSETS} — run \`pnpm build\` first`)
    process.exit(1)
  }

  failures += perChunkFailures()

  // Critical-path total: entry script + every modulepreloaded JS chunk, as
  // listed in dist/index.html. This is what actually determines first-paint
  // transfer size — see the module comment above for why the per-file
  // entry-JS budget above cannot catch a regression here (e.g. a statically
  // imported loro-crdt page would inflate this total without ever growing
  // index-*.js itself).
  const critical = criticalPathReport(DIST, {
    byteBudgetKb: CRITICAL_PATH_BUDGET_KB,
    fileBudget: CRITICAL_PATH_FILE_BUDGET,
  })
  const awaited = entryAwaitFailures(DIST)
  for (const { stream, text } of [...critical.lines, ...awaited.lines]) console[stream](text)
  failures += critical.failures + awaited.failures

  if (failures > 0) {
    console.error(`\nbundle-size gate: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('\nbundle-size gate: OK')
}

if (isRunAsScript(import.meta.url)) {
  main()
}
