#!/usr/bin/env node
// Post-build guard for the generated service worker (run after `pnpm build`).
//
// This script inspects the actually generated dist/sw.js precache manifest
// rather than trusting the workbox globPatterns config alone — a config
// that looks right (vite-pwa-options.ts) can still miss an asset if Vite
// emits it under an extension the glob doesn't cover (see the vendored
// Roboto .ttf check below).
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
  {
    label: 'the vendored Roboto face (*.ttf) is precached',
    pattern: /url:"assets\/[^"]+\.ttf"/,
  },
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

// loro-crdt's `browser/` entry loads the WASM via a SYNCHRONOUS XHR, which
// bypasses the service worker entirely — the precached WASM is never served
// and the offline PWA dies on reload. The vite alias pins the `bundler/`
// entry (async, SW-interceptable fetch); this guard fails the build if the
// sync-XHR loader ever reappears in the emitted JS (e.g. the alias is
// dropped or loro's export map changes).
import { readdirSync } from 'node:fs'

const ASSETS_DIR = resolve(ROOT, 'dist', 'assets')
const SYNC_XHR_MARKER = 'requires XMLHttpRequest for synchronous WASM loading'
const offender = readdirSync(ASSETS_DIR)
  .filter((f) => f.endsWith('.js'))
  .find((f) => readFileSync(resolve(ASSETS_DIR, f), 'utf8').includes(SYNC_XHR_MARKER))
if (offender) {
  fail(`sync-XHR loro WASM loader bundled in ${offender} — SW cannot serve it offline`)
} else {
  pass('no sync-XHR WASM loader in the bundle (loro bundler entry in effect)')
}

if (failures > 0) {
  console.error(`\npwa-precache gate: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\npwa-precache gate: OK')
