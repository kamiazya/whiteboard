import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A fresh owner-only socket path for one test: its own temp directory, so a
 * parallel run never shares a path, and short enough for the 104/108-byte
 * limit a Unix socket path has.
 */
export function testSocketPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'wb-sock-')), 'd.sock')
}

/**
 * `fetch` for a daemon that answers only on its socket (ADR-0050): the URL's
 * path and query are sent there, and the whole body is buffered — enough for
 * every request a test makes, and not for a stream held open.
 */
export function socketFetch(
  socketPath: string,
): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(input, 'http://localhost')
      const req = request(
        {
          socketPath,
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init.headers)),
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('error', reject)
          res.on('end', () => {
            const headers = new Headers()
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined)
                headers.set(name, Array.isArray(value) ? value.join(', ') : value)
            }
            const status = res.statusCode ?? 0
            const body = status === 204 || status === 304 ? null : Buffer.concat(chunks)
            resolve(new Response(body, { status, headers }))
          })
        },
      )
      req.on('error', reject)
      const body = init.body
      if (body === undefined || body === null) req.end()
      else req.end(body as string | Uint8Array)
    })
}
