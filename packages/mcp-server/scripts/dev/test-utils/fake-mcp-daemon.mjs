// Test-only stand-in for a dev daemon's socket, shared between the script
// tests (which start one in-process) and fake-pnpm-shim.mjs (which starts one
// from a spawned subprocess). It answers exactly what the dev tools ask of a
// real daemon: the unauthenticated liveness ping, and an authenticated
// POST /mcp.

import { createServer } from 'node:http'

/**
 * @param {{ socketPath: string, token: string }} args
 * @returns {Promise<{ server: import('node:http').Server, close: () => Promise<void> }>}
 */
export function startFakeMcpResponder({ socketPath, token }) {
  return new Promise((resolve, reject) => {
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
