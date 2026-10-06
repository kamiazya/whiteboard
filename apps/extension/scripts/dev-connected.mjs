#!/usr/bin/env node
// `pnpm dev:connected`: the dev web app in a Chromium that reaches this
// checkout's dev daemon, the way the hosted app reaches a user's daemon
// (ADR-0050) — through the development build of the extension and a native
// host registered for this checkout's data dir.
//
// Everything that registers lives in a throwaway Chromium profile, removed on
// exit: the host manifest goes to `<profile>/NativeMessagingHosts`, which is
// where Chromium on Linux and macOS looks for a user-level host when it runs
// on that profile. The user's own browsers and their registration (one host
// name, so one data dir per browser) are never touched. Windows has no such
// directory — Chromium finds a host there through a per-user registry key —
// so this refuses to run there rather than rewrite that key.
//
// The dev daemon is the checkout's shared one: it is ensured, never stopped.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { resolveRepoRootFromGit } from '../../../packages/mcp-server/scripts/dev/with-dev-data-dir-lib.mjs'
import { chromiumArgs, devToolsActivePortFile, installHost } from './dev-connected-lib.mjs'
import { EXTENSION_DIR } from './smoke-kit.mjs'

const USAGE = `usage: pnpm dev:connected [--headless] [--port=<n>] [--url=<dev server url>] [--cdp-port=<n>] [--chrome=<path>]
  --headless   no window; attach over CDP (the printed endpoint) instead
  --port       the vite port to try first (default 5173; the next free one is taken)
  --url        use a dev server that is already running instead of starting one
  --cdp-port   the remote debugging port (default: any free one, printed)
  --chrome     a Chromium that honours --load-extension (default: Playwright's)`

const say = (line) => console.log(`[dev-connected] ${line}`)
const fail = (line) => {
  console.error(`[dev-connected] ${line}`)
  process.exit(1)
}

let options
try {
  options = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      headless: { type: 'boolean', default: false },
      port: { type: 'string', default: '5173' },
      url: { type: 'string' },
      'cdp-port': { type: 'string', default: '0' },
      chrome: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values
} catch (err) {
  console.error(`${err.message}\n${USAGE}`)
  process.exit(2)
}
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}
if (process.platform === 'win32') {
  fail(
    'Windows registers a native host only through a per-user registry key, which a throwaway profile cannot scope — run `whiteboard native-host install --json` yourself instead (development.md).',
  )
}

const REPO_ROOT = resolveRepoRootFromGit(process.cwd())
const WEB_DIR = resolve(EXTENSION_DIR, '../web')
const DEV_EXTENSION_DIR = join(EXTENSION_DIR, 'dist/development')
const LOG_DIR = join(REPO_ROOT, 'tmp', 'logs')

// 1. This checkout's dev daemon. CLAUDE_PROJECT_DIR is pinned because the
//    hook script prefers it over its cwd, and an agent session opened on
//    another checkout would otherwise ensure that checkout's daemon while the
//    host below relays to this one's.
const ensured = spawnSync(
  process.execPath,
  [join(REPO_ROOT, 'packages/mcp-server/scripts/dev/ensure-http-dev-daemon.mjs')],
  { cwd: REPO_ROOT, env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT }, stdio: 'inherit' },
)
if (ensured.status !== 0) fail("this checkout's dev daemon did not come up (see above)")

// 2. The development build admits localhost; a few seconds, so never stale.
const built = spawnSync(
  'pnpm',
  ['exec', 'vite', 'build', '--mode', 'development', '--logLevel', 'warn'],
  {
    cwd: EXTENSION_DIR,
    stdio: 'inherit',
  },
)
if (built.status !== 0) fail('the extension did not build')

const chromePath = options.chrome ?? chromium.executablePath()
if (!existsSync(chromePath)) {
  fail(
    `no Chromium at ${chromePath} — run \`pnpm exec playwright install chromium\` once, or pass --chrome=<path>`,
  )
}

// 3. The host, registered inside the profile only.
const profileDir = mkdtempSync(join(tmpdir(), 'whiteboard-dev-connected-'))
let vite
let browser
let cleaningUp = false

