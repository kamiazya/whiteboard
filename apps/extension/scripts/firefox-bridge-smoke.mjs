// Real-browser proof of ADR-0050's bridge in Firefox, which lets no page
// message an extension: the page reaches the extension's content script over
// its own window, the background script starts the native host, and the host
// reaches the daemon's owner-only socket.
//
// What this pins, beside what the Chromium smoke does:
// 1. The content script answers the page, and a request reaches the daemon
//    with the daemon's credential — not one the page supplied.
// 2. An SSE stream arrives as it is written, and a path outside /api/ is refused.
// 3. The built web app connects through the extension, reads an agent's note,
//    writes back, and sees the agent's next edit arrive live.
// 4. The production build does not relay a loopback page.
//
// Playwright cannot load an extension into Firefox, so this speaks WebDriver
// to geckodriver. It needs a Firefox that is not Ubuntu's snap (whose native
// messaging goes through a desktop portal asking a person) and geckodriver:
// FIREFOX_BIN and GECKODRIVER, or both on PATH.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
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

const smoke = createSmoke('firefox-bridge-smoke')
const { check, dataDir, scratch } = smoke
// Firefox reads user-level hosts from $HOME, so a scratch home holds this
// run's manifest and leaves the person's own alone.
const home = join(scratch, 'home')
const GECKO_PORT = 4400 + Math.floor(Math.random() * 500)

/** The page: asks for everything at once over the window, and reports what came back. */
const PAGE = `<!doctype html><meta charset="utf-8"><script>
const C = 'whiteboard-extension-bridge'
const results = { events: [], bodies: {} }
window.results = results
const post = (m) => window.postMessage({ channel: C, from: 'page', ...m }, location.origin)
const send = (message) => post({ kind: 'message', port: 'p', message })
addEventListener('message', (e) => {
  const d = e.data
  if (d?.channel !== C || d.from !== 'extension') return
  if (d.kind === 'hello') results.hello = d.version
  if (d.kind === 'connected') {
    send({ type: 'request', id: 'workspaces', method: 'GET', path: '/api/workspaces', headers: { authorization: 'Bearer forged', origin: 'https://evil.example' } })
    send({ type: 'request', id: 'stream', method: 'GET', path: '/api/sync/stream', headers: { accept: 'text/event-stream' } })
    send({ type: 'request', id: 'mcp', method: 'POST', path: '/mcp', headers: {} })
  }
  if (d.kind !== 'message') return
  const m = d.message
  results.events.push({ type: m.type, id: m.id, status: m.status, reason: m.reason })
  if (m.type === 'chunk') results.bodies[m.id] = (results.bodies[m.id] ?? '') + atob(m.data)
  if (m.id === 'stream' && (results.bodies.stream ?? '').includes('event: ready') && !results.streamReady) {
    results.streamReady = true
    send({ type: 'abort', id: 'stream' })
  }
})
// The content script runs at document_start, so it is listening already.
post({ kind: 'hello' })
post({ kind: 'connect', port: 'p' })
</script>`

async function webdriver(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${GECKO_PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const { value } = await res.json()
  if (!res.ok) throw new Error(`${method} ${path}: ${value?.error} ${value?.message}`)
  return value
}

/** One Firefox, the extension installed temporarily, as a session to drive. */
async function openFirefox(extensionDir) {
  const { sessionId } = await webdriver('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          ...(process.env.FIREFOX_BIN ? { binary: process.env.FIREFOX_BIN } : {}),
          args: ['-headless'],
        },
      },
    },
  })
  const at = (path) => `/session/${sessionId}${path}`
  await webdriver('POST', at('/moz/addon/install'), { path: extensionDir, temporary: true })
  const run = (script, ...args) => webdriver('POST', at('/execute/sync'), { script, args })
  const until = async (script, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await run(script).catch(() => null)
      if (value) return value
      if (Date.now() > deadline) return null
      await new Promise((later) => setTimeout(later, 250))
    }
  }
  return {
    goto: (url) => webdriver('POST', at('/url'), { url }),
    run,
    until,
    /** Clicks the first element matching `xpath`, once there is one. */
    async click(xpath) {
      const found = await until(
        `return document.evaluate(${JSON.stringify(xpath)}, document, null, 9, null).singleNodeValue !== null`,
      )
      if (!found) throw new Error(`nothing matched ${xpath}`)
      const element = await webdriver('POST', at('/element'), { using: 'xpath', value: xpath })
      await webdriver('POST', at(`/element/${Object.values(element)[0]}/click`), {})
      return Object.values(element)[0]
    },
    type: (elementId, text) => webdriver('POST', at(`/element/${elementId}/value`), { text }),
    close: () => webdriver('DELETE', at('')),
  }
}

