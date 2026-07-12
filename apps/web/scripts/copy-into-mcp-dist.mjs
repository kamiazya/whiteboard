#!/usr/bin/env node
// Postbuild step: copies the apps/web production build into the mcp-server
// package so the local daemon can serve it as the canonical UI (ADR 0001,
// R3). Runs after `apps/web`'s own `vite build`; pnpm's workspace build
// order (apps/web depends on @kamiazya/whiteboard-mcp) guarantees
// packages/mcp-server/dist already exists by the time this step runs.
//
// The generated service worker is deliberately excluded: a Workbox-precached
// index.html would pin a stale injected __WHITEBOARD_DAEMON_TOKEN__ /
// __WHITEBOARD_RUNTIME_CONFIG__ across daemon restarts, since those are
// injected server-side into every response and a cached shell would never
// see the new values. The daemon origin ships no service worker; only the
// static Cloudflare Pages deploy (apps/web's own `dist`) gets one.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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

if (import.meta.url === `file://${process.argv[1]}`) {
  copyIntoMcpDist()
  console.log(`copied ${SRC_DIR} -> ${DEST_DIR} (excluding service worker assets)`)
}
