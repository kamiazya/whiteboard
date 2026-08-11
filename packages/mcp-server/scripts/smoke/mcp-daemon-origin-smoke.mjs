// Real-browser proof of the daemon's hosted-first UI end state (ADR-0001
// addendum): the daemon serves exactly ONE page — /pair, the pairing consent
// trust anchor — and redirects every other UI path to the official hosted
// app. Requires a real prior `pnpm build` so it exercises the actual built
// dist/web-app, not a fixture.
//
// What this pins:
// 1. The bare origin (and any other UI path) answers 302 to the official
//    hosted app URL, and the redirect leaks no token.
// 2. /pair renders the real consent page from the built bundle, with the
//    daemon's identity fingerprint (proves the daemon-served page, its
//    asset serving, AND the identity ping end-to-end in one shot).
// 3. Reserved paths keep their non-UI semantics (/token stays 404).
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
// import below.
const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-daemon-origin-smoke-'))
process.env.WHITEBOARD_DATA_DIR = dataDir

const { startHttpServer } = await import(resolve(root, 'src/server/http-server.ts'))
const { findAvailablePort } = await import(resolve(root, 'src/cli/daemon-run.ts'))

const TOKEN = 'smoke-daemon-origin-token-pair-only'
const OFFICIAL_HOSTED_APP_URL = 'https://kamiazya-whiteboard.pages.dev/'

const port = await findAvailablePort(4300)
const running = await startHttpServer({ port, host: '127.0.0.1', token: TOKEN })
const daemonBaseUrl = `http://127.0.0.1:${port}`

let failed = false

// --- 1. Redirect contract (plain fetch, redirects not followed) ---
for (const path of ['/', '/local/some-canvas', '/w/ws/c/alias']) {
  const res = await fetch(`${daemonBaseUrl}${path}`, { redirect: 'manual' })
  const location = res.headers.get('location')
  if (res.status === 302 && location === OFFICIAL_HOSTED_APP_URL && !location.includes(TOKEN)) {
    console.log(`  pass  ${path} redirects to the official hosted app`)
  } else {
    console.error(
      `  FAIL  ${path} expected 302 -> ${OFFICIAL_HOSTED_APP_URL}, got ${res.status} -> ${location}`,
    )
    failed = true
  }
}

// Reserved path semantics survive the catch-all change.
const tokenRes = await fetch(`${daemonBaseUrl}/token`, { redirect: 'manual' })
if (tokenRes.status === 404) {
  console.log('  pass  /token stays 404 (reserved, never redirected)')
} else {
  console.error(`  FAIL  /token expected 404, got ${tokenRes.status}`)
  failed = true
}

// --- 2. /pair renders the real consent page in a real browser ---
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WHITEBOARD_CHROME_PATH && {
    executablePath: process.env.WHITEBOARD_CHROME_PATH,
  }),
})

const consoleErrors = []
try {
  const page = await browser.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => {
    consoleErrors.push(`uncaught: ${err.message}`)
  })

  const pairUrl = `${daemonBaseUrl}/pair?origin=${encodeURIComponent(
    'https://app.example',
  )}&challenge=smoke-challenge&state=smoke-state`
  // 'load', not 'networkidle': the service worker's precache traffic can
  // keep the network busy past the goto timeout, and every assertion below
  // waits explicitly anyway.
  await page.goto(pairUrl, { waitUntil: 'load' })

  // waitFor, not isVisible: isVisible ignores its timeout and reports the
  // instantaneous state, which races the boot splash's deliberate hold
  // (apps/web/src/boot-splash.ts) — the app renders ~1.7s after load.
  const consentHeading = page.getByRole('heading', {
    name: /allow this web app to use your local daemon/i,
  })
  const consentVisible = await consentHeading
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (consentVisible) {
    console.log('  pass  /pair renders the consent page from the built bundle')
  } else {
    console.error('  FAIL  /pair did not render the consent heading')
    failed = true
  }

  // The fingerprint proves the identity ping worked end-to-end from the
  // daemon-served page (daemon identity keypair -> ping -> WebCrypto
  // fingerprint render).
  const fingerprint = page.getByTestId('daemon-fingerprint')
  const fingerprintText = await fingerprint.textContent({ timeout: 10_000 }).catch(() => null)
  if (fingerprintText !== null && /^[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(fingerprintText.trim())) {
    console.log(`  pass  /pair shows the daemon identity fingerprint (${fingerprintText.trim()})`)
  } else {
    console.error(`  FAIL  no daemon identity fingerprint rendered (got: ${fingerprintText})`)
    failed = true
  }

  // A browser navigation to the bare origin must land on the hosted app URL
  // (it will fail to LOAD offline/in CI — the assertion is the URL, so stop
  // at 'commit' and tolerate a network error for the external origin).
  await page.goto(`${daemonBaseUrl}/`, { waitUntil: 'commit' }).catch(() => {})
  const landedUrl = page.url()
  if (landedUrl.startsWith(OFFICIAL_HOSTED_APP_URL)) {
    console.log('  pass  navigating the bare origin follows the redirect to the hosted app')
  } else {
    console.error(`  FAIL  bare-origin navigation landed on ${landedUrl}`)
    failed = true
  }
} finally {
  await browser.close()
  await running.close()
  rmSync(dataDir, { recursive: true, force: true })
}

if (consoleErrors.length > 0) {
  // Console errors on /pair are diagnostic only for the external-origin
  // navigation (expected to fail to load in an offline CI sandbox) — but a
  // consent-page error is a real failure signal worth surfacing.
  console.log(`  note  browser console errors observed:\n    ${consoleErrors.join('\n    ')}`)
}

if (failed) {
  console.error('[mcp-daemon-origin-smoke] FAIL')
  process.exit(1)
}
console.log('[mcp-daemon-origin-smoke] PASS')
