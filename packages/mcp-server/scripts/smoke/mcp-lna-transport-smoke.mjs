#!/usr/bin/env node
// Cross-engine, real-browser measurement of whether a hosted HTTPS page can
// reach a loopback origin — the harness ADR-0002's addendum promised as
// "a reproducible cross-engine harness" but never committed. This is that
// harness, committed so the next person can re-run it in one command
// (`pnpm smoke:lna-transport`) when a browser version moves.
//
// It measures two questions per engine, against the real hosted origin used
// by the original 2026-07-08 measurement (https://kamiazya-whiteboard.pages.dev):
//   1. fetch()  — re-confirms the ADR-0002 addendum baseline.
//   2. WebSocket upgrade — the addendum explicitly left this unmeasured
//      ("Chromium's LNA gating for WebSocket is not yet shipped"). This is
//      the re-check ADR-0005's constraints section calls for before the
//      connection-ticket design is finalised.
//
// The probe target is a throwaway, fully permissive Node HTTP+WS server on
// 127.0.0.1 — NOT this repo's own daemon — so a failure is attributable to
// the browser/engine, not to this repo's own origin-allowlist or ws-auth
// gate (those are separately, and already, measured in
// mcp-daemon-origin-smoke.mjs and the origin-validation test suite).
//
// Requires network access to the real hosted origin and all three Playwright
// browser channels installed (`pnpm --filter @kamiazya/whiteboard-mcp exec
// playwright install chromium firefox webkit`).
import http from 'node:http'
import { chromium, firefox, webkit } from 'playwright'
import { WebSocketServer } from 'ws'

const HOSTED_ORIGIN =
  process.env.WHITEBOARD_LNA_HOSTED_ORIGIN ?? 'https://kamiazya-whiteboard.pages.dev'

// A fully permissive probe server: reflects any Origin on both the HTTP
// response and the WS handshake, and never demands PNA header presence, so
// engine-level gating (not this repo's own guards) is the only variable.
function startProbeServer() {
  return new Promise((resolvePromise) => {
    const server = http.createServer((req, res) => {
      const origin = req.headers.origin ?? '*'
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
      res.setHeader('Vary', 'Origin')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, probe: 'lna-ws-measure', origin }))
    })
    const wss = new WebSocketServer({ server, path: '/ws-echo' })
    wss.on('connection', (socket) => {
      socket.send('hello')
      socket.on('message', (data) => socket.send(data))
    })
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, wss }))
  })
}

function probeUrls(server) {
  const { port } = server.address()
  return {
    fetchUrl: `http://127.0.0.1:${port}/ping`,
    wsUrl: `ws://127.0.0.1:${port}/ws-echo`,
  }
}

// Runs inside the page context. Returns a small serializable result rather
// than throwing, so a hung/rejected promise on one probe doesn't abort the
// other in the same page.
async function queryLnaPermissionState(page) {
  return page
    .evaluate(async () => {
      try {
        const status = await navigator.permissions.query({ name: 'local-network-access' })
        return status.state
      } catch (err) {
        return `unsupported: ${String(err)}`
      }
    })
    .catch((err) => `query-error: ${String(err)}`)
}

async function runProbes(page, { fetchUrl, wsUrl }) {
  const fetchResult = await page
    .evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(6000),
        })
        return { outcome: res.ok ? 'succeeded' : `http-${res.status}` }
      } catch (err) {
        return { outcome: 'failed', detail: String(err) }
      }
    }, fetchUrl)
    .catch((err) => ({ outcome: 'page-evaluate-error', detail: String(err) }))

  const wsResult = await page
    .evaluate(
      (url) =>
        new Promise((resolveWs) => {
          const timer = setTimeout(() => resolveWs({ outcome: 'timeout' }), 6000)
          try {
            const socket = new WebSocket(url)
            socket.onopen = () => {
              clearTimeout(timer)
              socket.close()
              resolveWs({ outcome: 'succeeded' })
            }
            socket.onerror = () => {
              clearTimeout(timer)
              resolveWs({ outcome: 'failed' })
            }
          } catch (err) {
            clearTimeout(timer)
            resolveWs({ outcome: 'failed', detail: String(err) })
          }
        }),
      wsUrl,
    )
    .catch((err) => ({ outcome: 'page-evaluate-error', detail: String(err) }))

  return { fetchResult, wsResult }
}

async function measureChromium(probe) {
  const browser = await chromium.launch({ headless: true })
  const results = {}
  try {
    // Undecided/denied permission state: never call grantPermissions.
    const denyContext = await browser.newContext()
    const denyPage = await denyContext.newPage()
    await denyPage.goto(HOSTED_ORIGIN, { waitUntil: 'domcontentloaded' })
    results.permissionDenied = {
      permissionState: await queryLnaPermissionState(denyPage),
      ...(await runProbes(denyPage, probe)),
    }
    await denyContext.close()

    // Granted permission state.
    const grantContext = await browser.newContext()
    await grantContext.grantPermissions(['local-network-access'], { origin: HOSTED_ORIGIN })
    const grantPage = await grantContext.newPage()
    await grantPage.goto(HOSTED_ORIGIN, { waitUntil: 'domcontentloaded' })
    results.permissionGranted = {
      permissionState: await queryLnaPermissionState(grantPage),
      ...(await runProbes(grantPage, probe)),
    }
    await grantContext.close()
  } finally {
    await browser.close()
  }
  return results
}

async function measureSimple(engine, probe) {
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(HOSTED_ORIGIN, { waitUntil: 'domcontentloaded' })
    return { default: await runProbes(page, probe) }
  } finally {
    await browser.close()
  }
}

const { server, wss } = await startProbeServer()
const probe = probeUrls(server)

let failed = false
const report = {}

try {
  console.log(`[mcp-lna-transport-smoke] hosted origin: ${HOSTED_ORIGIN}`)
  console.log(`[mcp-lna-transport-smoke] loopback probe: ${probe.fetchUrl} / ${probe.wsUrl}`)

  report.chromium = await measureChromium(probe)
  report.firefox = await measureSimple(firefox, probe)
  report.webkit = await measureSimple(webkit, probe)

  console.log('\n[mcp-lna-transport-smoke] results:')
  console.log(JSON.stringify(report, null, 2))
} catch (err) {
  console.error('[mcp-lna-transport-smoke] FAIL: measurement threw', err)
  failed = true
} finally {
  // The probe sockets stay open, and `server.close()` only stops new
  // connections — it waits for the live ones. Terminating the WebSocket server
  // first is what lets this harness exit instead of hanging.
  await new Promise((resolveClose) => wss.close(resolveClose))
  await new Promise((resolveClose) => server.close(resolveClose))
}

if (failed) {
  console.error('[mcp-lna-transport-smoke] FAIL')
  process.exit(1)
}
console.log(
  '[mcp-lna-transport-smoke] passed (measurement completed — interpret the table above manually)',
)
