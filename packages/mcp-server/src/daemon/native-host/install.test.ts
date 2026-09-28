/**
 * ADR-0050 decision 6: `whiteboard` writes the native host's manifest at user
 * level, and the browser then lets only the whiteboard extension start it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NATIVE_HOST_NAME,
  WHITEBOARD_EXTENSION_ID,
  WHITEBOARD_GECKO_ID,
} from '@kamiazya/whiteboard-daemon-client/extension-names'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installNativeHost, nativeHostManifestDirs } from './install.js'

let scratch: string
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wb-host-install-'))
})
afterEach(() => rmSync(scratch, { recursive: true, force: true }))

const launcherFor = (entry: string) => ({ execPath: process.execPath, execArgv: [], entry })

describe('nativeHostManifestDirs', () => {
  it('names each installed Chromium browser on Linux, and none it cannot find', () => {
    mkdirSync(join(scratch, '.config', 'google-chrome'), { recursive: true })
    mkdirSync(join(scratch, '.config', 'microsoft-edge'), { recursive: true })

    expect(nativeHostManifestDirs(scratch, 'linux')).toEqual([
      {
        browser: 'chrome',
        engine: 'chromium',
        dir: join(scratch, '.config/google-chrome/NativeMessagingHosts'),
      },
      {
        browser: 'edge',
        engine: 'chromium',
        dir: join(scratch, '.config/microsoft-edge/NativeMessagingHosts'),
      },
    ])
  })

  // Firefox reads user-level hosts from one directory per install, not per
  // profile — and Ubuntu's snap keeps its own home under ~/snap.
  it('names each installed Firefox on Linux, the snap one included', () => {
    mkdirSync(join(scratch, '.mozilla'), { recursive: true })
    mkdirSync(join(scratch, 'snap/firefox/common/.mozilla'), { recursive: true })

    expect(nativeHostManifestDirs(scratch, 'linux')).toEqual([
      {
        browser: 'firefox',
        engine: 'firefox',
        dir: join(scratch, '.mozilla/native-messaging-hosts'),
      },
      {
        browser: 'firefox-snap',
        engine: 'firefox',
        dir: join(scratch, 'snap/firefox/common/.mozilla/native-messaging-hosts'),
      },
    ])
  })

  it('looks under Application Support on macOS', () => {
    mkdirSync(join(scratch, 'Library/Application Support/Google/Chrome'), { recursive: true })
    expect(nativeHostManifestDirs(scratch, 'darwin')).toEqual([
      {
        browser: 'chrome',
        engine: 'chromium',
        dir: join(scratch, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      },
    ])
  })
})

describe('installNativeHost', () => {
  it('writes a manifest only the whiteboard extension may start, in each engine', async () => {
    const chromeDir = join(scratch, 'chrome', 'NativeMessagingHosts')
    const firefoxDir = join(scratch, 'firefox', 'native-messaging-hosts')
    const result = await installNativeHost({
      dataDir: join(scratch, 'data'),
      manifestDirs: [
        { browser: 'chrome', engine: 'chromium', dir: chromeDir },
        { browser: 'firefox', engine: 'firefox', dir: firefoxDir },
      ],
      launcher: launcherFor('/opt/whiteboard/cli.js'),
    })

    const read = (dir: string) =>
      JSON.parse(readFileSync(join(dir, `${NATIVE_HOST_NAME}.json`), 'utf8'))
    const common = {
      name: NATIVE_HOST_NAME,
      description: expect.any(String),
      path: result.launcher,
      type: 'stdio',
    }
    expect(read(chromeDir)).toEqual({
      ...common,
      allowed_origins: [`chrome-extension://${WHITEBOARD_EXTENSION_ID}/`],
    })
    // Firefox refuses a manifest carrying Chromium's key as "No such native
    // application", so each engine gets only its own.
    expect(read(firefoxDir)).toEqual({ ...common, allowed_extensions: [WHITEBOARD_GECKO_ID] })
    expect(statSync(result.launcher).mode & 0o777).toBe(0o700)
  })

  // The browser starts the launcher with its own arguments and environment,
  // so the data dir it relays to is fixed at install time — through a shell
  // script, where a path with a space or a quote is the usual way to break.
  it('starts the host for the installed data dir, whatever its path holds', async () => {
    const dataDir = join(scratch, "it's a data dir")
    const entry = join(scratch, 'entry.mjs')
    writeFileSync(
      entry,
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), dataDir: process.env.WHITEBOARD_DATA_DIR }))',
    )
    const { launcher } = await installNativeHost({
      dataDir,
      manifestDirs: [],
      launcher: launcherFor(entry),
    })

    const out = JSON.parse(
      execFileSync(launcher, ['chrome-extension://abc/'], { encoding: 'utf8' }),
    )
    expect(out).toEqual({ argv: ['native-host', 'run', 'chrome-extension://abc/'], dataDir })
  })
})

// ADR-0050 decision 9. Windows reads a host's manifest path from the registry,
// per browser, rather than from a directory the browser owns.
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests#windows
describe('installNativeHost on Windows', () => {
  it('names a registry key per browser, with the manifest kept under the data dir', () => {
    const dataDir = join(scratch, 'data')
    expect(nativeHostManifestDirs(scratch, 'win32', dataDir)).toEqual([
      {
        browser: 'chrome',
        engine: 'chromium',
        dir: join(dataDir, 'native-host', 'chrome'),
        registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
      },
      {
        browser: 'chromium',
        engine: 'chromium',
        dir: join(dataDir, 'native-host', 'chromium'),
        registryKey: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
      },
      {
        browser: 'edge',
        engine: 'chromium',
        dir: join(dataDir, 'native-host', 'edge'),
        registryKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
      },
      {
        browser: 'firefox',
        engine: 'firefox',
        dir: join(dataDir, 'native-host', 'firefox'),
        registryKey: 'HKCU\\Software\\Mozilla\\NativeMessagingHosts',
      },
    ])
  })

  it('registers each manifest and starts the host through a cmd launcher', async () => {
    const dataDir = join(scratch, 'data dir')
    const registered: [string, string][] = []
    const manifestDirs = nativeHostManifestDirs(scratch, 'win32', dataDir).slice(0, 1)
    const { launcher, manifests } = await installNativeHost({
      dataDir,
      manifestDirs,
      launcher: launcherFor('C:\\whiteboard\\cli.js'),
      platform: 'win32',
      register: async (key, value) => {
        registered.push([key, value])
      },
    })

    const manifestPath = join(manifestDirs[0]!.dir, `${NATIVE_HOST_NAME}.json`)
    expect(registered).toEqual([
      [`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, manifestPath],
    ])
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).path).toBe(launcher)
    expect(manifests).toHaveLength(1)
    expect(launcher.endsWith('.cmd')).toBe(true)
    const script = readFileSync(launcher, 'utf8')
    expect(script).toContain(`set "WHITEBOARD_DATA_DIR=${dataDir}"`)
    expect(script).toContain('"C:\\whiteboard\\cli.js" native-host run %*')
  })

  // cmd has no quoting a `"` can live inside, so such a path is refused rather
  // than written into a launcher that would run something else.
  it('refuses a path cmd cannot quote', async () => {
    await expect(
      installNativeHost({
        dataDir: join(scratch, 'a"b'),
        manifestDirs: [],
        launcher: launcherFor('C:\\cli.js'),
        platform: 'win32',
        register: async () => {},
      }),
    ).rejects.toThrow(/cannot be quoted/)
  })
})
