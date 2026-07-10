#!/usr/bin/env node
// Post-build guard for the generated service worker (run after `pnpm build`).
//
// Rollup/Rolldown does not guarantee plugin hook execution order matches
// declaration order, so the Excalidraw font-copy plugin (closeBundle) racing
// vite-plugin-pwa's precache-manifest generation is a real risk: if fonts
// aren't in dist/fonts yet when workbox globs the output, they silently drop
// out of the precache and the app breaks offline. This script inspects the
// actually generated dist/sw.js precache manifest rather than trusting
// plugin declaration order.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SW_PATH = resolve(ROOT, 'dist', 'sw.js')
const MANIFEST_PATH = resolve(ROOT, 'dist', 'manifest.webmanifest')

let failures = 0

function fail(message) {
  console.error(`  FAIL  ${message}`)
  failures++
}

function pass(message) {
  console.log(`  pass  ${message}`)
}

function requireBuildOutput(label, path) {
  if (existsSync(path)) return
  fail(`${label} not found at ${path} — run \`pnpm build\` first`)
  process.exit(1)
}

requireBuildOutput('dist/sw.js', SW_PATH)
requireBuildOutput('dist/manifest.webmanifest', MANIFEST_PATH)

const swSource = readFileSync(SW_PATH, 'utf8')

const checks = [
  { label: 'entry chunk (index-*.js) is precached', pattern: /url:"assets\/index-[^"]+\.js"/ },
  { label: 'an Excalidraw font (*.woff2) is precached', pattern: /url:"fonts\/[^"]+\.woff2"/ },
  { label: 'icon-192.png is precached', pattern: /url:"icon-192\.png"/ },
  { label: 'icon-512.png is precached', pattern: /url:"icon-512\.png"/ },
  // The browser-local editor depends on loro-crdt's WASM module at runtime;
  // without it in the precache manifest an installed/offline PWA fails the
  // moment it needs Loro.
  { label: 'the Loro WASM module (*.wasm) is precached', pattern: /url:"assets\/[^"]+\.wasm"/ },
]

for (const { label, pattern } of checks) {
  if (pattern.test(swSource)) {
    pass(label)
  } else {
    fail(`${label} — precache manifest is missing a matching entry`)
  }
}

if (failures > 0) {
  console.error(`\npwa-precache gate: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\npwa-precache gate: OK')
