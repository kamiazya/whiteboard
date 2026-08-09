// Test-only helper shared between ensure-http-dev-daemon.script.test.ts
// (which starts a responder directly, in-process, for the fast-path case)
// and fake-pnpm-shim.mjs (which starts one from a spawned subprocess, for
// the wait-path/timeout-path cases). Kept minimal: it only has to satisfy
// probeAuthenticatedMcpDaemon()'s three checks (reachable, correct bearer,
// json/event-stream content-type).

import { createServer } from 'node:http'

/** How long a transient EADDRINUSE is retried before the bind is called lost. */
const BIND_RETRY_BUDGET_MS = 2_000
const BIND_RETRY_INTERVAL_MS = 100

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
    // The caller reserved this port by binding :0 and closing again, so the
    // OS is free to hand it to anything else on the machine before we get
    // here — on a sharded CI runner that collision is real, not theoretical.
    // A short retry rides out the usual case (something mid-teardown) rather
    // than failing the run over a transient.
    const deadline = Date.now() + BIND_RETRY_BUDGET_MS
    // Both handlers are registered ONCE, outside the retry loop: re-adding
    // them per attempt leaks a listener each time and trips Node's
    // max-listeners warning after ten retries.
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && Date.now() < deadline) {
        setTimeout(() => server.listen(port, host), BIND_RETRY_INTERVAL_MS)
        return
      }
      reject(err)
    })
    server.once('listening', () => {
      resolve({
        server,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      })
    })
    server.listen(port, host)
  })
}
