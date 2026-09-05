// Server mode must serve the same /api surface as the local daemon, minus
// the routes that are local-only BY DESIGN — not minus whatever its
// composition root happened to forget to wire.
//
// The gap this closes was live and invisible to every existing guard:
// web-api-paths-mounted.test.ts builds its server-mode app WITH serverDeps
// (the intended shape), while server-mode-http.ts — the real composition
// root — passed none, so a self-hosted deployment 404'd on /api/v1/search,
// /document-tags, /backlinks, /linkify-mentions, /okf and the v1 document
// CRUD while /api/workspaces/* worked, and self-host-with-docker.md's
// promise of "the HTTP API under /api/..." was false. A guard that supplies
// the wiring itself cannot see a root that does not, which is why the first
// test below reads the ROOT'S OWN SOURCE for the option.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import { createApp } from '../app.js'
import { createDaemonIdentity } from '../security/daemon-identity.js'
import { createPairingGrantStore } from '../security/pairing-grant-store.js'
import { createPairingCodeStore, createPairingTokenStore } from '../security/pairing-session.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('server mode mounts the same /api surface as the local daemon', () => {
  it("server-mode-http.ts passes serverDeps to createApp — the root's own wiring, not a test's", () => {
    // Source-level on purpose: the functional check below configures both
    // apps itself, so it can only prove the SHAPE works — a composition
    // root that stops passing the option would leave it green. This line is
    // what failed before the fix.
    const source = readFileSync(join(__dirname, '../server-mode-http.ts'), 'utf-8')
    expect(
      /\bserverDeps\b/.test(source),
      'server-mode-http.ts builds no ServerDeps, so createApp mounts no /api/v1 surface — the self-hosted daemon 404s on half its documented API',
    ).toBe(true)
  })

  it('the two modes register identical /api/* route sets, minus the declared local-only routes', () => {
    const serverMode = createApp({
      authMode: 'server-mode',
      publicBaseUrl: 'https://example.com',
      allowedOrigins: ['https://example.com'],
      authStrategy: () => ({ ok: false as const, status: 401 as const, error: 'denied' }),
      touch: () => {},
      getStatus: () => ({}) as never,
      shutdown: () => Promise.resolve(),
      serverDeps: resolveServerDeps(createContainer()),
    })

    const pairingDir = mkdtempSync(join(tmpdir(), 'route-parity-'))
    tempDirs.push(pairingDir)
    const localDaemon = createApp({
      authMode: 'local-daemon',
      token: 'test-token',
      publicBaseUrl: 'http://127.0.0.1:3099',
      allowedOrigins: ['http://127.0.0.1:3099'],
      touch: () => {},
      getStatus: () => ({}) as never,
      shutdown: () => Promise.resolve(),
      identity: createDaemonIdentity({ dataDir: pairingDir }),
      pairing: {
        grants: createPairingGrantStore(pairingDir),
        codes: createPairingCodeStore(),
        tokens: createPairingTokenStore(),
      },
      serverDeps: resolveServerDeps(createContainer()),
    })

    const apiRoutes = (app: ReturnType<typeof createApp>): Set<string> =>
      new Set(
        app.routes
          .filter((route) => route.path.startsWith('/api/'))
          .map((route) => `${route.method} ${route.path}`),
      )

    const server = apiRoutes(serverMode)
    const local = apiRoutes(localDaemon)

    // Local-only BY DESIGN, each with the reason recorded where it is
    // enforced: pairing-grant consent assumes the daemon's own served UI
    // and loopback reachability (app.ts's pairing mount comment), and the
    // ws-ticket mint pairs with the WS upgrade endpoint that only the local
    // daemon's HTTP server hosts (server mode installs no upgrade handler —
    // whether any client uses the ticket flow at all is a separate open
    // question, issues/adr-0005-ws-ticket-fate).
    const LOCAL_ONLY_PREFIXES = ['/api/pairing', '/api/ws-ticket']

    const missingFromServerMode = [...local].filter(
      (route) =>
        !server.has(route) &&
        !LOCAL_ONLY_PREFIXES.some((prefix) => route.split(' ')[1]?.startsWith(prefix)),
    )
    const extraInServerMode = [...server].filter((route) => !local.has(route))

    // Not vacuous: both sets must actually carry the surfaces this test is
    // about, or a broken option shape would compare two empty sets.
    expect([...server].some((route) => route.includes('/api/v1/'))).toBe(true)
    expect([...local].some((route) => route.includes('/api/workspaces'))).toBe(true)

    expect(missingFromServerMode).toEqual([])
    expect(extraInServerMode).toEqual([])
  })
})
