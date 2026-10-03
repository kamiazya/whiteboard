/**
 * Server mode serves the same SSE audience the local daemon does, so what an
 * agent does through `/mcp` has to reach the browsers streaming from this
 * instance: `wb_viewport_set` answers `delivered: true` only through a
 * `CanvasClientNotifier`, and a root that attaches none answers `false` to a
 * page that is open and ready.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bearerNamesItsSubject, ISSUER, PUBLIC_URL } from './_test-server-mode-harness.js'
import { toServedServer as toServer } from './_test-server-mode-served.js'
import { createMemberProfileStore } from './security/member-profile-store.js'
import { resetSyncStreamsForTests } from './sync-streams.js'

let tempDir: string

vi.mock(
  '@hono/node-server',
  async () => (await import('./_test-server-mode-served.js')).nodeServerStub,
)

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js')
  return {
    ...actual,
    get DATA_DIR() {
      return tempDir
    },
    getDataDir: () => tempDir,
  }
})

const { startServerModeHttp } = await import('./server-mode-http.js')
const { getDb } = await import('./store/db/index.js')

let running: Awaited<ReturnType<typeof startServerModeHttp>> | undefined

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-live-audience-'))
})
afterEach(async () => {
  await running?.close()
  running = undefined
  resetSyncStreamsForTests()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const textOf = (res: { content: Array<{ text?: string }> }) => res.content[0]?.text ?? ''

describe('server mode — the live audience an agent reaches', () => {
  it('delivers wb_viewport_set to a ready sync stream on this instance', async () => {
    const baseUrl = PUBLIC_URL
    running = await startServerModeHttp({
      host: 'board.example',
      port: 443,
      publicBaseUrl: baseUrl,
      allowedOrigins: [baseUrl],
      authStrategy: bearerNamesItsSubject,
    })
    await createMemberProfileStore(await getDb(tempDir)).ensureProfile({
      binding: { authenticator: ISSUER, subject: 'ada' },
      displayName: 'ada',
    })
    const headers = { Authorization: 'Bearer ada' }

    const client = new Client({ name: 'agent-ada', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      fetch: (input, init) => {
        const withAuth = new Headers(init?.headers)
        withAuth.set('Authorization', headers.Authorization)
        return toServer(input instanceof URL ? input.href : input, { ...init, headers: withAuth })
      },
    })
    await client.connect(transport)
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }) as Promise<{
        isError?: boolean
        structuredContent?: Record<string, unknown>
        content: Array<{ text?: string }>
      }>
    try {
      const created = await call('wb_workspace_edit', {
        workspaceId: 'plans',
        createWorkspace: true,
        ops: [{ op: 'document.create', path: 'board', kind: 'spatial' }],
      })
      expect(created.isError, textOf(created)).toBeFalsy()
      const { workspaceId, results } = created.structuredContent as {
        workspaceId: string
        results: Array<{ documentId: string }>
      }
      const documentId = results[0]?.documentId as string

      const stream = await toServer(`${baseUrl}/api/sync/stream`, { headers })
      const reader = (stream.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      const opened = decoder.decode((await reader.read()).value)
      const { streamId } = JSON.parse(opened.split('data:')[1] ?? '{}') as { streamId: string }
      const doc = `${workspaceId}/board`
      const post = (path: string, body: unknown) =>
        toServer(`${baseUrl}/api/sync/${path}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      expect((await post('subscribe', { streamId, subscribe: [doc] })).status).toBe(200)
      expect(
        (await post('message', { streamId, doc, message: { type: 'client_ready' } })).status,
      ).toBe(200)

      const viewport = await call('wb_viewport_set', { workspaceId, documentId, mode: 'fit' })
      expect(viewport.isError, textOf(viewport)).toBeFalsy()
      expect(viewport.structuredContent).toEqual({ documentId, delivered: true })

      const frame = decoder.decode((await reader.read()).value)
      expect(frame).toContain('viewport_request')
      await reader.cancel()
    } finally {
      await transport.close()
    }
  })
})
