// Real-browser proof of ADR-0050's bridge: a page reaches the local daemon
// through this extension, the native host `whiteboard native-host` installs,
// and the daemon's owner-only socket — every piece the real one, in headless
// Chromium.
//
// What this pins:
// 1. An admitted page is answered by the extension, and its requests reach
//    the daemon with the daemon's credential — not one the page supplied.
// 2. An SSE stream arrives as it is written.
// 3. A request outside /api/ is refused before it reaches the daemon.
// 4. The built web app connects through the extension from a browser-kept
//    document, reads what an agent wrote on the daemon, writes back, and
//    sees the agent's next edit arrive live.
// 5. The production build admits no loopback page at all.
//
// Branded Chrome ignores --load-extension, so this needs Playwright's own
// Chromium: `pnpm exec playwright install chromium`.
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import {
  agentEdits,
  buildAll,
  createSmoke,
  daemonNoteContains,
  EXTENSION_DIR,
  seedNote,
  serve,
  startDaemon,
  stopDaemon,
  whiteboard,
} from './smoke-kit.mjs'

const EXTENSION_ID = 'ckgipndlpblkhiplhnbbdnpnibflplje'
const smoke = createSmoke('bridge-smoke')
const { check, dataDir, scratch } = smoke

/** The page: asks for everything at once and reports what came back. */
const PAGE = `<!doctype html><meta charset="utf-8"><script>
const results = { messages: [], bodies: {} }
chrome.runtime.sendMessage('${EXTENSION_ID}', { type: 'hello' }, (reply) => { results.hello = reply ?? null })
const port = chrome.runtime.connect('${EXTENSION_ID}')
port.onMessage.addListener((m) => {
  results.messages.push({ type: m.type, id: m.id, status: m.status, reason: m.reason })
  if (m.type === 'chunk') results.bodies[m.id] = (results.bodies[m.id] ?? '') + atob(m.data)
  if (m.id === 'stream' && (results.bodies.stream ?? '').includes('event: ready')) {
    port.postMessage({ type: 'abort', id: 'stream' })
    results.streamReady = true
  }
})
port.postMessage({ type: 'request', id: 'workspaces', method: 'GET', path: '/api/workspaces', headers: { authorization: 'Bearer forged', origin: 'https://evil.example' } })
port.postMessage({ type: 'request', id: 'stream', method: 'GET', path: '/api/sync/stream', headers: { accept: 'text/event-stream' } })
port.postMessage({ type: 'request', id: 'mcp', method: 'POST', path: '/mcp', headers: {} })
window.results = results
</script>`

async function openPage(extensionDir, pageUrl) {
  const profile = mkdtempSync(join(scratch, 'profile-'))
  whiteboard([
    'native-host',
    'install',
    '--json',
    `--data-dir=${dataDir}`,
    `--manifest-dir=${join(profile, 'NativeMessagingHosts')}`,
  ])
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  })
  const page = await context.newPage()
  await page.goto(pageUrl)
  return { context, page }
}

/** Connect from a browser-kept document, open an agent's note, and type into it. */
async function webAppRoundTrip(record, appUrl) {
  const documentId = await seedNote(record)
  const { context, page } = await openPage(join(EXTENSION_DIR, 'dist/development'), appUrl)
  // What the page said, so a failure here names its cause rather than a URL.
  const said = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      said.push(`${m.type()}: ${m.text().slice(0, 200)}`)
  })
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) said.push(`navigated: ${new URL(f.url()).pathname}`)
  })
  try {
    await page.getByText('Canvas', { exact: true }).click()
    await page
      .getByRole('button', { name: /^Workspace/ })
      .first()
      .click()
    await Promise.all([
      page.waitForEvent('load', { timeout: 20_000 }),
      page
        .getByRole('button', { name: /connect through the extension/i })
        .click({ timeout: 20_000 }),
    ])
    await page.goto(`${appUrl}w/default/d/bridge-note`)
    const read = await page
      .getByText('written by an agent')
      .first()
      .waitFor({ timeout: 20_000 })
      .then(
        () => true,
        () => false,
      )
    check(
      read,
      "the web app reads an agent's note through the extension",
      `${page.url()}\n    ${said.slice(-25).join('\n    ')}`,
    )
    await page.locator('.cm-content').first().click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' and typed in the browser')
    const content = await daemonNoteContains(record, documentId, 'typed in the browser')
    check(
      content.includes('typed in the browser'),
      'an edit in the web app lands on the daemon',
      content,
    )
    // The other direction, live: an agent's edit reaches the open page over
    // the bridge's SSE stream, which the page subscribed by the workspace's
    // segment (`default`) rather than its id.
    await agentEdits(record, documentId)
    const live = await page
      .getByText('Edited by an agent')
      .first()
      .waitFor({ timeout: 20_000 })
      .then(
        () => true,
        () => false,
      )
    check(live, "an agent's edit reaches the open page live", page.url())
  } finally {
    await context.close()
  }
}

let daemon
const pages = await serve(PAGE)
const webApp = await serve()
try {
  buildAll()
  const started = await startDaemon(dataDir)
  daemon = started.daemon
  const { record } = started
  check(
    typeof record.socketPath === 'string',
    'the daemon records its socket',
    JSON.stringify(record),
  )
  const pageUrl = pages.url

  const dev = await openPage(join(EXTENSION_DIR, 'dist/development'), pageUrl)
  await dev.page.waitForFunction(
    // Every request settled, well or badly, so a failure is reported by the
    // check that names it rather than by this wait running out.
    () =>
      window.results?.hello !== undefined &&
      window.results.messages.some(
        (m) => m.id === 'workspaces' && ['end', 'error'].includes(m.type),
      ) &&
      window.results.messages.some((m) => m.id === 'mcp') &&
      (window.results.streamReady ||
        window.results.messages.some(
          (m) => m.id === 'stream' && m.type !== 'chunk' && (m.type !== 'head' || m.status !== 200),
        )),
    null,
    { timeout: 20_000 },
  )
  const results = await dev.page.evaluate(() => window.results)
  await dev.context.close()

  check(
    results.hello?.type === 'hello',
    'the extension answers an admitted page',
    JSON.stringify(results.hello),
  )
  const head = results.messages.find((m) => m.id === 'workspaces' && m.type === 'head')
  check(
    head?.status === 200,
    'a request authenticates with the daemon credential, not the forged one',
    JSON.stringify(head),
  )
  check(
    /"workspaces":\[/.test(results.bodies.workspaces ?? ''),
    'the daemon answer arrives whole',
    results.bodies.workspaces,
  )
  check(
    results.streamReady === true,
    'an SSE stream arrives as it is written',
    results.bodies.stream,
  )
  const mcp = results.messages.find((m) => m.id === 'mcp')
  check(
    mcp?.type === 'error' && mcp.reason === 'bad-request',
    'a request outside /api/ is refused',
    JSON.stringify(mcp),
  )

  await webAppRoundTrip(record, webApp.url)

  const prod = await openPage(join(EXTENSION_DIR, 'dist/production'), pageUrl)
  const exposed = await prod.page.evaluate(() => typeof globalThis.chrome?.runtime?.connect)
  await prod.context.close()
  check(exposed === 'undefined', 'the production build admits no loopback page', exposed)
} catch (err) {
  check(false, 'the smoke ran to the end', err instanceof Error ? err.message : String(err))
} finally {
  pages.close()
  webApp.close()
  await stopDaemon(daemon)
  smoke.finish()
}
