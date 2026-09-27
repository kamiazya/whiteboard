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
import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  NATIVE_HOST_NAME,
  WHITEBOARD_EXTENSION_ID,
  WHITEBOARD_GECKO_ID,
} from '@kamiazya/whiteboard-daemon-client/extension-names'

/** Chromium and Firefox read the same manifest, each with its own allow-list key. */
export type BrowserEngine = 'chromium' | 'firefox'

export interface ManifestDir {
  browser: string
  engine: BrowserEngine
  dir: string
}

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
 * The manifest directory of each browser this user has run. Windows
 * registers a host in the registry instead, and is measured before it is
 * built (ADR-0050).
 */
export function nativeHostManifestDirs(home: string, platform: NodeJS.Platform): ManifestDir[] {
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
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

export async function installNativeHost(
  options: InstallOptions,
): Promise<{ launcher: string; manifests: ManifestDir[] }> {
  const launcher = join(options.dataDir, 'native-host', 'whiteboard-native-host')
  const command = [options.launcher.execPath, ...options.launcher.execArgv, options.launcher.entry]
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 })
  await writeFile(
    launcher,
    `#!/bin/sh\nWHITEBOARD_DATA_DIR=${shellQuote(options.dataDir)} exec ${command.map(shellQuote).join(' ')} native-host run "$@"\n`,
  )
  await chmod(launcher, 0o700)

  for (const { dir, engine } of options.manifestDirs) {
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
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${NATIVE_HOST_NAME}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return { launcher, manifests: [...options.manifestDirs] }
}
