// The plugin set is a COMPOSITION-TIME choice (ADR-0013 decision 3), and a
// root hands it to `createApp` as `serverDeps`. `/api/v1` honoured that from
// the start; `/mcp` built its own ServerDeps per request from the bundled
// set, so `facetPlugins` reached every REST route and no tool — the
// built-but-unwired class `di/facet-registry-wiring.test.ts` describes, one
// transport over. This pins that the deps a root composed are the deps a
// tool answers with, over the real endpoint rather than a hand-called tool.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { visualPlugin } from '@kamiazya/whiteboard-plugin-visual'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-app-mcp-deps-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { createApp } = await import('./app.js')
const { createContainer, resolveServerDeps } = await import('../di/container.js')
const { PACKAGE_VERSION } = await import('../shared/package-version.js')

const pack = definePlugin({
  id: 'infra',
  displayName: 'Infra',
  facets: [],
  assets: { stencils: { bucket: { displayName: 'Bucket', color: '2' } } },
})

describe('/mcp serves the ServerDeps the root composed', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
  })

  // Both serving eras, because they are two code paths: the legacy
  // per-request server in `routes/mcp.ts` and the SDK's modern handler in
  // `app.ts`, each handed the root's deps separately. Measured: with only
  // one of them threaded, a client of the other era still answered from
  // the bundled set.
  it.each([
    ['a legacy-era client', undefined],
    ['a modern-pinned client', { versionNegotiation: { mode: { pin: '2026-07-28' } } }],
  ] as const)('lists a stencil only the root registered, for %s', async (_era, clientOptions) => {
    const serverDeps = resolveServerDeps(createContainer(), { plugins: [visualPlugin, pack] })
    const app = createApp({
      authMode: 'local-daemon',
      token: 'secret',
      touch: vi.fn(),
      getStatus: () => ({
        ok: true,
        pid: 10,
        socketPath: '/run/user/1000/whiteboard/d.sock',
        version: PACKAGE_VERSION,
        startedAt: '2026-04-23T00:00:00.000Z',
        uptimeMs: 100,
        idleForMs: 10,
        auth: { mode: 'local-token', hasToken: true },
        storage: { dataDir: '/tmp', dataDirWritable: true },
        mcp: { httpEnabled: true },
        clients: { connected: 0, ready: 0 },
      }),
      serverDeps,
    })
    const client = new Client({ name: 'mcp-deps-test', version: '1.0.0' }, clientOptions)
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set('Authorization', 'Bearer secret')
        headers.set('Origin', 'http://127.0.0.1:6274')
        return app.request(input instanceof URL ? input.toString() : String(input), {
          ...init,
          headers,
        })
      },
    })
    await client.connect(transport)

    const result = await client.callTool({
      name: 'wb_facet_list',
      arguments: { assetKind: 'stencils' },
    })

    const assets = (result.structuredContent as { assets: { id: string }[] }).assets
    expect(assets.map((asset) => asset.id)).toContain('infra.bucket')
    await transport.close()
  })
})
