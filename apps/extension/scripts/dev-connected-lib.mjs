// What `pnpm dev:connected` decides, apart from the processes it runs: where
// the native host is registered, and how the browser is started so that it
// reads that registration and nothing else.
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

/** Where Chromium records the CDP port it chose for `--remote-debugging-port=0`. */
export function devToolsActivePortFile(profileDir) {
  return join(profileDir, 'DevToolsActivePort')
}