const hasText = (text) =>
  `return document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`

async function webAppRoundTrip(record, appUrl) {
  const documentId = await seedNote(record)
  const firefox = await openFirefox(join(EXTENSION_DIR, 'dist/firefox-development'))
  try {
    await firefox.goto(appUrl)
    await firefox.click(`//*[normalize-space(text())='Canvas']`)
    await firefox.click(`//button[starts-with(normalize-space(.), 'Workspace')]`)
    await firefox.click(`//button[contains(., 'through the extension')]`)
    // Connecting reloads the page into the daemon's workspace.
    await firefox.until(
      `return document.readyState === 'complete' && !document.body.innerText.includes('Connecting to the daemon')`,
    )
    await firefox.goto(`${appUrl}w/default/d/bridge-note`)
    check(
      Boolean(await firefox.until(hasText('written by an agent'))),
      "the web app reads an agent's note through the extension",
      await firefox.run('return location.pathname + " " + document.body.innerText.slice(0, 300)'),
    )
    const editor = await firefox.click(`//*[contains(@class, 'cm-content')]`)
    // Control+End, then the text: WebDriver's key codes.
    await firefox.type(editor, ' and typed in the browser')
    const content = await daemonNoteContains(record, documentId, 'typed in the browser')
    check(
      content.includes('typed in the browser'),
      'an edit in the web app lands on the daemon',
      content,
    )
    await agentEdits(record, documentId)
    check(
      Boolean(await firefox.until(hasText('Edited by an agent'))),
      "an agent's edit reaches the open page live",
      await firefox.run('return document.body.innerText.slice(0, 300)'),
    )
  } finally {
    await firefox.close()
  }
}

let daemon
let geckodriver
const pages = await serve(PAGE)
const webApp = await serve()
try {
  buildAll()
  mkdirSync(home)
  whiteboard([
    'native-host',
    'install',
    '--json',
    `--data-dir=${dataDir}`,
    `--firefox-manifest-dir=${join(home, '.mozilla/native-messaging-hosts')}`,
  ])
  const started = await startDaemon(dataDir)
  daemon = started.daemon
  const { record } = started

  geckodriver = spawn(process.env.GECKODRIVER ?? 'geckodriver', ['--port', String(GECKO_PORT)], {
    env: { ...process.env, HOME: home, MOZ_HEADLESS: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  for (let i = 0; i < 40; i += 1) {
    if (
      await fetch(`http://127.0.0.1:${GECKO_PORT}/status`).then(
        () => true,
        () => false,
      )
    )
      break
    await new Promise((later) => setTimeout(later, 250))
  }

  const dev = await openFirefox(join(EXTENSION_DIR, 'dist/firefox-development'))
  await dev.goto(pages.url)
  const results = await dev.until(
    `const r = window.results
     const settled = (id) => r?.events.some((m) => m.id === id && ['end', 'error'].includes(m.type))
     return r?.hello && settled('workspaces') && settled('mcp') && (r.streamReady || settled('stream')) ? r : null`,
  )
  await dev.close()
  check(
    typeof results?.hello === 'string',
    'the content script answers an admitted page',
    JSON.stringify(results),
  )
  const head = results?.events.find((m) => m.id === 'workspaces' && m.type === 'head')
  check(
    head?.status === 200,
    'a request authenticates with the daemon credential, not the forged one',
    JSON.stringify(head),
  )
  check(
    /"workspaces":\[/.test(results?.bodies.workspaces ?? ''),
    'the daemon answer arrives whole',
    results?.bodies.workspaces,
  )
  check(
    results?.streamReady === true,
    'an SSE stream arrives as it is written',
    results?.bodies.stream,
  )
  const mcp = results?.events.find((m) => m.id === 'mcp')
  check(
    mcp?.type === 'error' && mcp.reason === 'bad-request',
    'a request outside /api/ is refused',
    JSON.stringify(mcp),
  )

  await webAppRoundTrip(record, webApp.url)

  const prod = await openFirefox(join(EXTENSION_DIR, 'dist/firefox-production'))
  await prod.goto(pages.url)
  const relayed = await prod.until('return window.results?.hello ?? null', 3_000)
  await prod.close()
  check(relayed === null, 'the production build does not relay a loopback page', relayed)
} catch (err) {
  check(false, 'the smoke ran to the end', err instanceof Error ? err.message : String(err))
} finally {
  pages.close()
  webApp.close()
  geckodriver?.kill()
  await stopDaemon(daemon)
  smoke.finish()
}
