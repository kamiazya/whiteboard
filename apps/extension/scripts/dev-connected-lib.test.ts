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
import {
  armVirtualPasskeys,
  connectBrowserSession,
  prfAuthenticatorOptions,
} from './virtual-passkey.mjs'

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

  it('stops polling every watched page when stopped', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeBrowserSession()
      const passkeys = await armVirtualPasskeys(fake.session, {
        pollMs: 5,
        onAdded: () => {},
        onReset: () => {},
        onError: () => {},
      })
      const polls = () => fake.sent.filter((m) => m.method === 'WebAuthn.getCredentials')
      for (const sessionId of ['s1', 's2', 's3']) fake.attach(sessionId, 'page')
      await vi.advanceTimersByTimeAsync(20)
      expect(new Set(polls().map((m) => m.sessionId))).toEqual(new Set(['s1', 's2', 's3']))

      passkeys.stop()
      const atStop = polls().length
      await vi.advanceTimersByTimeAsync(50)

      expect(polls()).toHaveLength(atStop)
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

/** Stands in for Node's WebSocket: opens at once and records each frame sent. */
class FakeSocket extends EventTarget {
  static last: FakeSocket | undefined
  readonly frames: Array<Record<string, unknown>> = []
  constructor(readonly url: string) {
    super()
    FakeSocket.last = this
    queueMicrotask(() => this.dispatchEvent(new Event('open')))
  }
  send(data: string) {
    this.frames.push(JSON.parse(data))
  }
  close() {}
}

/**
 * A CDP session scripted per test: `getCredentials` answers whatever the test
 * says, so a poll can fail in a way other than losing the authenticator, or
 * hang for longer than the poll interval.
 */
function scriptedPollSession(getCredentials: () => Promise<unknown>) {
  const sent: Sent[] = []
  const handlers = new Map<string, (params: never) => void>()
  return {
    sent,
    polls: () => sent.filter((m) => m.method === 'WebAuthn.getCredentials').length,
    adds: () => sent.filter((m) => m.method === 'WebAuthn.addVirtualAuthenticator').length,
    session: {
      send: async (method: string, params?: unknown, sessionId?: string) => {
        sent.push({ method, params, sessionId })
        if (method === 'WebAuthn.getCredentials') return getCredentials()
        if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'auth-1' }
        return {}
      },
      on: (event: string, handler: (params: never) => void) => handlers.set(event, handler),
    },
    attach: (sessionId: string) =>
      (handlers.get('Target.attachedToTarget') as (p: unknown) => void)({
        sessionId,
        targetInfo: { type: 'page', targetId: `t-${sessionId}`, url: 'http://localhost:5173/' },
        waitingForDebugger: true,
      }),
  }
}

describe('armVirtualPasskeys, polling a page that fails or stalls', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('unwatches a tab whose session closed mid-poll, without re-arming or reporting it', async () => {
    vi.useFakeTimers()
    const fake = scriptedPollSession(async () => {
      throw new Error('No session with given id (WebAuthn.getCredentials)')
    })
    const reset = vi.fn()
    const errors = vi.fn()
    const passkeys = await armVirtualPasskeys(fake.session, {
      pollMs: 5,
      onAdded: () => {},
      onReset: reset,
      onError: errors,
    })
    try {
      fake.attach('s1')
      await vi.advanceTimersByTimeAsync(50)

      expect(fake.polls()).toBe(1)
      expect(fake.adds()).toBe(1)
      expect(reset).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
    } finally {
      passkeys.stop()
    }
  })

  it('starts no second poll while the first is still waiting for its answer', async () => {
    vi.useFakeTimers()
    const fake = scriptedPollSession(() => new Promise(() => {}))
    const passkeys = await armVirtualPasskeys(fake.session, {
      pollMs: 5,
      onAdded: () => {},
      onReset: () => {},
      onError: () => {},
    })
    try {
      fake.attach('s1')
      await vi.advanceTimersByTimeAsync(50)
      expect(fake.polls()).toBe(1)
    } finally {
      passkeys.stop()
    }
  })

  it('polls no page at all once stop() is called', async () => {
    vi.useFakeTimers()
    const fake = scriptedPollSession(async () => ({ credentials: [] }))
    const passkeys = await armVirtualPasskeys(fake.session, {
      pollMs: 5,
      onAdded: () => {},
      onReset: () => {},
      onError: () => {},
    })
    fake.attach('s1')
    fake.attach('s2')
    await vi.advanceTimersByTimeAsync(20)
    expect(fake.polls()).toBeGreaterThan(1)

    passkeys.stop()
    const atStop = fake.polls()
    await vi.advanceTimersByTimeAsync(50)

    expect(fake.polls()).toBe(atStop)
  })
})

type Frame = { id: number; method: string; params: unknown; sessionId?: string }

/**
 * Stands in for the global `WebSocket` `connectBrowserSession` opens: it
 * opens on the next microtask, records each frame sent, and hands every
 * request to `reply` so a test can answer it — or push a frame of its own.
 */
