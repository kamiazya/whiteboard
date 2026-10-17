// What `pnpm dev:connected` decides, apart from the processes it runs: where
// the native host is registered, and how the browser is started so that it
// reads that registration and nothing else.
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDevDataDirEnv } from '../../../packages/mcp-server/scripts/dev/with-dev-data-dir-lib.mjs'
import { whiteboard } from './smoke-kit.mjs'

/**
 * The host install for this checkout's dev daemon. The data dir is resolved
 * exactly as the dev daemon resolves its own, so the host relays to the
 * daemon `ensure-http-dev-daemon.mjs` started. The manifest dir is always
 * named: without `--manifest-dir` the CLI registers with every browser the
 * user has run, replacing the registration their real profile relies on (one
 * host name means one data dir per browser). It is a `--development` install,
 * allowing the development build this launcher loads and not the production
 * one.
 *
 * @param {{ env: Record<string, string | undefined>, repoRoot: string, profileDir: string }} input
 */
export function connectedHostInstall({ env, repoRoot, profileDir }) {
  const dataDir = resolve(resolveDevDataDirEnv(env, repoRoot).WHITEBOARD_DATA_DIR)
  const manifestDir = resolve(profileDir, 'NativeMessagingHosts')
  return {
    dataDir,
    manifestDir,
    args: [
      'native-host',
      'install',
      '--json',
      '--development',
      `--data-dir=${dataDir}`,
      `--manifest-dir=${manifestDir}`,
    ],
  }
}

/**
 * Runs the install through the checkout's own CLI, from source — the same
 * code the dev daemon runs, so nothing has to be built first.
 *
 * @param {{ env: Record<string, string | undefined>, repoRoot: string, profileDir: string }} input
 */
export function installHost(input) {
  const plan = connectedHostInstall(input)
  return { plan, result: whiteboard(plan.args) }
}

/**
 * Chromium reads a user-level native host from `<user-data-dir>/NativeMessagingHosts`
 * on Linux and macOS, so the throwaway profile is the whole registration.
 * Playwright's Chromium, not branded Chrome, which ignores `--load-extension`;
 * `DisableLoadExtensionCommandLineSwitch` is the feature that would make
 * Chromium ignore it too.
 *
 * @param {{ profileDir: string, extensionDir: string, cdpPort: number, headless: boolean, noSandbox?: boolean, url: string }} input
 */
export function chromiumArgs({
  profileDir,
  extensionDir,
  cdpPort,
  headless,
  noSandbox = false,
  url,
}) {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    `--remote-debugging-port=${cdpPort}`,
    ...(headless ? ['--headless'] : []),
    ...(noSandbox ? ['--no-sandbox'] : []),
    url,
  ]
}

/**
 * The `--url` a person names, as a web address Chromium can only open. It is
 * the last argument Chromium is given, so anything else — a value starting
 * `--` above all — would be read as a flag rather than a page.
 *
 * @param {string} raw
 * @returns {string}
 */
export function devServerUrl(raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`--url must be an http(s) address, not ${JSON.stringify(raw)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`--url must be an http(s) address, not ${JSON.stringify(raw)}`)
  }
  return parsed.href
}

/**
 * Where Chromium records the CDP port it chose for `--remote-debugging-port=0`.
 * It writes this file for port 0 only: a pinned port never produces one.
 */
function devToolsActivePortFile(profileDir) {
  return join(profileDir, 'DevToolsActivePort')
}

/** How long one readiness probe of a pinned port may take before the poll retries. */
const CDP_PROBE_TIMEOUT_MS = 1_000

/**
 * The CDP port once Chromium's debugging server is up, or `undefined` while
 * it is not. Port 0 can only be learnt from `DevToolsActivePort`; a pinned
 * port has no such file, so it is ready when its own `/json/version` answers
 * with a debugger URL — the endpoint a CDP client attaches through.
 *
 * @param {{ profileDir: string, cdpPort: number }} input
 * @returns {Promise<string | undefined>}
 */
export async function cdpReadyPort({ profileDir, cdpPort }) {
  if (cdpPort === 0) {
    const file = devToolsActivePortFile(profileDir)
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n')[0] : undefined
  }
  try {
    // A server that accepts and never answers would hold this await past the
    // caller's own deadline, which it can only check between polls.
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
      signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    return typeof body?.webSocketDebuggerUrl === 'string' ? String(cdpPort) : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether `port` can be listened on at `host`.
 *
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function portIsFree(port, host = 'localhost') {
  return new Promise((answer) => {
    const probe = createServer()
    probe.once('error', () => answer(false))
    probe.listen(port, host, () => probe.close(() => answer(true)))
  })
}

/**
 * Why a named `--cdp-port` cannot be used, or `undefined` when it can. Asked
 * before anything starts because Chromium does not fail on a taken debugging
 * port: it logs the bind error and keeps running, while the port's endpoint
 * answers for whatever process does hold it — so the only symptom would be
 * attaching to the wrong browser, or a timeout. Chromium binds the debugging
 * server on IPv4 loopback, so that is what is probed.
 *
 * @param {number} port as parsed from the flag; `0` asks Chromium for any free port, which cannot collide
 * @returns {Promise<string | undefined>}
 */
export async function cdpPortRefusal(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return `--cdp-port must be a port number, not ${JSON.stringify(String(port))}`
  }
  if (port === 0 || (await portIsFree(port, '127.0.0.1'))) return undefined
  return `port ${port} is in use — pick another --cdp-port (and point the Playwright MCP's --cdp-endpoint at it), or omit it for any free one`
}

/**
 * `pnpm dev:connected`'s flags. A virtual passkey is on by default under
 * `--headless`, where nothing can answer a real WebAuthn prompt, and off with
 * a window, where a person's own platform authenticator can; either flag
 * spelling overrides that.
 *
 * @param {string[]} argv
 */
export function parseDevConnectedArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowNegative: true,
    options: {
      headless: { type: 'boolean', default: false },
      'virtual-passkey': { type: 'boolean' },
      port: { type: 'string', default: '5173' },
      url: { type: 'string' },
      'cdp-port': { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const { 'virtual-passkey': named, ...rest } = values
  return { ...rest, virtualPasskey: named ?? rest.headless }
}
