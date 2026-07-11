#!/usr/bin/env node
// Bundle-size gate for the built dist/. Run after `pnpm build`.
//
// Budgets (gzip): the entry chunk dominates first paint, so it gets a hard
// ceiling; CSS has its own. The daemon-only feature chunk (DaemonCanvasPage,
// loaded via React.lazy) is named `daemon-canvas-*.js` by vite.config.ts's
// chunkFileNames so it can never leak into first paint unnoticed — this
// budget is `required: true` because the chunk exists as of this gate.
//
// The per-file entry-JS budget checks ONLY the literal index-*.js file, which
// is misleading on its own: Vite/Rollup splits shared dependencies (React,
// loro-crdt, Excalidraw...) into separate chunk files, and index.html
// <link rel="modulepreload"> forces the browser to fetch every one of them
// alongside the entry script before first paint — so they are part of the
// same critical-path payload even though they live in different files. The
// CRITICAL_PATH_BUDGET below sums entry + every modulepreloaded JS chunk
// referenced from dist/index.html, which is the number that actually
// reflects what a fresh visitor downloads before the app can render.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
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
  // anything once the entry stopped containing Excalidraw/loro-crdt.
  { label: 'entry JS (index-*.js)', pattern: /^index-.*\.js$/, limit: 30 * KB, required: true },
  { label: 'CSS (index-*.css)', pattern: /^index-.*\.css$/, limit: 30 * KB, required: true },
  {
    label: 'daemon lazy chunk (daemon-canvas-*.js)',
    pattern: /^daemon-canvas-.*\.js$/,
    limit: 40 * KB,
    required: true,
  },
]

// Regression stop at today's measured critical-path size (~119 KB) after
// Stage 2 of tmp/issues/apps-web-entry-bundle-over-budget.md's plan:
// React.lazy on both canvas pages (BrowserLocalCanvasPage and the earlier
// DaemonCanvasPage) keeps Excalidraw's ~400 KB out of the initial paint
// entirely. vendor-loro-crdt (~23 KB) still ships eagerly — some module in
// App.tsx's static import graph reaches it, and vite-plugin-top-level-await
// propagates a synchronous import for any TLA-using chunk up to whichever
// entry point reaches it, even through code that itself only calls into
// loro-crdt from a lazy branch. ~10% headroom over the measured number, not
// the aspirational floor.
const CRITICAL_PATH_BUDGET_KB = 135

let failures = 0

function gzipSize(path) {
  return gzipSync(readFileSync(path)).length
}

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
// imported Excalidraw/loro-crdt page would inflate this total without ever
// growing index-*.js itself).
const indexHtmlPath = join(DIST, 'index.html')
if (!existsSync(indexHtmlPath)) {
  console.error(`  FAIL  dist/index.html not found at ${indexHtmlPath} — run \`pnpm build\` first`)
  failures++
} else {
  const html = readFileSync(indexHtmlPath, 'utf8')
  const entryScripts = [...html.matchAll(/<script[^>]*\ssrc="(\/assets\/[^"]+\.js)"/g)].map(
    (m) => m[1],
  )
  const modulepreloads = [
    ...html.matchAll(/<link[^>]*\srel="modulepreload"[^>]*\shref="(\/assets\/[^"]+\.js)"/g),
  ].map((m) => m[1])
  const criticalPathFiles = [...new Set([...entryScripts, ...modulepreloads])]
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
