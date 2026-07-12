#!/usr/bin/env node
// Real-browser proof for R3 of the MCP-UI retirement (ADR 0001) AND for the
// daemon-auto-open-browser feature: a real Chromium tab loading the local
// daemon's own origin lands directly in a CONNECTED, working app — same
// origin, no `#wb=` fragment, no pairing step — because the daemon injects
// the token server-side into the HTML it serves. Requires a real prior
// `pnpm build` so it exercises the actual built dist/web-app, not a
// fixture.
//
// The auto-open feature's whole reason to exist is that a human opening
// this URL manually (or via the OS auto-launching a browser tab) must NOT
// need to run through the pairing flow. This script is the proof: it seeds
// a real canvas through the daemon's own HTTP API (not a fixture write),
// then drives a real browser to the bare origin and asserts the canvas
// gallery shows it, the "Check for local daemon" pairing CTA is absent, and
// opening the canvas actually renders it.
//
// Direct invocation requires tsx:
//   node --import tsx/esm scripts/smoke/mcp-daemon-origin-smoke.mjs
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

// `server/config.ts`'s DATA_DIR is a module-level constant captured from
// WHITEBOARD_DATA_DIR at import time — it MUST be set before the dynamic
// import below, or this smoke silently reuses whatever data dir the
// developer's own daemon uses (and a re-run collides with the canvas slug
// this script seeds on every invocation).
const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-daemon-origin-smoke-'))
process.env.WHITEBOARD_DATA_DIR = dataDir

const { startHttpServer } = await import(resolve(root, 'src/server/http-server.ts'))
const { findAvailablePort } = await import(resolve(root, 'src/cli/daemon-run.ts'))

const TOKEN = 'smoke-daemon-origin-token-connected-app'
const WORKSPACE_ID = 'sess-daemon-origin-smoke'
const CANVAS_SLUG = 'daemon-origin-smoke-canvas'

const port = await findAvailablePort(4300)
const running = await startHttpServer({ port, host: '127.0.0.1', token: TOKEN })

const daemonBaseUrl = `http://127.0.0.1:${port}`

async function authedFetch(path, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  return fetch(`${daemonBaseUrl}${path}`, { ...init, headers })
}

