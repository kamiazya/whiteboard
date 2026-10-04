// A static server for a built web app, for the scripts that drive it in a real
// browser (the smokes and the measure script).
//
// It answers the way the app's hosting does: the single-page fallback, the
// hosting's own headers when a caller passes them, and a content type for
// every extension the build emits. A server missing one of those does not
// fail visibly: a `.wasm` or `.woff2` served as `application/octet-stream`
// loads in some browsers and is refused in others, so the script checks a page
// the user would never see.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

/** The type served for an extension the table does not know. */
const UNKNOWN_TYPE = 'application/octet-stream'

/**
 * Where a path that names no file goes.
 *
 * - `any-missing` (default): index.html, as a host configured with a
 *   catch-all does. The app's addresses carry dots (`/w/default/notes/a.md`),
 *   so a dot is not evidence that a path is an asset.
 * - `extensionless`: index.html only for a path with no extension; a missing
 *   file that has one is a 404. For a script that asserts a refused or absent
 *   asset, where a catch-all would answer the page's HTML in its place.
 */
const FALLBACKS = new Set(['any-missing', 'extensionless'])

/**
 * What a decoded request path names: the file to send, or the status that
 * refuses it. Resolved, then compared on a separator boundary: a bare
 * `startsWith(root)` also admits a sibling directory that merely shares the
 * root's prefix.
 */
function lookup(base, decoded, fallback) {
  const requested = resolve(base, `.${decoded}`)
  if (requested !== base && !requested.startsWith(base + sep)) return { status: 403 }
  if (existsSync(requested) && statSync(requested).isFile()) return { file: requested, real: true }
  if (fallback === 'extensionless' && extname(requested) !== '') return { status: 404 }
  return { file: join(base, 'index.html'), real: false }
}

/**
 * @param {{
 *   root: string,
 *   headers?: Record<string, string>,
 *   fallback?: 'any-missing' | 'extensionless',
 *   onRequest?: (
 *     req: import('node:http').IncomingMessage,
 *     res: import('node:http').ServerResponse,
 *     context: { pathname: string },
 *   ) => { status: number, body?: string } | undefined | Promise<{ status: number, body?: string } | undefined>,
 *   transform?: (pathname: string, body: Buffer) => Buffer | string,
 * }} options
 *   `onRequest` runs before the file is looked up: it may wait (hold a
 *   navigation), or answer instead by returning a status. `transform` rewrites
 *   the body of the path that was asked for, never the file on disk.
 * @returns {Promise<{
 *   server: import('node:http').Server,
 *   port: number,
 *   origin: string,
 *   close: () => Promise<void>,
 * }>}
 */
export async function serveDist({
  root,
  headers = {},
  fallback = 'any-missing',
  onRequest,
  transform,
}) {
  if (!FALLBACKS.has(fallback)) throw new Error(`serveDist: unknown fallback "${fallback}"`)
  const base = resolve(root)

  const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { ...headers, 'content-type': type })
    res.end(body)
  }

  const respond = async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    let decoded
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return send(res, 400, 'bad request')
    }
    const answer = await onRequest?.(req, res, { pathname })
    if (answer !== undefined) return send(res, answer.status, answer.body ?? '')

    const found = lookup(base, decoded, fallback)
    if (found.file === undefined)
      return send(res, found.status, found.status === 403 ? 'forbidden' : 'not found')
    let body = readFileSync(found.file)
    if (transform !== undefined && found.real) body = transform(pathname, body)
    send(res, 200, body, MIME[extname(found.file)] ?? UNKNOWN_TYPE)
  }

  const server = createServer((req, res) => {
    respond(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening))
  const { port } = server.address()
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((closed) => {
        server.close(() => closed())
        server.closeAllConnections()
      }),
  }
}
