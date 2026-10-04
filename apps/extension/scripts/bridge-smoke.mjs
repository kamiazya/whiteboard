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
//    document and lands on the fresh daemon's own workspace, ready to use;
//    then it reads what an agent wrote on the daemon, writes back, and sees
//    the agent's next edit arrive live.
// 5. A browser-kept record promotes into a daemon workspace through the
//    bridge, unattested (the local daemon pins no passkeys), and a request
//    carrying an attestation is refused and lands nothing.
// 6. The production build admits no loopback page at all.
//
// Branded Chrome ignores --load-extension, so this needs Playwright's own
// Chromium: `pnpm exec playwright install chromium`.
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import {
  agentEdits,
  buildAll,
  callTool,
  clientCount,
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
// The notice a daemon-kept page shows while an edit has not reached the
// daemon. Its own element, so this names exactly it and not the live region.
const UNSAVED_NOTICE = /^Changes not saved yet\.$/
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
// One request over its own port, answered with its status and its body as
// base64 — the shape every later step reads.
window.bridgeRequest = (method, path, body) => new Promise((done) => {
  const own = chrome.runtime.connect('${EXTENSION_ID}')
  let status = 0
  let data = ''
  own.onMessage.addListener((m) => {
    if (m.type === 'head') status = m.status
    if (m.type === 'chunk') data += atob(m.data)
    if (m.type === 'end' || m.type === 'error') done({ status, data: btoa(data), reason: m.reason })
  })
  own.postMessage({ type: 'request', id: 'r', method, path,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: btoa(JSON.stringify(body)) }) })
})
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

/**
 * The promote a person takes from Settings, as its requests travel: the
 * record's bytes out of one workspace and into a fresh one, all through the
 * extension. The source is the daemon's own `default` record, read over the
 * bridge, so the smoke needs no CRDT of its own to build one.
 */
async function promoteThroughBridge(pageUrl) {
  const { context, page } = await openPage(join(EXTENSION_DIR, 'dist/development'), pageUrl)
  try {
    await page.waitForFunction(() => typeof window.bridgeRequest === 'function')
    const outcome = await page.evaluate(async () => {
      const json = (answer) => JSON.parse(atob(answer.data) || 'null')
      const b64u = (b64) => b64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
      const source = await window.bridgeRequest('GET', '/api/w/default/workspace-document/snapshot')
      const created = await window.bridgeRequest('POST', '/api/workspaces', {
        displayName: 'promoted',
      })
      const target = json(created)?.workspaceId
      const path = `/api/w/${target}/workspace-document/promote`
      const snapshot = b64u(source.data)
      // Refused first, so a refusal that merged anyway shows up in the
      // unattested promote's own `recorded`, which would then be empty.
      const attested = await window.bridgeRequest('POST', path, {
        snapshot,
        attestation: {
          kind: 'webauthn',
          credentialId: 'AAAA',
          authenticatorData: 'AAAA',
          clientDataJSON: 'AAAA',
          signature: 'AAAA',
        },
      })
      const promoted = await window.bridgeRequest('POST', path, { snapshot })
      return {
        source: source.status,
        created: created.status,
        target,
        attested: { status: attested.status, body: json(attested) },
        promoted: { status: promoted.status, body: json(promoted) },
      }
    })
    check(
      outcome.source === 200 && typeof outcome.target === 'string',
      'the page reads a record and makes a workspace through the extension',
      JSON.stringify(outcome),
    )
    check(
      outcome.attested.status === 403 && outcome.attested.body?.error === 'attestation_rejected',
      'a promote carrying an attestation is refused, since the local daemon pins no passkey',
      JSON.stringify(outcome.attested),
    )
    const body = outcome.promoted.body
    check(
      outcome.promoted.status === 200 &&
        body?.attested === false &&
        body.recorded.length > 0 &&
        body.shadowed.length === 0,
      'an unattested promote through the extension lands the whole record',
      JSON.stringify(outcome.promoted),
    )
    return outcome.target
  } finally {
    await context.close()
  }
}

