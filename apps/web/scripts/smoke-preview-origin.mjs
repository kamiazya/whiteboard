#!/usr/bin/env node
import { existsSync } from 'node:fs'
// Behavioral artifact smoke: loads the built dist/ in a real Chromium browser and
// asserts the hosted app's Cloudflare Pages preview policy end to end, on the
// built artifact rather than through unit tests alone:
//
// - an injected __WHITEBOARD_RUNTIME_CONFIG__ whose publicOrigin is a preview
//   URL renders data-provider="invalid-config": a preview may never claim to be
//   the production origin;
// - the app SERVED AT a preview origin with no runtime config enters the
//   browser keeper, because previews are meant to be usable;
// - the same preview origin given a daemonBaseUrl renders invalid-config: a
//   preview deploy never connects to a daemon.
//
// Pages serves dist/ as static files and injects no runtime config; only a
// server-mode keeper does (mcp-server's server-mode-web-app.ts). The configs
// here are injected with an init script, standing in for a deploy that
// carries one.
//
// A second, plain load of the same build asserts the other half of that story:
// the hosted app registers its service worker and, after a reload, is controlled
// by it. Everything else about the worker is unit-tested through injected
// mocks, which cannot notice a build whose worker never installs.
//
// The static bundle check in smoke-artifact.mjs verifies separately that
// window.location.origin is also wired up as a secondary defense.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDist } from '../../../tools/checks/src/serve-dist.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'dist')

// registerType 'prompt' registers without claiming clients, so the first load
// is never controlled: the worker takes over on the NEXT navigation. The
// registration waits for window 'load' behind a dynamic import, hence `ready`
// (which resolves only once a registration is active) before reloading.
async function serviceWorkerControlsReload(browser, origin) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(origin, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, {
      timeout: 30_000,
    })
    await page.reload({ waitUntil: 'networkidle' })
    return await page.evaluate(() => navigator.serviceWorker.controller !== null)
  } finally {
    await context.close()
  }
}

// A host classifyPagesOrigin reads as 'preview': any subdomain of the
// production project. A pages.dev host of some OTHER project is a different
// class (custom-domain-deferred) and would prove a different branch.
const PREVIEW_ORIGIN = 'https://abc123.kamiazya-whiteboard.pages.dev'

// Which keeper the page settled on. The invalid-config screen carries its
// own marker; any other outcome draws the app shell's mark. With no
// daemonBaseUrl in the config and a fresh browser context holding no
// remembered daemon, the browser keeper is the only one that can draw it.
async function settledKeeper(page) {
  const invalid = page.locator('main[data-provider="invalid-config"]')
  const shell = page.getByTestId('shell-mark')
  await invalid
    .or(shell)
    .first()
    .waitFor({ state: 'attached', timeout: 15_000 })
    .catch(() => {})
  if ((await invalid.count()) > 0) return 'invalid-config'
  if ((await shell.count()) > 0) return 'app shell'
  return '(neither marker)'
}

// Loads the build as if served AT the preview origin: every request to it is
// answered from the local dist server, so window.location.origin is the
// preview host. Service workers are blocked because a worker's own fetches
// bypass request routing.
async function keeperAtPreviewOrigin(browser, appOrigin, runtimeConfig) {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    await context.route(`${PREVIEW_ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      const response = await route.fetch({ url: `${appOrigin}${url.pathname}${url.search}` })
      await route.fulfill({ response })
    })
    const page = await context.newPage()
    if (runtimeConfig !== undefined) {
      await page.addInitScript((config) => {
        window.__WHITEBOARD_RUNTIME_CONFIG__ = config
      }, runtimeConfig)
    }
    await page.goto(`${PREVIEW_ORIGIN}/`, { waitUntil: 'networkidle' })
    return await settledKeeper(page)
  } finally {
    await context.close()
  }
}

function expectKeeper(actual, expected, label) {
  if (actual === expected) {
    console.log(`  pass  ${label}`)
    return true
  }
  console.error(`  FAIL  ${label}: expected ${expected}, got ${actual}`)
  return false
}

if (!existsSync(DIST)) {
  console.error('[smoke-preview-origin] dist/ not found — run pnpm build first')
  process.exit(1)
}

// A missing asset must stay a 404: the worker's precache would otherwise
// "succeed" on the page's HTML in place of the file it asked for.
const app = await serveDist({ root: DIST, fallback: 'extensionless' })
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WHITEBOARD_CHROME_PATH && {
    executablePath: process.env.WHITEBOARD_CHROME_PATH,
  }),
})
let failed = false

try {
  const page = await browser.newPage()
  await page.addInitScript((origin) => {
    window.__WHITEBOARD_RUNTIME_CONFIG__ = { publicOrigin: origin }
  }, PREVIEW_ORIGIN)
  await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' })
  const checks = [
    expectKeeper(
      await settledKeeper(page),
      'invalid-config',
      'a preview publicOrigin in the runtime config renders invalid-config',
    ),
    expectKeeper(
      await keeperAtPreviewOrigin(browser, app.origin, undefined),
      'app shell',
      'served at a preview origin with no runtime config, the browser keeper answers',
    ),
    expectKeeper(
      await keeperAtPreviewOrigin(browser, app.origin, { daemonBaseUrl: 'http://127.0.0.1:3099' }),
      'invalid-config',
      'served at a preview origin, a daemonBaseUrl is refused with invalid-config',
    ),
  ]
  if (checks.includes(false)) failed = true

  const controlled = await serviceWorkerControlsReload(browser, `${app.origin}/`).catch(() => false)
  if (controlled) {
    console.log('  pass  a service worker controls the page after its registration settles')
  } else {
    console.error('  FAIL  no service worker controls the hosted app after a reload')
    failed = true
  }
} finally {
  await browser.close()
  await app.close()
}

if (failed) {
  console.error('[smoke-preview-origin] check failed')
  process.exit(1)
} else {
  console.log('[smoke-preview-origin] passed')
}
