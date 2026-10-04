#!/usr/bin/env node
// Behavioral smoke for the deployed service worker's update lifecycle: serves
// the built dist/ to a real Chromium and walks one worker through install,
// control, a waiting update the user accepts through the toast, the error
// screen's recovery, and an update accepted while the page is still making
// requests. register-sw.test.ts and reload-fresh.test.ts cover the
// same code through injected mocks, which cannot notice a build whose worker
// does not behave the way those mocks assume.
//
// dist/ is never modified. The server answers `/sw.js` with the built worker
// plus a message handler naming its version, and bumping the version changes
// the worker's bytes the way a deploy does — the browser installs it and, under
// registerType 'prompt', leaves it WAITING until the page asks.
import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDist } from '../../../tools/checks/src/serve-dist.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'dist')
const STEP_TIMEOUT_MS = 30_000
const RELOAD_ARRIVAL_TIMEOUT_MS = 10_000
const QUIET_MS = 1_000
// A step that cannot finish should fail the smoke, not hang a CI job.
setTimeout(() => {
  console.error('[smoke-pwa-lifecycle] gave up after 120s')
  process.exit(1)
}, 120_000).unref()

const state = {
  swVersion: 'v1',
  // A lazy page chunk the server refuses, to reach the error screen.
  refusedChunk: null,
  // While set, the next navigation request parks here until released.
  holdNavigation: null,
}

const versionHandler = (version) =>
  `\nself.addEventListener('message', (e) => { if (e.data === 'smoke:version') e.ports[0].postMessage('${version}') })\n`

// Requests the server has taken and not yet answered, for a step's timeout dump.
const serverInFlight = new Map()
let requestSeq = 0

// Runs before the file is looked up: tracks the request, parks a navigation the
// scenario asked to hold, and refuses a chunk it asked to lose.
async function onRequest(req, res, { pathname }) {
  const id = ++requestSeq
  serverInFlight.set(id, `${req.method} ${req.url}`)
  res.on('close', () => serverInFlight.delete(id))
  if (req.headers['sec-fetch-mode'] === 'navigate' && state.holdNavigation) {
    const hold = state.holdNavigation
    state.holdNavigation = null
    hold.arrived()
    await hold.released
  }
  if (state.refusedChunk && pathname.endsWith(state.refusedChunk)) {
    return { status: 404, body: 'not found' }
  }
}

const startServer = () =>
  serveDist({
    root: DIST,
    // A missing asset stays a 404: a catch-all would answer the page's HTML
    // where a step needs the browser to see the file gone.
    fallback: 'extensionless',
    // The browser's own update check already bypasses the HTTP cache for the
    // worker script; this keeps every other file honest too.
    headers: { 'Cache-Control': 'no-store' },
    onRequest,
    transform: (pathname, body) =>
      pathname === '/sw.js'
        ? Buffer.concat([body, Buffer.from(versionHandler(state.swVersion))])
        : body,
  })

const failures = []
function check(label, ok) {
  if (ok) {
    console.log(`  pass  ${label}`)
    return
  }
  console.error(`  FAIL  ${label}`)
  failures.push(label)
}