/** Connect from a browser-kept document, open an agent's note, and type into it. */
async function webAppRoundTrip(record, appUrl, restartDaemon) {
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
    // From inside a browser document: its connection popover is where the
    // extension's connect button and the install prompt could meet.
    await page.getByText('Canvas', { exact: true }).click()
    await page.waitForURL(/\/d\//, { timeout: 20_000 })
    await page
      .getByRole('button', { name: /^Workspace.* — / })
      .first()
      .click()
    const popover = page.getByRole('dialog')
    const viaExtension = popover.getByRole('button', { name: /connect through the extension/i })
    await viaExtension.waitFor({ timeout: 20_000 })
    // The popover asks for the extension (and links "How to connect a daemon")
    // only where none answers; once it does, the connect button must be the
    // only way offered, or nothing says which of two paths a person is on.
    const getTheExtensionOffered = await popover
      .getByRole('link', { name: 'How to connect a daemon' })
      .count()
    check(
      getTheExtensionOffered === 0,
      "the popover offers the extension's connect button instead of the install prompt once the extension answers",
      `${getTheExtensionOffered} install-prompt link(s) beside the extension's button: ${(await popover.innerText()).slice(0, 300)}`,
    )
    await Promise.all([page.waitForEvent('load', { timeout: 20_000 }), viaExtension.click()])
    // Nothing is seeded yet, so this is a fresh daemon's own workspace: the
    // first screen a person meets after connecting.
    const ready = await page
      .getByText('What will you make first?')
      .waitFor({ timeout: 20_000 })
      .then(
        () => true,
        () => false,
      )
    check(
      ready && (await page.getByText('Failed to load').count()) === 0,
      "a fresh daemon's first screen after connecting is ready to use",
      `${page.url()} ${(await page.locator('body').innerText()).slice(0, 200)}`,
    )
    const documentId = await seedNote(record)
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
    // The page's only transport is its SSE stream, and the daemon has to see
    // it there: an agent that asks whether anyone has the note open (the
    // viewport tools do) was told nobody did while only sockets were counted.
    let seen = { count: 0, readyCount: 0 }
    for (let i = 0; i < 40 && seen.readyCount < 1; i += 1) {
      seen = await clientCount(record, 'bridge-note')
      if (seen.readyCount < 1) await new Promise((later) => setTimeout(later, 250))
    }
    check(
      seen.readyCount >= 1,
      'the daemon counts the page open on the note, through its SSE stream',
      JSON.stringify(seen),
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
    // A daemon that goes away and comes back: what was typed meanwhile
    // reaches it on the reconnect, and the page stops saying it is unsaved.
    const restarted = await restartDaemon(async () => {
      await page.locator('.cm-content').first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(' typed while the daemon was down')
      // The visible notice, not the screen-reader live region that says the
      // same words: a person has to be able to SEE that the edit is held.
      const unsaved = await page
        .getByText(UNSAVED_NOTICE)
        .waitFor({ timeout: 20_000 })
        .then(
          () => true,
          () => false,
        )
      check(unsaved, 'the page says it is unsaved while the daemon is down', page.url())
    })
    const synced = await daemonNoteContains(
      restarted,
      documentId,
      'typed while the daemon was down',
    )
    check(
      synced.includes('typed while the daemon was down'),
      'an edit made while the daemon was down reaches it after a restart',
      synced,
    )
    const cleared = await page
      .getByText(UNSAVED_NOTICE)
      .waitFor({ state: 'hidden', timeout: 20_000 })
      .then(
        () => true,
        () => false,
      )
    check(cleared, 'the page stops saying it is unsaved once the daemon has it', page.url())
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

  await webAppRoundTrip(record, webApp.url, async (whileDown) => {
    await stopDaemon(daemon)
    await whileDown()
    const again = await startDaemon(dataDir)
    daemon = again.daemon
    return again.record
  })

  const target = await promoteThroughBridge(pageUrl)
  const current = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8'))
  const listed = await callTool(current, 'wb_document_list', { workspaceId: target })
  check(
    JSON.stringify(listed ?? {}).includes('bridge-note'),
    'an agent finds the promoted note in the target workspace',
    JSON.stringify(listed),
  )

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
