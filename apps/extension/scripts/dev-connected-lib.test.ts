import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromiumArgs, connectedHostInstall, installHost } from './dev-connected-lib.mjs'

const NATIVE_HOST_MANIFEST = 'io.github.kamiazya.whiteboard.json'

describe('connectedHostInstall', () => {
  it("registers the host for the checkout's .dev-data inside the throwaway profile", () => {
    const plan = connectedHostInstall({
      env: {},
      repoRoot: '/repo',
      profileDir: '/scratch/profile',
    })

    expect(plan.dataDir).toBe(resolve('/repo/.dev-data'))
    expect(plan.manifestDir).toBe(resolve('/scratch/profile/NativeMessagingHosts'))
    expect(plan.args).toEqual([
      'native-host',
      'install',
      '--json',
      `--data-dir=${resolve('/repo/.dev-data')}`,
      `--manifest-dir=${resolve('/scratch/profile/NativeMessagingHosts')}`,
    ])
  })

  it('follows a WHITEBOARD_DATA_DIR override, as the dev daemon does', () => {
    const plan = connectedHostInstall({
      env: { WHITEBOARD_DATA_DIR: '/elsewhere/data' },
      repoRoot: '/repo',
      profileDir: '/scratch/profile',
    })

    expect(plan.dataDir).toBe(resolve('/elsewhere/data'))
  })
})

describe('chromiumArgs', () => {
  it('starts the browser on the throwaway profile, which is where it reads the host from', () => {
    const args = chromiumArgs({
      profileDir: '/scratch/profile',
      extensionDir: '/ext/dist/development',
      cdpPort: 0,
      headless: false,
      url: 'http://localhost:5173/',
    })

    expect(args).toContain('--user-data-dir=/scratch/profile')
    expect(args).toContain('--load-extension=/ext/dist/development')
    expect(args).toContain('--remote-debugging-port=0')
    expect(args).not.toContain('--headless')
    expect(args).not.toContain('--no-sandbox')
    expect(args.at(-1)).toBe('http://localhost:5173/')
  })

  it('adds --headless and --no-sandbox only when asked', () => {
    const args = chromiumArgs({
      profileDir: '/p',
      extensionDir: '/e',
      cdpPort: 9333,
      headless: true,
      noSandbox: true,
      url: 'http://localhost:5173/',
    })

    expect(args).toContain('--headless')
    expect(args).toContain('--no-sandbox')
    expect(args).toContain('--remote-debugging-port=9333')
  })
})

describe('installHost, through the real CLI', () => {
  let scratch: string | undefined

  afterEach(() => {
    vi.unstubAllEnvs()
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  it('writes the manifest into the profile and nothing where a browser of the user looks', () => {
    scratch = mkdtempSync(join(tmpdir(), 'dev-connected-test-'))
    const home = join(scratch, 'home')
    // A user who has run these browsers: an install that ignored the profile
    // would register itself under each of them.
    for (const dir of ['.config/chromium', '.config/google-chrome', '.mozilla']) {
      mkdirSync(join(home, dir), { recursive: true })
    }
    vi.stubEnv('HOME', home)
    const profileDir = join(scratch, 'profile')
    const dataDir = join(scratch, 'data')

    const { plan, result } = installHost({
      env: { WHITEBOARD_DATA_DIR: dataDir },
      repoRoot: scratch,
      profileDir,
    })

    expect(result.manifests.map((m: { dir: string }) => m.dir)).toEqual([plan.manifestDir])
    const manifest = JSON.parse(
      readFileSync(join(profileDir, 'NativeMessagingHosts', NATIVE_HOST_MANIFEST), 'utf8'),
    )
    expect(manifest.path).toBe(join(dataDir, 'native-host', 'whiteboard-native-host'))
    expect(readFileSync(manifest.path, 'utf8')).toContain(`WHITEBOARD_DATA_DIR='${dataDir}'`)
    for (const dir of ['.config/chromium', '.config/google-chrome', '.mozilla']) {
      expect(readdirSync(join(home, dir))).toEqual([])
    }
  }, 60_000)
})
