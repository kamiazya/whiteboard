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
      { browser: 'chrome', dir: join(scratch, '.config/google-chrome/NativeMessagingHosts') },
      { browser: 'edge', dir: join(scratch, '.config/microsoft-edge/NativeMessagingHosts') },
    ])
  })

  it('looks under Application Support on macOS', () => {
    mkdirSync(join(scratch, 'Library/Application Support/Google/Chrome'), { recursive: true })
    expect(nativeHostManifestDirs(scratch, 'darwin')).toEqual([
      {
        browser: 'chrome',
        dir: join(scratch, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      },
    ])
  })
})

describe('installNativeHost', () => {
  it('writes a manifest only the whiteboard extension may start', async () => {
    const manifestDir = join(scratch, 'profile', 'NativeMessagingHosts')
    const result = await installNativeHost({
      dataDir: join(scratch, 'data'),
      manifestDirs: [{ browser: 'chrome', dir: manifestDir }],
      launcher: launcherFor('/opt/whiteboard/cli.js'),
    })

    const manifest = JSON.parse(readFileSync(join(manifestDir, `${NATIVE_HOST_NAME}.json`), 'utf8'))
    expect(manifest).toEqual({
      name: NATIVE_HOST_NAME,
      description: expect.any(String),
      path: result.launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${WHITEBOARD_EXTENSION_ID}/`],
    })
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