async function cleanUp(code) {
  if (cleaningUp) return
  cleaningUp = true
  vite?.kill('SIGTERM')
  if (browser !== undefined && browser.exitCode === null && browser.signalCode === null) {
    browser.kill('SIGTERM')
    await new Promise((exited) => browser.once('exit', exited))
  }
  rmSync(profileDir, { recursive: true, force: true })
  process.exit(code)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => cleanUp(0))

let plan
try {
  plan = installHost({ env: process.env, repoRoot: REPO_ROOT, profileDir }).plan
} catch (err) {
  console.error(`[dev-connected] ${err.message}`)
  await cleanUp(1)
}

/** Whether `port` can be listened on, as vite would listen on it. */
function portIsFree(port) {
  return new Promise((answer) => {
    const probe = createServer()
    probe.once('error', () => answer(false))
    probe.listen(port, 'localhost', () => probe.close(() => answer(true)))
  })
}

async function answers(url) {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

async function waitFor(what, isReady, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await isReady()
    if (value) return value
    // Cleanup ends the process; nothing after the wait should run meanwhile.
    if (cleaningUp) return new Promise(() => {})
    await new Promise((later) => setTimeout(later, 200))
  }
  console.error(`[dev-connected] ${what} did not come up within ${timeoutMs}ms`)
  return cleanUp(1)
}

// 4. A dev server of this checkout's own. One already on 5173 is not reused
//    unless named with --url: it may be another checkout's, serving that
//    checkout's code, and nothing it answers says which.
let appUrl = options.url
if (appUrl === undefined) {
  let port = Number(options.port)
  while (!(await portIsFree(port))) port += 1
  // Through pnpm's bin shim, which sets the NODE_PATH a plugin resolves its
  // peer dependencies by, and `exec`s node — so the pid is vite's own and a
  // signal reaches it, where `pnpm exec` would not relay one.
  vite = spawn(
    join(WEB_DIR, 'node_modules/.bin/vite'),
    ['--port', String(port), '--strictPort', '--clearScreen', 'false'],
    { cwd: WEB_DIR, stdio: ['ignore', 'inherit', 'inherit'] },
  )
  vite.once('exit', (code) => {
    if (!cleaningUp) {
      console.error(`[dev-connected] vite exited (${code})`)
      cleanUp(1)
    }
  })
  appUrl = `http://localhost:${port}/`
  await waitFor(`vite on ${appUrl}`, () => answers(appUrl), 60_000)
}

// 5. Chromium on the profile, its own output kept out of this terminal.
mkdirSync(LOG_DIR, { recursive: true })
const logPath = join(LOG_DIR, 'dev-connected-chromium.log')
browser = spawn(
  chromePath,
  chromiumArgs({
    profileDir,
    extensionDir: DEV_EXTENSION_DIR,
    cdpPort: Number(options['cdp-port']),
    headless: options.headless,
    // Chromium refuses to start as root with its sandbox on.
    noSandbox: process.getuid?.() === 0,
    url: appUrl,
  }),
  { stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')] },
)
let ready = false
browser.once('exit', (code, signal) => {
  if (cleaningUp) return
  if (!ready || code !== 0) {
    const noDisplay =
      !options.headless &&
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
    const hint = noDisplay ? ' (no display here: pass --headless)' : ''
    console.error(
      `[dev-connected] Chromium exited (${signal ?? `code ${code}`})${hint} — see ${logPath}`,
    )
    cleanUp(1)
    return
  }
  cleanUp(0)
})

const cdpPort = await waitFor(
  'Chromium',
  () => {
    const file = devToolsActivePortFile(profileDir)
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n')[0] : undefined
  },
  30_000,
)

ready = true
say(`app:      ${appUrl}`)
say(`CDP:      http://127.0.0.1:${cdpPort}  (Playwright: chromium.connectOverCDP(<this>))`)
say(`data dir: ${plan.dataDir}`)
say(`profile:  ${profileDir} (removed on exit; Chromium's log: ${logPath})`)
say('In the app, "Connect through the extension" (Settings > Connections) reaches the daemon.')
say(options.headless ? 'Ctrl-C to stop.' : 'Close the window or Ctrl-C to stop.')
