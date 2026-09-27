/**
 * ADR-0050 decision 6: `whiteboard` registers the native host at user level,
 * needing no administrator rights. The manifest names the one extension the
 * browser may start the host for.
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
} from '@kamiazya/whiteboard-daemon-client/extension-names'

export interface ManifestDir {
  browser: string
  dir: string
}

/** Where each Chromium browser reads user-level hosts, under the home dir. */
const BROWSER_ROOTS: Partial<Record<NodeJS.Platform, Readonly<Record<string, string>>>> = {
  linux: {
    chrome: '.config/google-chrome',
    chromium: '.config/chromium',
    edge: '.config/microsoft-edge',
    brave: '.config/BraveSoftware/Brave-Browser',
  },
  darwin: {
    chrome: 'Library/Application Support/Google/Chrome',
    chromium: 'Library/Application Support/Chromium',
    edge: 'Library/Application Support/Microsoft Edge',
    brave: 'Library/Application Support/BraveSoftware/Brave-Browser',
  },
}

/**
 * The manifest directory of each Chromium browser this user has run. Windows
 * registers a host in the registry instead, and is measured before it is
 * built (ADR-0050).
 */
export function nativeHostManifestDirs(home: string, platform: NodeJS.Platform): ManifestDir[] {
  return Object.entries(BROWSER_ROOTS[platform] ?? {})
    .filter(([, root]) => existsSync(join(home, root)))
    .map(([browser, root]) => ({ browser, dir: join(home, root, 'NativeMessagingHosts') }))
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

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Relays the whiteboard extension to the local whiteboard daemon',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${WHITEBOARD_EXTENSION_ID}/`],
  }
  for (const { dir } of options.manifestDirs) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${NATIVE_HOST_NAME}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return { launcher, manifests: [...options.manifestDirs] }
}
