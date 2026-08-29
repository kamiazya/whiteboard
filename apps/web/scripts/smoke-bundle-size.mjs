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

// Regression stop at today's measured critical-path size (~97.7 KB) after
// Stage 2 of tmp/issues/apps-web-entry-bundle-over-budget.md's plan
// (React.lazy on both canvas pages keeps Excalidraw's ~400 KB out of the
// initial paint) plus dropping vendor-loro-crdt's own manualChunks bucket
// (tmp/issues/vendor-loro-eager-modulepreload.md): that bucket had been
// accidentally co-locating vite's shared dynamic-import helper with loro's
// WASM bindings, forcing the entry to eagerly load ~23 KB it never uses on
// the critical path. ~10% headroom over the measured number, not the
// aspirational floor.
//
// Raised from 108 KB when history routing landed: react-router has to be in
// the entry (it decides which page to lazy-load), so its ~16 KB is a real,
// unavoidable critical-path cost of addressable URLs. Measured 114.0 KB.
//
// Raised again from 126 KB when an address started naming its WORKSPACE.
// Boot resolves which workspace the address means before first paint — that
// is what guarantees no consumer reads the accessor unresolved — so the route
// parser and the identity resolver are entry code for the same reason
// react-router is. Measured 126.0 KB.
//
// Two numbers are worth writing down rather than just the new one, because
// the second is not this change's doing and outlives it:
//
//   main   125.7 KB   the branch this was raised from
//   here   126.0 KB   +335 bytes, against 316 bytes of remaining headroom
//
// The budget was already spent. `main` sat at 99.75% of 126 KB, so ANY change
// adding twenty bytes to the critical path failed this gate — it had stopped
// being a regression stop and become a tripwire on the next commit, whoever
// wrote it. The ~10% headroom this file's own rule asks for was gone, and
// restoring it is the fix; unblocking one PR is the occasion, not the reason.
//
// What that headroom does NOT settle is whether 126 KB of critical path is
// the right size. It has grown 108 -> 114 -> 126 in three raises, each
// individually justified, which is how a budget stops meaning anything. That
// is a product call about first paint, and this gate is the wrong place to
// make it quietly.
//
// `measure-critical-path.mjs` is what turns that question from an argument
// into a number. Measured on one container, 10 runs at CPU x4 / 10 Mbps:
// LCP 512 ms with a 2% spread, and appending 17.9 KB gzipped to the entry
// moved it to 600 ms with the spread unchanged. So a metric gate is possible,
// and two things follow that are worth knowing HERE, where the next person
// reaches for the budget:
//
// - A gate on LCP would be COARSER than this one, not finer: respecting a 2%
//   band, it detects roughly a 2.5 KB gzipped regression and would have
//   missed the +335 bytes that occasioned the last raise. Replacing bytes
//   with LCP trades resolution away.
// - The two answer different questions, and the drift above is what happens
//   when one number carries both. Bytes answer "did this change grow the
//   critical path" — fine, deterministic, and a raise is then just a recorded
//   fact. LCP answers "is first paint still good" — coarse, absolute, and the
//   only one of the two that can go red for a change that reorders work
//   without adding any.
//
// Choosing the LCP threshold is the product call this comment already says
// does not belong in a gate file, so it is not made here either.
const CRITICAL_PATH_BUDGET_KB = 138

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

// Guarded behind the import.meta.url check below so importing this module
// (e.g. from smoke-bundle-size.test.ts to exercise extractCriticalPathFiles)
// never runs the gate or calls process.exit as an import side effect.
function main() {
  let failures = 0

  if (!existsSync(ASSETS)) {
    console.error(`  FAIL  dist/assets not found at ${ASSETS} — run \`pnpm build\` first`)
    process.exit(1)
  }

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

  // Critical-path total: entry script + every modulepreloaded JS chunk, as
  // listed in dist/index.html. This is what actually determines first-paint
  // transfer size — see the module comment above for why the per-file
  // entry-JS budget above cannot catch a regression here (e.g. a statically
  // imported loro-crdt page would inflate this total without ever growing
  // index-*.js itself).
  const indexHtmlPath = join(DIST, 'index.html')
  if (!existsSync(indexHtmlPath)) {
    console.error(
      `  FAIL  dist/index.html not found at ${indexHtmlPath} — run \`pnpm build\` first`,
    )
    failures++
  } else {
    const html = readFileSync(indexHtmlPath, 'utf8')
    const criticalPathFiles = extractCriticalPathFiles(html)
    if (criticalPathFiles.length === 0) {
      console.error(
        '  FAIL  no entry <script src> or <link rel="modulepreload"> JS found in dist/index.html — the parser is broken or the build output changed shape; refusing to pass a vacuous budget',
      )
      failures++
    }
    let criticalPathBytes = 0
    for (const href of criticalPathFiles) {
      criticalPathBytes += gzipSize(join(DIST, href.replace(/^\//, '')))
    }
    const criticalPathKb = (criticalPathBytes / KB).toFixed(1)
    if (criticalPathBytes > CRITICAL_PATH_BUDGET_KB * KB) {
      console.error(
        `  FAIL  critical-path JS (entry + modulepreload, ${criticalPathFiles.length} files): ${criticalPathKb} KB gzip (budget ${CRITICAL_PATH_BUDGET_KB} KB)`,
      )
      failures++
    } else {
      console.log(
        `  pass  critical-path JS (entry + modulepreload, ${criticalPathFiles.length} files): ${criticalPathKb} KB gzip (budget ${CRITICAL_PATH_BUDGET_KB} KB)`,
      )
    }
  }

  if (failures > 0) {
    console.error(`\nbundle-size gate: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('\nbundle-size gate: OK')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