// Seed a real canvas through the live daemon's own HTTP API — same route
// the apps/web gallery itself calls — so this proves the served app is
// actually reading daemon-backed state, not a coincidental empty gallery.
const createRes = await authedFetch(
  `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/canvases`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: CANVAS_SLUG }),
  },
)
if (!createRes.ok) {
  const body = await createRes.text().catch(() => '')
  console.error(
    `[mcp-daemon-origin-smoke] FAIL: seed canvas POST failed: ${createRes.status} ${body}`,
  )
  await running.close()
  process.exit(1)
}

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
  // daemon and get the canonical UI, already connected" scenario the
  // auto-open feature (and the retirement) are pinning.
  await page.goto(`${daemonBaseUrl}/`, { waitUntil: 'networkidle' })

  if (page.url().includes('#wb=')) {
    console.error(`  FAIL  daemon origin URL carries a #wb= pairing fragment: ${page.url()}`)
    failed = true
  } else {
    console.log('  pass  no #wb= pairing fragment on the daemon origin URL')
  }

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

  // Connected-to-daemon proof: the gallery must show the canvas seeded
  // through the live daemon's own API above. A stale/disconnected app would
  // render an empty gallery instead (browser-local mode has no daemon data
  // to read from).
  const seededSlug = page.getByTestId('canvas-slug').filter({ hasText: CANVAS_SLUG })
  const seededVisible = await seededSlug
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (seededVisible) {
    console.log('  pass  gallery shows the canvas seeded through the live daemon API')
  } else {
    console.error(
      '  FAIL  seeded canvas slug not visible in the gallery — app may not be reading daemon data',
    )
    failed = true
  }

  // Not-connected proof: the "Check for local daemon" CTA only renders in
  // the browser-local (disconnected) provider path — its presence here
  // would mean the daemon token injection failed and the app fell back to
  // browser-local storage instead of talking to this daemon.
  const pairingCta = await page
    .getByText('Check for local daemon', { exact: false })
    .first()
    .isVisible()
    .catch(() => false)
  if (pairingCta) {
    console.error(
      '  FAIL  the browser-local "Check for local daemon" CTA is visible — not connected',
    )
    failed = true
  } else {
    console.log('  pass  no "Check for local daemon" CTA (already connected, no pairing needed)')
  }

  // Opening the seeded canvas must actually render it, not just list it.
  // DaemonCanvasPage mounts the `Excalidraw` component directly (no
  // wrapping `data-testid` of its own — that convention only exists on
  // BrowserLocalCanvasPage), so the library's own root `.excalidraw` class
  // is the stable, page-agnostic signal that the canvas actually rendered.
  if (seededVisible) {
    await seededSlug.click()
    const excalidrawVisible = await page
      .locator('.excalidraw')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
    if (excalidrawVisible) {
      console.log('  pass  opening the seeded canvas renders the Excalidraw surface')
    } else {
      console.error('  FAIL  opening the seeded canvas did not render the Excalidraw surface')
      failed = true
    }
  }

  // Token-injection proof: `/api/*` only gates MUTATION methods (POST/PUT/
  // DELETE/PATCH — see routes/auth.ts createDaemonMutationAuthMiddleware),
  // so an unauthenticated GET-only check (gallery listing, opening a
  // canvas) would pass even if the server had stopped injecting
  // `__WHITEBOARD_DAEMON_TOKEN__`. Driving a real WRITE through the UI
  // (creating a canvas) is what actually depends on the injected token
  // reaching `readDaemonTokenOnce()` and riding along on the browser's own
  // fetch — this is the assertion the token-injection mutation-check pins.
  // A fresh navigation back to `/` (not `page.goBack()`) deliberately, so
  // this step doesn't inherit the canvas page's live WS reconnect loop —
  // that loop keeps the network "busy" forever once connected, so a
  // history-back navigation never reaches a quiet state to interact from.
  await page.goto(`${daemonBaseUrl}/`, { waitUntil: 'domcontentloaded' })
  const newCanvasSlug = 'daemon-origin-smoke-new-canvas'
  const newCanvasNameInput = page.getByLabel('New canvas name')
  // handleCreate in DaemonIndexPage.tsx navigates straight into the newly
  // created canvas on success (onOpenCanvas), rather than staying on the
  // gallery — so success is "the URL now names the new canvas", and
  // failure (401 from a missing token) is "a createError alert appears and
  // the gallery URL is unchanged". Race both outcomes instead of waiting
  // for only one, so an auth failure resolves promptly instead of only
  // being caught by the outer timeout.
  const created = await newCanvasNameInput
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => newCanvasNameInput.fill(newCanvasSlug))
    .then(() => page.getByRole('button', { name: 'Create canvas' }).click())
    .then(() =>
      Promise.race([
        page
          .waitForURL((url) => url.pathname.includes(newCanvasSlug), { timeout: 15_000 })
          .then(() => true),
        page
          .getByRole('alert')
          .waitFor({ state: 'visible', timeout: 15_000 })
          .then(() => false),
      ]),
    )
    .catch(() => false)
  if (created) {
    console.log(
      '  pass  creating a canvas through the UI succeeds (token reached the mutation gate)',
    )
  } else {
    console.error(
      '  FAIL  creating a canvas through the UI did not succeed — the injected token may be missing',
    )
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
  // Both must be attempted even if one throws — otherwise a browser.close()
  // failure would leave the daemon's listening port open for the rest of
  // the process's lifetime.
  const [browserResult, serverResult] = await Promise.allSettled([browser.close(), running.close()])
  for (const result of [browserResult, serverResult]) {
    if (result.status === 'rejected') {
      console.error('[mcp-daemon-origin-smoke] cleanup error:', result.reason)
    }
  }
  rmSync(dataDir, { recursive: true, force: true })
}

if (failed) {
  console.error('[mcp-daemon-origin-smoke] FAIL')
  process.exit(1)
}
console.log('[mcp-daemon-origin-smoke] passed')
