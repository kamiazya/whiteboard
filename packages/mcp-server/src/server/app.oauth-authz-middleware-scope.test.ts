import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-app-oauth-probe-test-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

vi.mock('../daemon/ensure-daemon.js', () => ({
  ensureDaemon: vi.fn(async () => ({
    pid: 1,
    port: 3099,
    token: 'secret',
    version: '0.1.0',
    startedAt: '2026-04-24T00:00:00.000Z',
    baseUrl: 'http://daemon.test',
  })),
}))

const { createApp } = await import('./app.js')
const { PACKAGE_VERSION } = await import('../shared/package-version.js')

const registry = [
  {
    clientId: 'whiteboard-hosted-web',
    redirectUris: ['https://whiteboard.pages.dev/oauth/callback'],
  },
]

function buildRuntimeOptions(overrides: Record<string, unknown> = {}) {
  return {
    authMode: 'local-daemon' as const,
    touch: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    getStatus: () => ({
      ok: true,
      pid: 10,
      host: '127.0.0.1',
      port: 3099,
      baseUrl: 'http://127.0.0.1:3099',
      version: PACKAGE_VERSION,
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 100,
      idleForMs: 10,
      auth: { mode: 'local-token', hasToken: false },
      storage: { dataDir: '/tmp', dataDirWritable: true },
      app: { served: true, buildPresent: false, ui: 'web-app' },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 0, ready: 0 },
    }),
    ...overrides,
  }
}

// The OAuth surface's host guard and CORS must apply to its own three paths
// and nothing else. Hono merges a sub-app's `use('*')` into the parent as
// `/*` rather than confining it to the sub-app's routes, so mounting the
// router as a guarded sub-app at '/' silently put its CORS handler ahead of
// every other route's policy — an OPTIONS preflight for /mcp was answered
// with 204 instead of /mcp's own origin middleware's 403. This asserts the
// only thing that actually matters: configuring the registry must not change
// how any non-OAuth route responds.
describe('oauth-authz middleware scope', () => {
  it('configuring the oauth registry changes no other route', async () => {
    await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
    await writeFile(join(tmp.dir, 'web-app', 'index.html'), '<!DOCTYPE html><html></html>')

    const withoutOauth = createApp(
      buildRuntimeOptions({ allowedWebOrigins: ['https://whiteboard.pages.dev'] }),
    )
    const withOauth = createApp(
      buildRuntimeOptions({
        allowedWebOrigins: ['https://whiteboard.pages.dev'],
        oauthClientRegistry: registry,
      }),
    )

    const req = () =>
      ({
        method: 'OPTIONS',
        headers: {
          Host: '127.0.0.1:3099',
          Origin: 'https://whiteboard.pages.dev',
          'Access-Control-Request-Method': 'POST',
        },
      }) as const

    const probes: Array<[string, RequestInit]> = [
      ['OPTIONS /mcp allowed origin', req()],
      [
        'OPTIONS /mcp attacker origin',
        {
          method: 'OPTIONS',
          headers: {
            Host: '127.0.0.1:3099',
            Origin: 'https://attacker.example',
            'Access-Control-Request-Method': 'POST',
          },
        },
      ],
      [
        'POST /mcp attacker origin',
        {
          method: 'POST',
          headers: { Host: '127.0.0.1:3099', Origin: 'https://attacker.example' },
        },
      ],
    ]

    const paths = ['/mcp', '/', '/api/runtime/ping']
    const diffs: string[] = []
    for (const path of paths) {
      for (const [label, init] of probes) {
        const a = await withoutOauth.request(`http://127.0.0.1:3099${path}`, init)
        const b = await withOauth.request(`http://127.0.0.1:3099${path}`, init)
        const shape = (r: Response) => ({
          status: r.status,
          acao: r.headers.get('Access-Control-Allow-Origin'),
          acac: r.headers.get('Access-Control-Allow-Credentials'),
        })
        const [sa, sb] = [shape(a), shape(b)]
        if (JSON.stringify(sa) !== JSON.stringify(sb)) {
          diffs.push(`${path} — ${label}: without=${JSON.stringify(sa)} with=${JSON.stringify(sb)}`)
        }
      }
    }

    expect(diffs, 'configuring the oauth registry changed a non-oauth route').toEqual([])
  })
})
