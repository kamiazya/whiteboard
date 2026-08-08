import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/**
 * Dev-server parity for the Cloudflare Pages `_headers` file.
 *
 * Pages is the only place `public/_headers` is ever served, so a policy
 * mistake there (a missing CSP directive, say) is invisible in local dev
 * and first surfaces on the deployed origin. This plugin applies the
 * file's global (`/*`) block to every dev/preview response so the
 * production resource policy is exercised in the everyday dev loop.
 *
 * One deliberate dev-only amendment: `script-src` gains
 * `'unsafe-inline'`, because @vitejs/plugin-react injects its
 * fast-refresh preamble as an inline script in dev. Everything else —
 * including what the policy BLOCKS — is verbatim, which is the point.
 * Path-scoped blocks (sw.js cache rules) are deploy concerns and are not
 * applied.
 *
 * For byte-exact Pages behavior (path blocks, redirects), use
 * `pnpm preview:pages`, which serves the real build through wrangler.
 */
export function devHeadersFromCloudflareHeaders(headersText: string): Map<string, string> {
  const headers = new Map<string, string>()
  let currentPath: string | null = null
  for (const rawLine of headersText.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('/')) {
      currentPath = line
      continue
    }
    if (currentPath !== '/*') continue
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    headers.set(key, value)
  }
  const csp = headers.get('Content-Security-Policy')
  if (csp !== undefined) {
    headers.set(
      'Content-Security-Policy',
      csp.replace(/script-src ([^;]*)/, "script-src $1 'unsafe-inline'"),
    )
  }
  return headers
}

export function cloudflareDevHeadersPlugin(): Plugin {
  const headersPath = resolve(dirname(fileURLToPath(import.meta.url)), 'public/_headers')
  const applyTo = (server: {
    middlewares: {
      use: (fn: (req: unknown, res: unknown, next: () => void) => void) => void
    }
  }) => {
    // Re-read per request: an edit to _headers takes effect on reload
    // without restarting the dev server (the file is tiny).
    server.middlewares.use((_req, res, next) => {
      const headers = devHeadersFromCloudflareHeaders(readFileSync(headersPath, 'utf8'))
      for (const [key, value] of headers) {
        ;(res as { setHeader: (k: string, v: string) => void }).setHeader(key, value)
      }
      next()
    })
  }
  return {
    name: 'whiteboard:cloudflare-dev-headers',
    configureServer: applyTo,
    configurePreviewServer: applyTo,
  }
}
