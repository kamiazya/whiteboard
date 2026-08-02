// Test-only helper shared between ensure-http-dev-daemon.script.test.ts
// (which starts a responder directly, in-process, for the fast-path case)
// and fake-pnpm-shim.mjs (which starts one from a spawned subprocess, for
// the wait-path/timeout-path cases). Kept minimal: it only has to satisfy
// probeAuthenticatedMcpDaemon()'s three checks (reachable, correct bearer,
// json/event-stream content-type).

import { createServer } from 'node:http'

/**
 * Starts a minimal HTTP responder that answers POST /mcp like the real
 * daemon's authenticated MCP endpoint, for exactly the fields
 * probeAuthenticatedMcpDaemon() inspects.
 *
 * @param {{ port: number, token: string, host?: string }} args
 * @returns {Promise<{ server: import('node:http').Server, close: () => Promise<void> }>}
 */
export function startFakeMcpResponder({ port, token, host = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
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
    server.listen(port, host, () => {
      resolve({
        server,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      })
    })
  })
}
