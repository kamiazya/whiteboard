// Test-only stand-in for a dev daemon's socket, shared between the script
// tests (which start one in-process) and fake-pnpm-shim.mjs (which starts one
// from a spawned subprocess). It answers exactly what the dev tools ask of a
// real daemon: the unauthenticated liveness ping, and an authenticated
// POST /mcp.

import { createServer } from 'node:http'

// src/daemon/daemon-socket.ts's limit, restated because this file is copied
// into scratch checkouts that hold scripts/dev and nothing of src/;
// fake-mcp-daemon.test.ts holds it to socket-fetch.ts's copy, which its own
// test binds through the daemon at.
export const SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 103 : 107

/**
 * The kernel binds a too-long unix socket path truncated instead of refusing
 * it, so a long TMPDIR would read as EADDRINUSE, or as a client retrying
 * ENOENT forever, rather than as its cause.
 * @param {string} socketPath
 */
export function assertTestSocketPathFits(socketPath) {
  const bytes = Buffer.byteLength(socketPath)
  if (bytes <= SOCKET_PATH_MAX_BYTES) return
  throw new Error(
    `the test socket path is ${bytes} bytes, over the ${SOCKET_PATH_MAX_BYTES}-byte limit for a unix socket: ${socketPath}. Use a shorter TMPDIR for this test run.`,
  )
}

/**
 * @param {{ socketPath: string, token: string }} args
 * @returns {Promise<{ server: import('node:http').Server, close: () => Promise<void> }>}
 */
export function startFakeMcpResponder({ socketPath, token }) {
  return new Promise((resolve, reject) => {
    assertTestSocketPathFits(socketPath)
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/runtime/ping') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404).end()
        return
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'fake-mcp-daemon', result: {} }))
    })
    server.once('error', reject)
    server.listen(socketPath, () =>
      resolve({
        server,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      }),
    )
  })
}
