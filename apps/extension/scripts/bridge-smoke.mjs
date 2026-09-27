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
// 4. The production build admits no loopback page at all.
//
// Branded Chrome ignores --load-extension, so this needs Playwright's own
// Chromium: `pnpm exec playwright install chromium`.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_SERVER_DIR = resolve(EXTENSION_DIR, '../../packages/mcp-server')
const CLI = [process.execPath, '--import', 'tsx/esm', join(MCP_SERVER_DIR, 'src/cli/index.ts')]
const EXTENSION_ID = 'ckgipndlpblkhiplhnbbdnpnibflplje'

const scratch = mkdtempSync(join(tmpdir(), 'whiteboard-bridge-smoke-'))
const dataDir = join(scratch, 'data')
let failed = false
const check = (ok, what, detail) => {
  console[ok ? 'log' : 'error'](`  ${ok ? 'pass' : 'FAIL'}  ${what}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed = true
}

function whiteboard(args) {
  const run = spawnSync(CLI[0], [...CLI.slice(1), ...args], {
    cwd: MCP_SERVER_DIR,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`whiteboard ${args.join(' ')} failed: ${run.stderr}`)
  return JSON.parse(run.stdout)
}

function startDaemon() {
  const daemon = spawn(
    CLI[0],
    [...CLI.slice(1), 'daemon', 'run', '--json', `--data-dir=${dataDir}`, '--no-open'],
    {
      cwd: MCP_SERVER_DIR,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  return new Promise((ready, fail) => {
    daemon.stdout.once('data', () => ready(daemon))
    daemon.once('exit', (code) =>
      fail(new Error(`the daemon exited (${code}) before it was ready`)),
    )
  })
}

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

let daemon
const pages = createServer((_req, res) =>
  res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE),
)
try {
  const build = spawnSync('pnpm', ['build'], { cwd: EXTENSION_DIR, stdio: 'inherit' })
  if (build.status !== 0) throw new Error('the extension did not build')
  daemon = await startDaemon()
  const record = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8'))
  check(
    typeof record.socketPath === 'string',
    'the daemon records its socket',
    JSON.stringify(record),
  )

  await new Promise((listening) => pages.listen(0, '127.0.0.1', listening))
  const pageUrl = `http://127.0.0.1:${pages.address().port}/`

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

  const prod = await openPage(join(EXTENSION_DIR, 'dist/production'), pageUrl)
  const exposed = await prod.page.evaluate(() => typeof globalThis.chrome?.runtime?.connect)
  await prod.context.close()
  check(exposed === 'undefined', 'the production build admits no loopback page', exposed)
} catch (err) {
  check(false, 'the smoke ran to the end', err instanceof Error ? err.message : String(err))
} finally {
  pages.close()
  daemon?.kill('SIGTERM')
  await new Promise((exited) =>
    daemon && daemon.exitCode === null ? daemon.once('exit', exited) : exited(),
  )
  rmSync(scratch, { recursive: true, force: true })
}

if (failed) {
  console.error('[bridge-smoke] FAIL')
  process.exit(1)
}
console.log('[bridge-smoke] ok')
