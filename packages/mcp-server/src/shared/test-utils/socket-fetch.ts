import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'

/**
 * A fresh owner-only socket path for one test: its own temp directory, so a
 * parallel run never shares a path. A long TMPDIR can still push it past the
 * limit a Unix socket path has, which the kernel answers by binding a
 * truncated name — so that is refused here, naming the limit, rather than
 * surfacing as EADDRINUSE or a connect that never lands. The directory is
 * removed when the calling test finishes, so this must be called from inside
 * a test; a daemon a whole suite shares puts its socket in a directory its
 * `afterAll` removes.
 */
export function testSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sock-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'd.sock')
  assertTestSocketPathFits(path)
  return path
}

/**
 * The daemon's own limit (`daemon-socket.ts`), restated so a test fixture can
 * refuse what `listenOnSocket` would; socket-fetch.test.ts holds the two equal
 * by binding through the daemon at it and one byte over it.
 */
export const TEST_SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 103 : 107

/** Throws, naming the limit and the remedy, for a path the kernel would truncate. */
export function assertTestSocketPathFits(path: string): void {
  const bytes = Buffer.byteLength(path)
  if (bytes <= TEST_SOCKET_PATH_MAX_BYTES) return
  throw new Error(
    `the test socket path is ${bytes} bytes, over the ${TEST_SOCKET_PATH_MAX_BYTES}-byte limit for a unix socket: ${path}. Use a shorter TMPDIR for this test run.`,
  )
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
