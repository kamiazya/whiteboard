/**
 * ADR-0047 decision 1: a server-mode keeper serves the web build that ships in
 * its image, from its own origin. Same origin is the point: the sign-in
 * session is a host-only cookie (ADR-0045 decision 12), and the API the app
 * calls is on the host that set it.
 *
 * The shell is marked `keeper: 'server'` through the runtime config, which is
 * what tells the app to sign in against this keeper rather than pair with a
 * local daemon. A keeper run without a build — from source, say — keeps the
 * placeholder, so a browser always gets an answer.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { RuntimeConfig } from '@kamiazya/whiteboard-daemon-client/api-client'
import type { Hono } from 'hono'
import {
  isReservedUiPath,
  SERVER_MODE_PLACEHOLDER_HTML,
  toInlineScriptJson,
} from './app-helpers.js'
import { createCspNonce } from './pair-page-csp.js'

const RUNTIME_CONFIG: RuntimeConfig = { keeper: 'server' }

// The pairing page's policy, less what only a loopback daemon needs: the app
// talks to the origin it was served from and nothing else.
function serverModeCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "frame-src 'none'",
  ].join('; ')
}

function shellWithConfig(html: string): { html: string; csp: string } {
  const nonce = createCspNonce()
  const script = `<script nonce="${nonce}">window.__WHITEBOARD_RUNTIME_CONFIG__ = ${toInlineScriptJson(RUNTIME_CONFIG)}</script>`
  const withConfig = html.includes('</head>')
    ? html.replace('</head>', `${script}</head>`)
    : `${script}${html}`
  return { html: withConfig, csp: serverModeCsp(nonce) }
}

/** What `runtime/status` reports of the UI: the web app when the image
 *  carries its build, the placeholder when it does not. */
export function serverModeUiStatus(webAppDir: string): {
  buildPresent: boolean
  ui: 'web-app' | 'server-placeholder'
} {
  const buildPresent = existsSync(join(webAppDir, 'index.html'))
  return { buildPresent, ui: buildPresent ? 'web-app' : 'server-placeholder' }
}

export function mountServerModeWebApp(app: Hono, webAppDir: string): void {
  const files = serveStatic({ root: webAppDir })
  // A path with an extension is a file of the build; anything else is a
  // route of the app, answered with its shell. `/index.html` IS the shell,
  // and served raw it would lack the marker and boot the browser app.
  app.get('*', async (c, next) => {
    if (isReservedUiPath(c.req.path)) return c.notFound()
    if (c.req.path !== '/index.html' && extname(c.req.path) !== '') {
      return (await files(c, next)) ?? c.json({ error: 'not_found' }, 404)
    }
    const shell = await readFile(join(webAppDir, 'index.html'), 'utf-8').catch(() => null)
    if (shell === null) return c.html(SERVER_MODE_PLACEHOLDER_HTML)
    const { html, csp } = shellWithConfig(shell)
    return c.html(html, 200, { 'Content-Security-Policy': csp })
  })
}
