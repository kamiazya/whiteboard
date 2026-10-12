import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cdpPortRefusal,
  cdpReadyPort,
  chromiumArgs,
  connectedHostInstall,
  devServerUrl,
  installHost,
  parseDevConnectedArgs,
} from './dev-connected-lib.mjs'
import { armVirtualPasskeys, prfAuthenticatorOptions } from './virtual-passkey.mjs'

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

  it.each([
    Number.NaN,
    1.5,
    -1,
    65_536,
    70_000,
  ])('refuses %s, which is no port at all', async (port) => {
    expect(await cdpPortRefusal(port)).toMatch(/must be a port number/)
  })

  it('takes the highest port as a port, whether or not it is free', async () => {
    expect((await cdpPortRefusal(65_535)) ?? '').not.toMatch(/must be a port number/)
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

describe('cdpReadyPort', () => {
  let scratch: string | undefined
  let held: Server | undefined

  afterEach(async () => {
    await new Promise((closed) => held?.close(closed) ?? closed(undefined))
    held = undefined
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  it('reads the port Chromium chose for 0 from DevToolsActivePort', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'dev-connected-cdp-ready-'))

    expect(await cdpReadyPort({ profileDir: scratch, cdpPort: 0 })).toBeUndefined()

    writeFileSync(join(scratch, 'DevToolsActivePort'), '43681\n/devtools/browser/x\n')
    expect(await cdpReadyPort({ profileDir: scratch, cdpPort: 0 })).toBe('43681')
  })

  // Chromium writes DevToolsActivePort only for port 0, so a pinned port is
  // ready when its endpoint answers, with no file in the profile at all.
  it('answers a pinned port once its /json/version does, with no DevToolsActivePort', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'dev-connected-cdp-ready-'))
    const server = createHttpServer((req, res) => {
      if (req.url !== '/json/version') {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/x' }))
    })
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
    held = server
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')

    expect(await cdpReadyPort({ profileDir: scratch, cdpPort: address.port })).toBe(
      String(address.port),
    )
  })

  it('has no answer for a pinned port that accepts and never replies', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'dev-connected-cdp-ready-'))
    const server = createHttpServer(() => {})
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
    held = server
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')

    expect(await cdpReadyPort({ profileDir: scratch, cdpPort: address.port })).toBeUndefined()
  }, 5_000)

  it('has no answer for a pinned port nothing listens on yet', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'dev-connected-cdp-ready-'))
    const { server, port } = await holdAPort()
    await new Promise((closed) => server.close(closed))

    expect(await cdpReadyPort({ profileDir: scratch, cdpPort: port })).toBeUndefined()
  })
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

describe('prfAuthenticatorOptions', () => {
  it('is a platform passkey with PRF that confirms every prompt on its own', () => {
    expect(prfAuthenticatorOptions()).toEqual({
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    })
  })
})

describe('parseDevConnectedArgs', () => {
  it('gives a headless run a virtual passkey, since nothing there can answer a real one', () => {
    expect(parseDevConnectedArgs(['--headless']).virtualPasskey).toBe(true)
    expect(parseDevConnectedArgs([]).virtualPasskey).toBe(false)
  })

  it('lets --virtual-passkey and --no-virtual-passkey override the default', () => {
    expect(parseDevConnectedArgs(['--virtual-passkey']).virtualPasskey).toBe(true)
    expect(parseDevConnectedArgs(['--headless', '--no-virtual-passkey']).virtualPasskey).toBe(false)
  })

  it('keeps the defaults of the other flags', () => {
    expect(parseDevConnectedArgs([])).toMatchObject({
      headless: false,
      port: '5173',
      'cdp-port': '0',
      help: false,
    })
  })

  it('refuses a flag it does not know', () => {
    expect(() => parseDevConnectedArgs(['--passkey'])).toThrow()
  })
})

type Sent = { method: string; params?: unknown; sessionId?: string }

