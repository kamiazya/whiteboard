// What `pnpm dev:connected` decides, apart from the processes it runs: where
// the native host is registered, and how the browser is started so that it
// reads that registration and nothing else.
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { resolveDevDataDirEnv } from '../../../packages/mcp-server/scripts/dev/with-dev-data-dir-lib.mjs'
import { whiteboard } from './smoke-kit.mjs'

/**
 * The host install for this checkout's dev daemon. The data dir is resolved
 * exactly as the dev daemon resolves its own, so the host relays to the
 * daemon `ensure-http-dev-daemon.mjs` started. The manifest dir is always
 * named: without `--manifest-dir` the CLI registers with every browser the
 * user has run, replacing the registration their real profile relies on (one
 * host name means one data dir per browser).
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

/** Where Chromium records the CDP port it chose for `--remote-debugging-port=0`. */
export function devToolsActivePortFile(profileDir) {
  return join(profileDir, 'DevToolsActivePort')
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
 * port: it logs the bind error, keeps running, and never writes
 * `DevToolsActivePort`, so the only symptom would be a timeout. Chromium
 * binds the debugging server on IPv4 loopback, so that is what is probed.
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