// A navigation destroys the execution context mid-evaluate, so a poll that
// reads the page has to treat that as "not yet" rather than as a failure.
async function until(label, read, describe) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) {
      const seen = describe ? await describe().catch((err) => `describe failed: ${err}`) : undefined
      const detail = seen === undefined ? '' : `\n${JSON.stringify(seen, null, 2)}`
      throw new Error(`timed out waiting for ${label}${detail}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

// What the page holds when a step gives up: which document this is, which
// worker controls it and what the registration carries, beside the browser's
// console tail — the first run on a CI runner timed out on the reload step
// and the bare message could not say which of those had not happened.
const workerSummary = (page) =>
  page.evaluate(async () => {
    const sw = (w) => (w ? { url: w.scriptURL, state: w.state } : null)
    const reg = await navigator.serviceWorker.getRegistration()
    return {
      href: location.href,
      firstDocument: window.__smokeFirstDocument,
      controller: sw(navigator.serviceWorker.controller),
      installing: sw(reg?.installing),
      waiting: sw(reg?.waiting),
      active: sw(reg?.active),
    }
  })

// Every request the page issued and has not seen finish or fail, with whether
// a worker answered it: an active worker whose fetch event never settles is
// what defers the waiting worker's skipWaiting.
const requestsInFlight = new Map()
let lastRequestAt = Date.now()
function trackRequests(page) {
  // A request its document took down with it can be left without a finish or
  // failure event, and would otherwise read as the page still loading.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) requestsInFlight.clear()
  })
  page.on('request', (r) => {
    lastRequestAt = Date.now()
    requestsInFlight.set(r, { url: r.url(), type: r.resourceType(), startedAt: Date.now() })
  })
  page.on('requestfinished', (r) => requestsInFlight.delete(r))
  page.on('requestfailed', (r) => requestsInFlight.delete(r))
}
const inFlight = () =>
  [...requestsInFlight.entries()].map(([r, info]) => ({
    ...info,
    ageMs: Date.now() - info.startedAt,
    fromServiceWorker: r.serviceWorker() !== null,
  }))

// The browser process's own view of every worker version: running status,
// lifecycle status and the clients it controls, as the DevTools protocol
// reports them. A page cannot see whether the worker controlling it is running.
const workerVersions = new Map()
let cdp
async function trackWorkerVersions(page) {
  cdp = await page.context().newCDPSession(page)
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    for (const v of versions) workerVersions.set(v.versionId, v)
  })
  cdp.on('ServiceWorker.workerErrorReported', ({ errorMessage }) => {
    consoleTail.push(`[sw-error] ${errorMessage.errorMessage}`)
  })
  await cdp.send('ServiceWorker.enable')
}
const versionsSeen = () =>
  [...workerVersions.values()].map((v) => ({
    versionId: v.versionId,
    status: v.status,
    runningStatus: v.runningStatus,
    controlledClients: v.controlledClients.length,
  }))

const consoleTail = []
function tailConsole(page) {
  page.on('console', (m) => {
    consoleTail.push(`[${m.type()}] ${m.text()}`)
    if (consoleTail.length > 40) consoleTail.shift()
  })
  page.on('pageerror', (err) => {
    consoleTail.push(`[pageerror] ${err.message}`)
    if (consoleTail.length > 40) consoleTail.shift()
  })
}

const controllerVersion = (page) =>
  page.evaluate(
    () =>
      new Promise((resolveVersion) => {
        // A worker being replaced never answers.
        setTimeout(() => resolveVersion(null), 1000)
        const controller = navigator.serviceWorker.controller
        if (!controller) return resolveVersion(null)
        const channel = new MessageChannel()
        channel.port1.onmessage = (e) => resolveVersion(e.data)
        controller.postMessage('smoke:version', [channel.port2])
      }),
  )

const hasWaitingWorker = (page) =>
  page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting != null)

// registerType 'prompt' registers without claiming clients, so the first load
// is never controlled: the worker takes over on the next navigation.
async function installAndControl(page, origin, version) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.reload({ waitUntil: 'networkidle' })
  check(
    `the ${version} worker controls the page after a reload`,
    (await controllerVersion(page)) === version,
  )
  await waitUntilSettled(page)
}

// Until the app has drawn its first screen and stopped asking for chunks.
// 'networkidle' is not that: loro's WASM initialises in a quiet gap longer
// than the half second it waits for, and on a slow runner the route's lazy
// chunks are requested after it has already returned. A request the page makes
// while the browser is swapping workers can strand the swap, so an update is
// only offered to a page that is not still loading.
async function waitUntilSettled(page) {
  await page
    .getByText('What will you make first?')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  await until(
    'the page to stop requesting',
    () => Promise.resolve(requestsInFlight.size === 0 && Date.now() - lastRequestAt > QUIET_MS),
    async () => ({
      requestsInFlight: inFlight(),
      sinceLastRequestMs: Date.now() - lastRequestAt,
    }),
  )
}

async function waitForUpdate(page, current, next) {
  state.swVersion = next
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    await registration?.update()
  })
  await until('a waiting worker', () => hasWaitingWorker(page))
  check('a deploy leaves the new worker waiting', true)
  check(
    'the page is still controlled by the old worker',
    (await controllerVersion(page)) === current,
  )
  const toast = page.getByRole('status').filter({ hasText: 'Update available' })
  await toast.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  check('the update toast is offered', true)
  return toast
}

// Whether the old worker's running state is what holds the activation: stop
// it from the browser side, then read every version again.
async function stopActiveWorkerAndRead() {
  const active = [...workerVersions.values()].find(
    (v) => v.status === 'activated' && v.runningStatus === 'running',
  )
  if (!active) return 'no running activated version to stop'
  await cdp.send('ServiceWorker.stopWorker', { versionId: active.versionId })
  await new Promise((r) => setTimeout(r, 3000))
  return versionsSeen()
}

// What the page, the server and the browser hold when the reload never lands.
async function describeReloadStall(page) {
  return {
    ...(await workerSummary(page)),
    posted: await page.evaluate(() => window.__smokePosted),
    console: consoleTail,
    requestsInFlight: inFlight(),
    serverInFlight: [...serverInFlight.values()],
    versions: versionsSeen(),
    afterStoppingActive: await stopActiveWorkerAndRead().catch(
      (err) => `stop probe failed: ${err}`,
    ),
    // Whether the waiting worker honours a skip at all from this page: the
    // same message the toast's path sends, posted directly, then its state.
    afterDirectSkip: await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration()
      reg?.waiting?.postMessage({ type: 'SKIP_WAITING' })
      await new Promise((r) => setTimeout(r, 3000))
      const sw = (w) => (w ? { url: w.scriptURL, state: w.state } : null)
      return {
        waiting: sw(reg?.waiting),
        active: sw(reg?.active),
        firstDocument: window.__smokeFirstDocument,
      }
    }),
  }
}

// Messaging the controller while it is being replaced is avoided on purpose:
// the swap is observed through the document being replaced, and the version
// is asked of the controller once the new document holds it.
async function acceptUpdate(page, toast, version) {
  await page.evaluate(() => {
    window.__smokeFirstDocument = true
    // Every message the page sends a worker, so a step that gives up can say
    // whether the toast's Reload ever asked the waiting worker to skip.
    window.__smokePosted = []
    const post = ServiceWorker.prototype.postMessage
    ServiceWorker.prototype.postMessage = function (...args) {
      window.__smokePosted.push({ to: this.state, message: JSON.stringify(args[0]) })
      return post.apply(this, args)
    }
  })
  await toast.getByRole('button', { name: 'Reload' }).click()
  await until(
    'the page to reload onto a controller',
    () =>
      page.evaluate(
        () =>
          window.__smokeFirstDocument === undefined && navigator.serviceWorker.controller !== null,
      ),
    () => describeReloadStall(page),
  )
  check(
    "the toast's Reload moves the page onto the new worker",
    (await controllerVersion(page)) === version,
  )
  check('nothing is left waiting afterwards', !(await hasWaitingWorker(page)))
}

// What the browser answers when the page asks the registered worker its version.
const registrationVersion = (page) =>
  page.evaluate(
    () =>
      new Promise((resolveVersion) => {
        setTimeout(() => resolveVersion(null), 1000)
        navigator.serviceWorker
          .getRegistration()
          .then((registration) => {
            if (!registration?.active) return resolveVersion(null)
            const channel = new MessageChannel()
            channel.port1.onmessage = (e) => resolveVersion(e.data)
            registration.active.postMessage('smoke:version', [channel.port2])
          })
          .catch(() => resolveVersion(null))
      }),
  )

// A page that keeps making requests while the browser swaps workers. Chrome
// stops the old worker to activate the new one, and a request from a page it
// still controls restarts it: the activation is lost and the new worker stays
// waiting for the browser's five-minute ceiling, however often it is asked.
// The page's own recovery is a reload that bypasses every worker, so what is
// pinned is the outcome — the page ends on the new version — whichever way
// the swap went.
async function acceptUpdateWhileRequesting(page, toast, version) {
  await page.evaluate(() => {
    window.__smokeFirstDocument = true
    const post = ServiceWorker.prototype.postMessage
    ServiceWorker.prototype.postMessage = function (...args) {
      if (args[0]?.type === 'SKIP_WAITING') {
        for (let i = 1; i <= 20; i++) {
          setTimeout(() => void fetch('/favicon.svg', { cache: 'no-store' }).catch(() => {}), i * 5)
        }
      }
      return post.apply(this, args)
    }
  })
  await toast.getByRole('button', { name: 'Reload' }).click()
  await until(
    'the page to be replaced after the update was accepted',
    () => page.evaluate(() => window.__smokeFirstDocument === undefined),
    () => describeReloadStall(page),
  )
  await until(
    `the ${version} worker to be registered`,
    async () => (await registrationVersion(page)) === version,
  )
  check(
    'an update accepted while the page is requesting ends on the new worker',
    !(await hasWaitingWorker(page)),
  )
}

// A chunk the server no longer has, and that the worker no longer holds, is
// what a deploy that replaced the bundle looks like to a page that kept the
// old one. The app answers it with its error screen and a Reload button.
async function reachErrorScreen(page, origin) {
  const chunk = readdirSync(resolve(DIST, 'assets')).find((name) =>
    name.startsWith('BrowserIndexPage-'),
  )
  if (!chunk) throw new Error('no BrowserIndexPage chunk in dist/assets')
  state.refusedChunk = chunk
  await page.evaluate(async (name) => {
    for (const key of await caches.keys()) {
      const cache = await caches.open(key)
      for (const request of await cache.keys()) {
        if (request.url.endsWith(name)) await cache.delete(request)
      }
    }
  }, chunk)
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  const reload = page.getByRole('button', { name: 'Reload' })
  await reload.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  check('a missing chunk lands on the error screen', true)
  return reload
}

async function recoverFresh(page, reload, origin) {
  state.refusedChunk = null
  let arrived
  const arrival = new Promise((r) => {
    arrived = r
  })
  let release
  const released = new Promise((r) => {
    release = r
  })
  state.holdNavigation = { arrived, released }
  // Without noWaitAfter the click waits for the very navigation parked below.
  await reload.click({ noWaitAfter: true })
  // The reload's own navigation parks at the server, so what reloadFresh
  // cleared is read before the next page can register anything again. Playwright
  // will not evaluate in a page whose navigation is pending, so a second page
  // of the same origin reads it: registrations and caches are per origin.
  // A worker still registered answers the reload from its precache and the
  // request never arrives, which is the failure this waits to see.
  const reachedNetwork = await Promise.race([
    arrival.then(() => true),
    new Promise((r) => setTimeout(() => r(false), RELOAD_ARRIVAL_TIMEOUT_MS)),
  ])
  check('the reload goes to the network rather than to a worker', reachedNetwork)
  if (!reachedNetwork) {
    release()
    return
  }
  const probe = await page.context().newPage()
  await probe.goto(`${origin}favicon.svg`)
  const left = await probe.evaluate(async () => ({
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    caches: (await caches.keys()).length,
  }))
  release()
  check('reloadFresh leaves no service worker registration', left.registrations === 0)
  check('reloadFresh leaves no cache', left.caches === 0)
}

if (!existsSync(DIST)) {
  console.error('[smoke-pwa-lifecycle] dist/ not found — run pnpm build first')
  process.exit(1)
}

const app = await startServer()
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WHITEBOARD_CHROME_PATH && { executablePath: process.env.WHITEBOARD_CHROME_PATH }),
})
try {
  const origin = `${app.origin}/`
  const page = await (await browser.newContext()).newPage()
  tailConsole(page)
  trackRequests(page)
  await trackWorkerVersions(page)
  console.log(`[smoke-pwa-lifecycle] ${browser.browserType().name()} ${browser.version()}`)
  await installAndControl(page, origin, 'v1')
  const toast = await waitForUpdate(page, 'v1', 'v2')
  await acceptUpdate(page, toast, 'v2')
  const reload = await reachErrorScreen(page, origin)
  await recoverFresh(page, reload, origin)
  // The recovered page is still loading, and a navigation begun now would
  // collide with the app's own redirect.
  await waitUntilSettled(page)
  await installAndControl(page, origin, 'v2')
  await acceptUpdateWhileRequesting(page, await waitForUpdate(page, 'v2', 'v3'), 'v3')
} catch (err) {
  console.error(`  FAIL  ${err.message}`)
  failures.push(err.message)
} finally {
  await browser.close()
  await app.close()
}

if (failures.length > 0) {
  console.error('[smoke-pwa-lifecycle] check failed')
  process.exit(1)
}
console.log('[smoke-pwa-lifecycle] passed')
