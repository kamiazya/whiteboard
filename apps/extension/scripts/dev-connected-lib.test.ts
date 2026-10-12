import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cdpPortRefusal,
  chromiumArgs,
  connectedHostInstall,
  devServerUrl,
  installHost,
} from './dev-connected-lib.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'dev-connected.mjs')

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

/** A listener on an OS-chosen loopback port, standing in for another session's Chromium. */
async function holdAPort(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

describe('cdpPortRefusal', () => {
  let held: Server | undefined

  afterEach(async () => {
    await new Promise((closed) => held?.close(closed) ?? closed(undefined))
    held = undefined
  })

  it('names a held --cdp-port, which Chromium would fail to bind without exiting', async () => {
    const { server, port } = await holdAPort()
    held = server

    const refusal = await cdpPortRefusal(port)

    expect(refusal).toContain(`port ${port} is in use`)
    expect(refusal).toContain('--cdp-port')
  })

  it('has nothing to say about a free port, or about 0 (any free one)', async () => {
    const { server, port } = await holdAPort()
    await new Promise((closed) => server.close(closed))

    expect(await cdpPortRefusal(port)).toBeUndefined()
    expect(await cdpPortRefusal(0)).toBeUndefined()
  })

  it.each([Number.NaN, 1.5, -1, 70_000])('refuses %s, which is no port at all', async (port) => {
    expect(await cdpPortRefusal(port)).toMatch(/must be a port number/)
  })

  // From a directory outside any checkout, so a check that moved below the
  // daemon/build steps fails on the missing repo instead of starting either.
  it('makes the script exit non-zero, naming the port, before anything is started', async () => {
    const { server, port } = await holdAPort()
    held = server
    const cwd = mkdtempSync(join(tmpdir(), 'dev-connected-cdp-'))
    try {
      // Synchronous is fine: the hold is the kernel's bind, not this loop.
      const run = spawnSync(process.execPath, [SCRIPT, '--headless', `--cdp-port=${port}`], {
        cwd,
        // Only what the script needs to reach its first check, so a variable
        // the runner happens to carry cannot change what it does.
        env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
        encoding: 'utf8',
        timeout: 30_000,
      })

      expect(run.status).toBe(1)
      expect(run.stderr).toContain(`port ${port} is in use`)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('devServerUrl', () => {
  it('passes an http(s) address through as a normalised URL', () => {
    expect(devServerUrl('http://localhost:5173')).toBe('http://localhost:5173/')
    expect(devServerUrl('https://example.test/app')).toBe('https://example.test/app')
  })

  it.each([
    '--remote-allow-origins=*',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'localhost:5173',
  ])('refuses %s, which Chromium would read as a flag or a non-web page', (raw) => {
    expect(() => devServerUrl(raw)).toThrow(/http/)
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
