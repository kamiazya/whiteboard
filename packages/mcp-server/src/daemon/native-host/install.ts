/**
 * ADR-0050 decision 6: `whiteboard` registers the native host at user level,
 * needing no administrator rights. The manifest names the one extension the
 * browser may start the host for.
 * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests
 * https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location
 *
 * The browser starts the host with no arguments of ours, so it starts a
 * launcher script that carries them: the Node that ran `install`, the CLI
 * entry, and the data dir whose daemon it relays to.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  NATIVE_HOST_NAME,
  WHITEBOARD_EXTENSION_ID,
  WHITEBOARD_GECKO_ID,
} from '@kamiazya/whiteboard-daemon-client/extension-names'
import { z } from 'zod'

/**
 * One place a manifest was written. A schema because it is also part of what
 * `whiteboard native-host install --json` prints (cli/operator-json.ts).
 */
export const manifestDirSchema = z
  .object({
    browser: z.string(),
    // Chromium and Firefox read the same manifest, each with its own allow-list key.
    engine: z.enum(['chromium', 'firefox']),
    dir: z.string(),
    /** Windows only: the HKCU key under which the browser looks the host up. */
    registryKey: z.string().optional(),
  })
  .strict()

export type ManifestDir = z.infer<typeof manifestDirSchema>
type BrowserEngine = ManifestDir['engine']

/**
 * Where each browser reads user-level hosts: a browser counts as installed
 * when `root` exists under the home dir, and its hosts live in `hosts`.
 * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests#manifest_location
 */
interface BrowserRoot {
  root: string
  hosts: string
  engine: BrowserEngine
}
const chromium = (root: string): BrowserRoot => ({
  root,
  hosts: 'NativeMessagingHosts',
  engine: 'chromium',
})
const firefox = (root: string, hosts: string): BrowserRoot => ({ root, hosts, engine: 'firefox' })

const BROWSER_ROOTS: Partial<Record<NodeJS.Platform, Readonly<Record<string, BrowserRoot>>>> = {
  linux: {
    chrome: chromium('.config/google-chrome'),
    chromium: chromium('.config/chromium'),
    edge: chromium('.config/microsoft-edge'),
    brave: chromium('.config/BraveSoftware/Brave-Browser'),
    firefox: firefox('.mozilla', 'native-messaging-hosts'),
    'firefox-snap': firefox('snap/firefox/common/.mozilla', 'native-messaging-hosts'),
  },
  darwin: {
    chrome: chromium('Library/Application Support/Google/Chrome'),
    chromium: chromium('Library/Application Support/Chromium'),
    edge: chromium('Library/Application Support/Microsoft Edge'),
    brave: chromium('Library/Application Support/BraveSoftware/Brave-Browser'),
    firefox: firefox('Library/Application Support/Mozilla', 'NativeMessagingHosts'),
  },
}

/**
 * Where each browser on Windows looks a host up (ADR-0050 decision 9): a
 * registry key naming the manifest, which may then live anywhere. Registering
 * a browser that is not installed writes one key nothing reads, so every one
 * is registered rather than guessing which are present.
 */
const WINDOWS_REGISTRY: Readonly<Record<string, { engine: BrowserEngine; key: string }>> = {
  chrome: { engine: 'chromium', key: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts' },
  chromium: { engine: 'chromium', key: 'HKCU\\Software\\Chromium\\NativeMessagingHosts' },
  edge: { engine: 'chromium', key: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts' },
  firefox: { engine: 'firefox', key: 'HKCU\\Software\\Mozilla\\NativeMessagingHosts' },
}

/**
 * The manifest directory of each browser this user has run. On Windows the
 * manifests are kept under `dataDir` and each is named by a registry key.
 */
export function nativeHostManifestDirs(
  home: string,
  platform: NodeJS.Platform,
  dataDir: string = home,
): ManifestDir[] {
  if (platform === 'win32') {
    return Object.entries(WINDOWS_REGISTRY).map(([browser, { engine, key }]) => ({
      browser,
      engine,
      dir: join(dataDir, 'native-host', browser),
      registryKey: key,
    }))
  }
  return Object.entries(BROWSER_ROOTS[platform] ?? {})
    .filter(([, { root }]) => existsSync(join(home, root)))
    .map(([browser, { root, hosts, engine }]) => ({
      browser,
      engine,
      dir: join(home, root, hosts),
    }))
}

interface InstallOptions {
  dataDir: string
  manifestDirs: readonly ManifestDir[]
  launcher: { execPath: string; execArgv: readonly string[]; entry: string }
  platform?: NodeJS.Platform
  /** Sets a registry key's default value; `reg add` unless a test substitutes it. */
  register?: (key: string, value: string) => Promise<void>
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * A value quoted for a cmd script. cmd has no escape for `"` inside quotes, so
 * such a value is refused rather than written into a launcher that would run
 * something else; `%` is doubled, which is how a batch file keeps it literal.
 */
function cmdQuote(value: string): string {
  if (value.includes('"'))
    throw new Error(`a path containing '"' cannot be quoted for cmd: ${value}`)
  return `"${value.replaceAll('%', '%%')}"`
}

function regAdd(key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], (err) =>
      err ? reject(err) : resolve(),
    )
  })
}

/** The launcher the browser starts, in the platform's own script language. */
async function writeLauncher(options: InstallOptions): Promise<string> {
  const windows = (options.platform ?? process.platform) === 'win32'
  const launcher = join(
    options.dataDir,
    'native-host',
    windows ? 'whiteboard-native-host.cmd' : 'whiteboard-native-host',
  )
  const command = [options.launcher.execPath, ...options.launcher.execArgv, options.launcher.entry]
  const script = windows
    ? `@echo off\r\nset ${cmdQuote(`WHITEBOARD_DATA_DIR=${options.dataDir}`)}\r\n${command.map(cmdQuote).join(' ')} native-host run %*\r\n`
    : `#!/bin/sh\nWHITEBOARD_DATA_DIR=${shellQuote(options.dataDir)} exec ${command.map(shellQuote).join(' ')} native-host run "$@"\n`
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 })
  await writeFile(launcher, script)
  await chmod(launcher, 0o700)
  return launcher
}

export async function installNativeHost(
  options: InstallOptions,
): Promise<{ launcher: string; manifests: ManifestDir[] }> {
  const launcher = await writeLauncher(options)
  const register = options.register ?? regAdd

  for (const { dir, engine, registryKey } of options.manifestDirs) {
    const manifest = {
      name: NATIVE_HOST_NAME,
      description: 'Relays the whiteboard extension to the local whiteboard daemon',
      path: launcher,
      type: 'stdio',
      // Only the engine's own key: Firefox refuses a manifest that also
      // carries Chromium's, as "No such native application".
      ...(engine === 'firefox'
        ? { allowed_extensions: [WHITEBOARD_GECKO_ID] }
        : { allowed_origins: [`chrome-extension://${WHITEBOARD_EXTENSION_ID}/`] }),
    }
    const manifestPath = join(dir, `${NATIVE_HOST_NAME}.json`)
    await mkdir(dir, { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    if (registryKey !== undefined)
      await register(`${registryKey}\\${NATIVE_HOST_NAME}`, manifestPath)
  }
  return { launcher, manifests: [...options.manifestDirs] }
}
