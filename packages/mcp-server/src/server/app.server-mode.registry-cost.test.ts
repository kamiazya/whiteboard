/**
 * What one request costs a server-mode tenant as its registry grows. Every
 * member of a tenant shares that registry, so a request whose cost follows
 * the TENANT's workspace count rather than the caller's lets any one member
 * slow every other member down by creating workspaces.
 *
 * Counted, not timed: the registry rows handed to a caller, and the
 * membership lookups made, while serving one request — numbers a loaded
 * machine cannot move.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bearerNamesItsSubject, PUBLIC_URL, serverModePeople } from './_test-server-mode-harness.js'
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

/** Registry rows handed out, whichever registry instance handed them. */
const registryRows = { count: 0 }

// Every registry this process builds is counted, so the figure covers each
// reader a request reaches — the membership gate's handle resolution, the
// unknown-workspace refusal and the route's own — not one chosen seam.
vi.mock('./store/document-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store/document-store.js')>()
  return {
    ...actual,
    workspaceRegistry: (...args: Parameters<typeof actual.workspaceRegistry>) => {
      const registry = actual.workspaceRegistry(...args)
      return Object.fromEntries(
        Object.entries(registry).map(([name, method]) => [
          name,
          async (...input: unknown[]) => {
            const answer: unknown = await (method as (...a: unknown[]) => Promise<unknown>)(
              ...input,
            )
            if (Array.isArray(answer)) registryRows.count += answer.length
            else if (answer !== null && answer !== undefined) registryRows.count += 1
            return answer
          },
        ]),
      )
    },
  }
})

const { createApp } = await import('./app.js')

/** Calls on the membership store, by method. */
const memberCalls = new Map<string, number>()
const membershipLookups = () => [...memberCalls.values()].reduce((a, b) => a + b, 0)

function counted(members: MemberProfileStore): MemberProfileStore {
  return new Proxy(members, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        memberCalls.set(String(key), (memberCalls.get(String(key)) ?? 0) + 1)
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

/** Workspaces in somebody else's namespace — what a caller pays for and never sees. */
const FOREIGN = 120

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let serverDeps: ServerDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-registry-cost-'))
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
    people: { ...stores.people, members: counted(stores.people.members) },
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  app = createApp(options)
  for (let i = 0; i < FOREIGN; i++) {
    await serverDeps.documentIndex.createWorkspace({
      workspaceId: generateDocumentId(),
      namespace: 'stranger',
      segment: `w${i}`,
    })
  }
})
afterEach(async () => {
  resetSyncStreamsForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

const ada = { authorization: 'Bearer ada' }

async function adaOwnsDesign(): Promise<string> {
  await members.ensureProfile({
    binding: { authenticator: 'oidc:https://idp.test', subject: 'ada' },
    displayName: 'ada',
  })
  const res = await app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...ada, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Design' }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { workspaceId: string }).workspaceId
}

describe('server mode — one request costs what the caller has, not what the tenant has', () => {
  it.fails('resolves a bare segment reading a bounded number of registry rows', async () => {
    await adaOwnsDesign()
    registryRows.count = 0

    const res = await app.request(`${PUBLIC_URL}/api/workspaces/design/names`, { headers: ada })

    expect(res.status).toBe(200)
    // A few point lookups, each answering at most one row — never the
    // tenant's FOREIGN + 1.
    expect(registryRows.count).toBeLessThanOrEqual(6)
  })

  it.fails('lists workspaces with a bounded number of membership lookups', async () => {
    const own = await adaOwnsDesign()
    memberCalls.clear()

    const res = await app.request(`${PUBLIC_URL}/api/workspaces`, { headers: ada })

    expect(res.status).toBe(200)
    const { workspaces } = (await res.json()) as { workspaces: { workspaceId: string }[] }
    // The subject is present: the caller's one workspace, none of the strangers'.
    expect(workspaces.map((w) => w.workspaceId)).toEqual([own])
    expect(membershipLookups()).toBeLessThanOrEqual(4)
  })
})
