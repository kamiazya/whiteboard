#!/usr/bin/env node
// Postbuild step: copies the apps/web production build into the mcp-server
// package so the local daemon can serve it as the canonical UI (ADR 0001,
// R3). Runs after `apps/web`'s own `vite build`.
//
// apps/web has no dependency on mcp-server, so `pnpm -r build` builds the two
// concurrently and mcp-server's dist may or may not exist yet — this step
// creates `dist/web-app` itself. mcp-server's tsdown config keeps `dist/web-app`
// out of its clean, so a build that finishes later does not delete this copy.
//
// The generated service worker is deliberately excluded: a Workbox-precached
// index.html would pin a stale injected __WHITEBOARD_RUNTIME_CONFIG__ across
// daemon restarts, since it is injected server-side into every response and
// a cached shell would never see the new value. The daemon origin ships no service worker; only the
// static Cloudflare Pages deploy (apps/web's own `dist`) gets one.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRunAsScript } from '../../../tools/checks/src/is-run-as-script.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const SRC_DIR = resolve(SCRIPT_DIR, '..', 'dist')
export const DEST_DIR = resolve(
  SCRIPT_DIR,
  '..',
  '..',
  '..',
  'packages',
  'mcp-server',
  'dist',
  'web-app',
)

const EXCLUDE_PATTERNS = [
  /^sw\.js$/,
  // Top-level Workbox runtime chunk (`workbox-<revision>.js`).
  /^workbox-[^/]+\.js$/,
  // The `virtual:pwa-register` glue chunk and the workbox-window library it
  // pulls in both live under assets/ with content-hashed suffixes.
  /^assets\/virtual_pwa-register-[^/]+\.js$/,
  /^assets\/workbox-window\.[^/]+\.js$/,
]

/**
 * @param {string} relativePath path relative to the apps/web dist root, using either separator
 * @returns {boolean} true when the entry must not ship on the daemon origin
 */
export function shouldExcludeFromMcpDist(relativePath) {
  const normalized = relativePath.split(sep).join('/')
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function copyIntoMcpDist(srcDir = SRC_DIR, destDir = DEST_DIR) {
  if (!existsSync(srcDir)) {
    throw new Error(`apps/web build output not found at ${srcDir} — run \`vite build\` first`)
  }
  // Content-hashed assets from earlier builds would otherwise pile up, now that
  // nothing cleans this directory between builds.
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (source) => {
      const rel = relative(srcDir, source)
      if (rel === '') return true // the root dir itself
      return !shouldExcludeFromMcpDist(rel)
    },
  })
}

if (isRunAsScript(import.meta.url)) {
  copyIntoMcpDist()
  console.log(`copied ${SRC_DIR} -> ${DEST_DIR} (excluding service worker assets)`)
}
