#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
// Behavioral artifact smoke: loads the built dist/ in a real Chromium browser with
// __WHITEBOARD_RUNTIME_CONFIG__.publicOrigin set to a preview URL and asserts that
// App renders data-provider="invalid-config" rather than entering browser-local mode.
//
// In production Cloudflare Pages deploys the publicOrigin config value is the primary
// mechanism used to reject preview deploys. This test verifies that the built artifact
// (not just unit tests) correctly enforces that contract end-to-end.
//
// The static bundle check in smoke-artifact.mjs verifies separately that
// window.location.origin is also wired up as a secondary defense.
import { createServer } from 'node:http'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'dist')

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '': 'application/octet-stream',
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let urlPath = new URL(req.url, 'http://localhost').pathname
      if (urlPath === '/' || !urlPath.includes('.')) urlPath = '/index.html'
      const filePath = `${DIST}${urlPath}`
      if (!existsSync(filePath)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const ext = extname(filePath)
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? MIME[''] })
      res.end(readFileSync(filePath))
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

if (!existsSync(DIST)) {
  console.error('[smoke-preview-origin] dist/ not found — run pnpm build first')
  process.exit(1)
}

const { server, port } = await startServer()
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WHITEBOARD_CHROME_PATH && {
    executablePath: process.env.WHITEBOARD_CHROME_PATH,
  }),
})
let failed = false

try {
  const page = await browser.newPage()

  // Inject a runtime config that sets publicOrigin to a Cloudflare Pages preview URL.
  // resolveHostedRuntimeConfig rejects preview publicOrigin values, so the app must
  // render data-provider="invalid-config". This mirrors how a real CF Pages deploy
  // would behave: the Workers/Pages platform injects __WHITEBOARD_RUNTIME_CONFIG__
  // with the deploy's public origin before serving the HTML.
  await page.addInitScript(() => {
    // eslint-disable-next-line no-undef
    window.__WHITEBOARD_RUNTIME_CONFIG__ = { publicOrigin: 'https://abc123.whiteboard.pages.dev' }
  })

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })

  // Wait for the element rather than sampling count() immediately after
  // networkidle: React mounts <main> asynchronously (and the page components
  // are lazy-loaded), so an instant count races the hydration and flakes.
  const invalidConfig = page.locator('main[data-provider="invalid-config"]')
  const appeared = await invalidConfig
    .waitFor({ state: 'attached', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (appeared) {
    console.log('  pass  App renders data-provider="invalid-config" for preview publicOrigin')
  } else {
    const provider = await page
      .locator('main')
      .first()
      .getAttribute('data-provider')
      .catch(() => '(no main)')
    console.error(`  FAIL  expected data-provider="invalid-config", got: ${provider}`)
    failed = true
  }
} finally {
  await browser.close()
  server.close()
}

if (failed) {
  console.error('[smoke-preview-origin] check failed')
  process.exit(1)
} else {
  console.log('[smoke-preview-origin] passed')
}
