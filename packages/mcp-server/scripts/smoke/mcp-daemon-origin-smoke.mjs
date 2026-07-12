#!/usr/bin/env node
// Real-browser proof for R3 of the MCP-UI retirement (ADR 0001): a real
// Chromium tab loads the local daemon's own origin — no `#wb=` fragment,
// same-origin — and gets the canonical apps/web UI with a working canvas
// list. Requires a real prior `pnpm build` so it exercises the actual
// built dist/web-app, not a fixture.
//
// Direct invocation requires tsx:
//   node --import tsx/esm scripts/smoke/mcp-daemon-origin-smoke.mjs
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const webAppIndexHtml = resolve(root, 'dist/web-app/index.html')

if (!existsSync(webAppIndexHtml)) {
  console.error(
    `[mcp-daemon-origin-smoke] FAIL: ${webAppIndexHtml} not found — run \`pnpm build\` (from the repo root, so apps/web's postbuild copy runs) first`,
  )
  process.exit(1)
}

const { startHttpServer } = await import(resolve(root, 'src/server/http-server.ts'))
const { findAvailablePort } = await import(resolve(root, 'src/cli/daemon-run.ts'))

const port = await findAvailablePort(4300)
const running = await startHttpServer({ port, host: '127.0.0.1' })
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WHITEBOARD_CHROME_PATH && {
    executablePath: process.env.WHITEBOARD_CHROME_PATH,
  }),
})

let failed = false
const consoleErrors = []

try {
  const page = await browser.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => {
    consoleErrors.push(`uncaught: ${err.message}`)
  })

  // The daemon origin itself — no #wb= fragment. This is the "open the
  // daemon and get the canonical UI" scenario the retirement is pinning.
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })

  const galleryHeading = page.getByRole('heading', { name: /canvases|whiteboard/i }).first()
  const galleryVisible = await galleryHeading
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (galleryVisible) {
    console.log('  pass  the daemon origin renders the apps/web canvas gallery')
  } else {
    console.error('  FAIL  no recognizable gallery heading rendered at the daemon origin')
    failed = true
  }

  // R3 pins no service worker on the daemon origin (see
  // apps/web/scripts/copy-into-mcp-dist.mjs) — a stale precached shell would
  // pin an old injected daemon token across restarts.
  const swController = await page.evaluate(() => navigator.serviceWorker?.controller ?? null)
  if (swController === null) {
    console.log('  pass  no service worker controls the daemon-origin page')
  } else {
    console.error('  FAIL  a service worker is controlling the daemon-origin page')
    failed = true
  }

  const swRegistrationErrors = consoleErrors.filter((line) => /sw\.js|service.?worker/i.test(line))
  const uncaughtErrors = consoleErrors.filter((line) => line.startsWith('uncaught:'))
  if (uncaughtErrors.length === 0) {
    console.log('  pass  no uncaught page errors (absent sw.js is caught and logged, not thrown)')
  } else {
    console.error(`  FAIL  uncaught page errors: ${uncaughtErrors.join('; ')}`)
    failed = true
  }
  if (swRegistrationErrors.length > 0) {
    console.log(
      `  note  ${swRegistrationErrors.length} console error(s) mention the service worker (expected: registration is attempted and its rejection is caught+logged) — ${swRegistrationErrors.join('; ')}`,
    )
  }
} finally {
  await browser.close()
  await running.close()
}

if (failed) {
  console.error('[mcp-daemon-origin-smoke] FAIL')
  process.exit(1)
}
console.log('[mcp-daemon-origin-smoke] passed')
