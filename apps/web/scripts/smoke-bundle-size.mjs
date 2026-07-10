#!/usr/bin/env node
// Bundle-size gate for the built dist/. Run after `pnpm build`.
//
// Budgets (gzip): the entry chunk dominates first paint, so it gets a hard
// ceiling; CSS has its own. The daemon-only feature chunk (DaemonCanvasPage,
// loaded via React.lazy) is named `daemon-canvas-*.js` by vite.config.ts's
// chunkFileNames so it can never leak into first paint unnoticed — this
// budget is `required: true` because the chunk exists as of this gate.
//
// The entry ceiling is a regression stop at today's measured size (~541 KB),
// not an endorsement: shrinking it toward the <300 KB app budget needs
// loro/Excalidraw first-paint splitting, tracked separately.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = resolve(ROOT, 'dist', 'assets')

const KB = 1024
const BUDGETS = [
  { label: 'entry JS (index-*.js)', pattern: /^index-.*\.js$/, limit: 560 * KB, required: true },
  { label: 'CSS (index-*.css)', pattern: /^index-.*\.css$/, limit: 30 * KB, required: true },
  {
    label: 'daemon lazy chunk (daemon-canvas-*.js)',
    pattern: /^daemon-canvas-.*\.js$/,
    limit: 40 * KB,
    required: true,
  },
]

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

if (failures > 0) {
  console.error(`\nbundle-size gate: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nbundle-size gate: OK')