function stubCdpSocket(reply: (frame: Frame, push: (message: object) => void) => void) {
  const frames: Frame[] = []
  let socket: FakeSocket | undefined
  class FakeSocket {
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>()
    constructor(readonly url: string) {
      socket = this
      queueMicrotask(() => this.emit('open', {}))
    }
    addEventListener(type: string, listener: (event: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
    }
    emit(type: string, event: unknown) {
      for (const listener of this.listeners.get(type) ?? []) listener(event)
    }
    push(message: object) {
      this.emit('message', { data: JSON.stringify(message) })
    }
    send(data: string) {
      const frame = JSON.parse(data) as Frame
      frames.push(frame)
      queueMicrotask(() => reply(frame, (message) => this.push(message)))
    }
    close() {
      this.emit('close', {})
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket)
  return {
    frames,
    push: (message: object) => socket?.push(message),
    close: () => socket?.close(),
  }
}

describe('connectBrowserSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('frames a command with empty params when none are given, and no session id unless one is', async () => {
    vi.stubGlobal('WebSocket', FakeSocket)
    const session = await connectBrowserSession('ws://127.0.0.1:1/devtools/browser/x')
    const socket = FakeSocket.last as FakeSocket

    void session.send('Target.getTargets')
    void session.send('WebAuthn.enable', undefined, 's1')
    void session.send('WebAuthn.getCredentials', { authenticatorId: 'a' }, 's2')

    expect(socket.frames).toEqual([
      { id: 1, method: 'Target.getTargets', params: {} },
      { id: 2, method: 'WebAuthn.enable', params: {}, sessionId: 's1' },
      {
        id: 3,
        method: 'WebAuthn.getCredentials',
        params: { authenticatorId: 'a' },
        sessionId: 's2',
      },
    ])
  })

  it('pairs each answer with its request by id, whatever order the answers arrive in', async () => {
    const held: Frame[] = []
    const socket = stubCdpSocket((frame) => held.push(frame))
    const session = await connectBrowserSession('ws://127.0.0.1:1/devtools/browser/x')

    const first = session.send('Target.getTargets', { a: 1 }, 's1')
    const second = session.send('Browser.getVersion')
    await vi.waitFor(() => expect(held).toHaveLength(2))

    expect(socket.frames).toEqual([
      { id: 1, method: 'Target.getTargets', params: { a: 1 }, sessionId: 's1' },
      { id: 2, method: 'Browser.getVersion', params: {} },
    ])
    socket.push({ id: 2, result: { product: 'Chrome' } })
    socket.push({ id: 1, result: { targetInfos: [] } })
    await expect(second).resolves.toEqual({ product: 'Chrome' })
    await expect(first).resolves.toEqual({ targetInfos: [] })
  })

  it("refuses with the error's message and the method that drew it", async () => {
    stubCdpSocket((frame, push) =>
      push({ id: frame.id, error: { code: -32000, message: 'No target with given id' } }),
    )
    const session = await connectBrowserSession('ws://127.0.0.1:1/devtools/browser/x')
    await expect(session.send('Target.attachToTarget')).rejects.toThrow(
      'No target with given id (Target.attachToTarget)',
    )
  })

  it('dispatches an event to the handler subscribed to its method, and to nothing else', async () => {
    const socket = stubCdpSocket(() => {})
    const session = await connectBrowserSession('ws://127.0.0.1:1/devtools/browser/x')
    const attached = vi.fn()
    const detached = vi.fn()
    session.on('Target.attachedToTarget', attached)
    session.on('Target.detachedFromTarget', detached)

    socket.push({ method: 'Target.attachedToTarget', params: { sessionId: 's1' } })
    socket.push({ method: 'Target.targetCreated', params: { sessionId: 's2' } })

    expect(attached).toHaveBeenCalledExactlyOnceWith({ sessionId: 's1' })
    expect(detached).not.toHaveBeenCalled()
  })

  it('refuses every request still waiting when the connection closes', async () => {
    const socket = stubCdpSocket(() => {})
    const session = await connectBrowserSession('ws://127.0.0.1:1/devtools/browser/x')
    const waiting = session.send('Browser.getVersion')
    socket.close()
    await expect(waiting).rejects.toThrow('CDP connection closed')
  })

  it("re-arms a page through it when Chromium's error says the authenticator is gone", async () => {
    // The re-arm decision matches the REFUSAL'S text, which this connection
    // formats; the two halves only agree if that text still carries
    // Chromium's message.
    let getCredentialsCalls = 0
    let added = 0
    const socket = stubCdpSocket((frame, push) => {
      if (frame.method === 'WebAuthn.getCredentials') {
        getCredentialsCalls += 1
        if (getCredentialsCalls === 1) {
          push({
            id: frame.id,
            error: {
              code: -32000,
              message: 'Could not find a Virtual Authenticator matching the ID',
            },
          })
          return
        }
        push({ id: frame.id, result: { credentials: [] } })
        return
      }
      if (frame.method === 'WebAuthn.addVirtualAuthenticator') {
        added += 1
        push({ id: frame.id, result: { authenticatorId: `auth-${added}` } })
        return
      }
      push({ id: frame.id, result: {} })
    })
    const session = await connectBrowserSession('ws://127.0.0.1:1/devtools/browser/x')
    const reset = vi.fn()
    const errors = vi.fn()
    const passkeys = await armVirtualPasskeys(session, {
      pollMs: 5,
      onAdded: () => {},
      onReset: reset,
      onError: errors,
    })
    try {
      socket.push({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 's1',
          targetInfo: { type: 'page', targetId: 't1', url: 'http://localhost:5173/' },
          waitingForDebugger: true,
        },
      })
      await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce())
      expect(reset.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's1', authenticatorId: 'auth-2' })
      expect(errors).not.toHaveBeenCalled()
    } finally {
      passkeys.stop()
    }
  })
})