/** A browser-level CDP connection that records what is sent and lets a test fire events. */
function fakeBrowserSession() {
  const sent: Sent[] = []
  const lost = new Set<string>()
  const handlers = new Map<string, (params: never) => void>()
  let next = 0
  return {
    sent,
    session: {
      send: async (method: string, params?: unknown, sessionId?: string) => {
        sent.push({ method, params, sessionId })
        if (
          method === 'WebAuthn.getCredentials' &&
          sessionId !== undefined &&
          lost.has(sessionId)
        ) {
          throw new Error(
            'The Virtual Authenticator Environment has not been enabled for this session',
          )
        }
        if (method === 'WebAuthn.enable' && sessionId !== undefined) lost.delete(sessionId)
        if (method === 'WebAuthn.getCredentials') return { credentials: [] }
        if (method !== 'WebAuthn.addVirtualAuthenticator') return {}
        next += 1
        return { authenticatorId: `auth-${next}` }
      },
      on: (event: string, handler: (params: never) => void) => handlers.set(event, handler),
    },
    attach: (sessionId: string, type: string) =>
      (handlers.get('Target.attachedToTarget') as (p: unknown) => void)({
        sessionId,
        targetInfo: { type, targetId: `t-${sessionId}`, url: 'http://localhost:5173/' },
        waitingForDebugger: true,
      }),
    lose: (sessionId: string) => lost.add(sessionId),
    detach: (sessionId: string) =>
      (handlers.get('Target.detachedFromTarget') as (p: unknown) => void)({ sessionId }),
  }
}

describe('armVirtualPasskeys', () => {
  const armed: Array<{ stop: () => void }> = []
  afterEach(() => {
    for (const passkeys of armed.splice(0)) passkeys.stop()
  })
  const arm = async (...args: Parameters<typeof armVirtualPasskeys>) => {
    const passkeys = await armVirtualPasskeys(...args)
    armed.push(passkeys)
    return passkeys
  }

  it('auto-attaches to pages, so a tab opened later by anyone is covered too', async () => {
    const fake = fakeBrowserSession()

    await arm(fake.session, { onAdded: () => {}, onReset: () => {}, onError: () => {} })

    const autoAttach = fake.sent.find((m) => m.method === 'Target.setAutoAttach')
    expect(autoAttach?.sessionId).toBeUndefined()
    expect(autoAttach?.params).toMatchObject({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
  })

  it('adds an authenticator to each page as it attaches, on that page, before it runs on', async () => {
    const fake = fakeBrowserSession()
    const added: string[] = []
    await arm(fake.session, {
      onAdded: (page) => added.push(page.sessionId),
      onReset: () => {},
      onError: () => {},
    })

    fake.attach('s1', 'page')
    fake.attach('s2', 'page')
    await vi.waitFor(() => expect(added).toEqual(['s1', 's2']))

    for (const sessionId of ['s1', 's2']) {
      const onPage = fake.sent.filter((m) => m.sessionId === sessionId).map((m) => m.method)
      expect(onPage).toEqual([
        'WebAuthn.enable',
        'WebAuthn.addVirtualAuthenticator',
        'Runtime.runIfWaitingForDebugger',
      ])
    }
    expect(fake.sent.find((m) => m.method === 'WebAuthn.addVirtualAuthenticator')?.params).toEqual({
      options: prfAuthenticatorOptions(),
    })
  })

  it('adds a fresh authenticator when a client detaching from the page took the last one', async () => {
    const fake = fakeBrowserSession()
    const reset: string[] = []
    await arm(fake.session, {
      pollMs: 5,
      onAdded: () => {},
      onReset: (page) => reset.push(page.sessionId),
      onError: () => {},
    })
    fake.attach('s1', 'page')
    await vi.waitFor(() =>
      expect(fake.sent.some((m) => m.method === 'WebAuthn.getCredentials')).toBe(true),
    )

    fake.lose('s1')

    await vi.waitFor(() => expect(reset).toEqual(['s1']))
    const added = fake.sent.filter(
      (m) => m.method === 'WebAuthn.addVirtualAuthenticator' && m.sessionId === 's1',
    )
    expect(added).toHaveLength(2)
  })

  it('stops watching a page once it is gone', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeBrowserSession()
      await arm(fake.session, {
        pollMs: 5,
        onAdded: () => {},
        onReset: () => {},
        onError: () => {},
      })
      const polls = () => fake.sent.filter((m) => m.method === 'WebAuthn.getCredentials').length
      fake.attach('s1', 'page')
      await vi.advanceTimersByTimeAsync(20)
      expect(polls()).toBeGreaterThan(0)

      fake.detach('s1')
      const atDetach = polls()
      await vi.advanceTimersByTimeAsync(50)

      expect(polls()).toBe(atDetach)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a target that is not a page run on without an authenticator', async () => {
    const fake = fakeBrowserSession()
    await arm(fake.session, { onAdded: () => {}, onReset: () => {}, onError: () => {} })

    fake.attach('w1', 'service_worker')
    await vi.waitFor(() =>
      expect(fake.sent.filter((m) => m.sessionId === 'w1').map((m) => m.method)).toEqual([
        'Runtime.runIfWaitingForDebugger',
      ]),
    )
  })
})
