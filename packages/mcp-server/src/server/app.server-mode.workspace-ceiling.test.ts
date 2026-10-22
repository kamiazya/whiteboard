/**
 * Server mode holds each person's namespace to `NAMESPACE_MAX_WORKSPACES`,
 * on both ways a workspace is created: `/api`'s create and an agent's
 * `createWorkspace` through `/mcp`. Every member shares the tenant's
 * registry, so an unbounded namespace is one person making every other
 * person's requests cost more.
 *
 * The namespace is filled by inserting registry rows directly — a thousand
 * creates through the route would test the route a thousand times and the
 * ceiling once.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateDocumentId, SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import { NAMESPACE_MAX_WORKSPACES } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bearerNamesItsSubject,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
} from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { resolveTestServerDeps, testDataLayout } from './routes/_test-helpers.js'
import type { MemberProfileStore } from './security/member-profile-store.js'
import { createIsolatedDb } from './store/db/test-helpers.js'
import { resetSyncStreamsForTests } from './sync-streams.js'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('./app.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let serverDeps: ServerDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-workspace-ceiling-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const stores = serverModePeople(handle.db, tempDir)
  members = stores.members
  serverDeps = await resolveTestServerDeps(tempDir)
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps,
    dataLayout: testDataLayout(tempDir),
    people: stores.people,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  app = createApp(options)
})
afterEach(async () => {
  resetSyncStreamsForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

async function personFor(subject: string): Promise<Record<string, string>> {
  await members.ensureProfile({ binding: { authenticator: ISSUER, subject }, displayName: subject })
  return { authorization: `Bearer ${subject}` }
}

function create(headers: Record<string, string>, displayName: string) {
  return app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
}

async function held(namespace: string): Promise<number> {
  const row = await handle.db
    .selectFrom('workspaces')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('namespace', '=', namespace)
    .executeTakeFirstOrThrow()
  return Number(row.n)
}

async function insertRows(namespace: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: generateDocumentId(),
    namespace,
    segment: `filler-${i}`,
    displayName: null,
    createdAt: 0,
    updatedAt: 0,
  }))
  await handle.db.insertInto('workspaces').values(rows).execute()
}

/** Fills the caller's namespace to `ceiling - room`, its first workspace made through the route. */
async function fill(headers: Record<string, string>, room = 0): Promise<string> {
  const first = await create(headers, 'First')
  expect(first.status).toBe(201)
  const { namespace } = (await first.json()) as { namespace: string }
  await insertRows(namespace, NAMESPACE_MAX_WORKSPACES - 1 - room)
  expect(await held(namespace)).toBe(NAMESPACE_MAX_WORKSPACES - room)
  return namespace
}

describe('server mode — a namespace holds at most the workspace ceiling', () => {
  it('refuses a create past the ceiling with too_many_workspaces, writing nothing', async () => {
    const ada = await personFor('ada')
    const namespace = await fill(ada)

    const res = await create(ada, 'One more')

    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'too_many_workspaces' })
    expect(await held(namespace)).toBe(NAMESPACE_MAX_WORKSPACES)
  })

  it('lets one of several concurrent creates take the last place', async () => {
    const ada = await personFor('ada')
    const namespace = await fill(ada, 1)

    const statuses = await Promise.all(
      ['A', 'B', 'C', 'D'].map(async (name) => (await create(ada, name)).status),
    )

    expect(statuses.filter((status) => status === 201)).toHaveLength(1)
    expect(statuses.filter((status) => status === 413)).toHaveLength(3)
    expect(await held(namespace)).toBe(NAMESPACE_MAX_WORKSPACES)
  })

  it('does not hold the single-person namespace to the ceiling', async () => {
    await insertRows(SINGLE_PERSON_NAMESPACE, NAMESPACE_MAX_WORKSPACES)

    await serverDeps.documentIndex.createWorkspace({ workspaceId: generateDocumentId() })

    expect(await held(SINGLE_PERSON_NAMESPACE)).toBe(NAMESPACE_MAX_WORKSPACES + 1)
  })

  it("leaves another person's namespace free to create", async () => {
    await fill(await personFor('ada'))

    expect((await create(await personFor('eve'), 'Mine')).status).toBe(201)
  })

  it("refuses an agent's createWorkspace past the ceiling with the same code", async () => {
    const ada = await personFor('ada')
    const namespace = await fill(ada)
    const client = new Client({ name: 'agent-ada', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
      fetch: async (input, init) => {
        const headers = new globalThis.Headers(init?.headers)
        headers.set('Authorization', ada.authorization as string)
        return app.request(input instanceof URL ? input.toString() : String(input), {
          ...init,
          headers,
        })
      },
    })
    await client.connect(transport)
    try {
      const res = (await client.callTool({
        name: 'wb_workspace_edit',
        arguments: {
          workspaceId: 'overflow',
          createWorkspace: true,
          ops: [{ op: 'document.create', path: 'note', kind: 'markdown', markdown: 'x' }],
        },
      })) as { isError?: boolean; content: { text?: string }[] }

      expect(res.isError).toBe(true)
      expect(res.content[0]?.text).toContain('too_many_workspaces')
      expect(await held(namespace)).toBe(NAMESPACE_MAX_WORKSPACES)
    } finally {
      await transport.close()
    }
  })
})
