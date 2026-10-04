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
  // The entry file itself is now a thin bootstrap (~5 KB gz) now that both
  // canvas pages are React.lazy — 30 KB leaves headroom for App.tsx growth
  // without going back to the old 560 KB ceiling, which stopped meaning
  // anything once the entry stopped containing loro-crdt (and, later, the
  // editor's own diagramming library).
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
// The entry is not thin by choice — react-router, the workspace-address parser
// and the identity resolver have to be in it, because boot decides which page
// to lazy-load and which workspace it means before first paint.
//
// `manualChunks` gives lucide-react a chunk of its own, and that is
// not a size decision: left unassigned, the icons merge into a chunk carrying
// loro's WASM top-level await, where rolldown emits them as `let Copy, …`
// assigned inside the TLA body, so the exports read `undefined` forever.
// Rendering the document kebab then calls createElement(undefined) and React
// #130 takes the whole page to the error screen. Invisible to every
// source-level test and to an unminified build alike.
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
const CRITICAL_PATH_BUDGET_KB = 152

// Attribute-order-, quote-style-, and case-insensitive: extract each tag
// first, then match attributes independently, so a Vite/minifier formatting
// change (or a producer that emits upper/mixed-case tags or attributes —
// both HTML tag names and attribute names are case-insensitive per spec)
// cannot silently zero out the file list and let the budget pass vacuously.
export function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined
}

// Extracts every entry <script src> and modulepreload <link href> JS file
// referenced from a built index.html — the critical-path payload a fresh
// visitor downloads before first paint. Tag names, attribute names, and the
// `rel` attribute value are all matched case-insensitively per the HTML spec.
export function extractCriticalPathFiles(html) {
  const entryScripts = []
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(tag, 'src')
    if (src?.startsWith('/assets/') && src.endsWith('.js')) entryScripts.push(src)
  }
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
  return [...new Set([...entryScripts, ...modulepreloads])]
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

/**
 * The entry script plus every modulepreloaded JS chunk, as listed in
 * `dist/index.html`.
 *
 * This is what actually determines first-paint transfer size, and the
 * per-file entry-JS budget cannot catch a regression here — a statically
 * imported loro-crdt page would inflate this total without ever growing
 * `index-*.js` itself.
 */
function criticalPathFailures() {
  const indexHtmlPath = join(DIST, 'index.html')
  if (!existsSync(indexHtmlPath)) {
    console.error(
      `  FAIL  dist/index.html not found at ${indexHtmlPath} — run \`pnpm build\` first`,
    )
    return 1
  }

  let failures = 0
  const criticalPathFiles = extractCriticalPathFiles(readFileSync(indexHtmlPath, 'utf8'))
  if (criticalPathFiles.length === 0) {
    console.error(
      '  FAIL  no entry <script src> or <link rel="modulepreload"> JS found in dist/index.html — the parser is broken or the build output changed shape; refusing to pass a vacuous budget',
    )
    failures++
  }

  let bytes = 0
  for (const href of criticalPathFiles) {
    bytes += gzipSize(join(DIST, href.replace(/^\//, '')))
  }
  const kb = (bytes / KB).toFixed(1)
  const what = `critical-path JS (entry + modulepreload, ${criticalPathFiles.length} files)`
  if (bytes > CRITICAL_PATH_BUDGET_KB * KB) {
    console.error(`  FAIL  ${what}: ${kb} KB gzip (budget ${CRITICAL_PATH_BUDGET_KB} KB)`)
    failures++
  } else {
    console.log(`  pass  ${what}: ${kb} KB gzip (budget ${CRITICAL_PATH_BUDGET_KB} KB)`)
  }
  return failures
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
  failures += criticalPathFailures()

  if (failures > 0) {
    console.error(`\nbundle-size gate: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('\nbundle-size gate: OK')
}

if (isRunAsScript(import.meta.url)) {
  main()
}
