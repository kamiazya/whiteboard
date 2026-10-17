/**
 * Server mode reads only so many content-sized request bodies at once, per
 * user and per instance, and refuses the next one before reading any of it.
 * Driven through server mode's whole `/api`, so the slot is shown to be taken
 * after the caller is known and before the route's body ceiling reads.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bearerNamesItsSubject,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
} from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { CONTENT_REQUEST_CAPS } from './content-slots.js'
import { resolveTestServerDeps, testDataLayout } from './routes/_test-helpers.js'
import type { MemberProfileStore } from './security/member-profile-store.js'
import { SESSION_COOKIE, type SignInSessionStore } from './security/sign-in-session-store.js'
import { createIsolatedDb } from './store/db/test-helpers.js'

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
let sessions: SignInSessionStore
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-content-slots-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const stores = serverModePeople(handle.db, tempDir)
  members = stores.members
  sessions = stores.sessions
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps: await resolveTestServerDeps(tempDir),
    dataLayout: testDataLayout(),
    people: stores.people,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  app = createApp(options)
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** A person signed in at this host just now, holding a workspace of their own. */
async function signedInWithWorkspace(subject: string) {
  const binding = { authenticator: ISSUER, subject }
  await members.ensureProfile({ binding, displayName: subject })
  const token = await sessions.create(binding, Date.now(), 60_000, Date.now())
  const headers = { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL }
  const created = await app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: subject }),
  })
  expect(created.status).toBe(201)
  const { workspaceId } = (await created.json()) as { workspaceId: string }
  return { headers, workspaceId }
}

const EMPTY_UPDATE = new LoroDoc().export({ mode: 'update' })

/**
 * A workspace-document update whose body is withheld until `release`, sent
 * chunked so the route's ceiling has to read it. `read` says whether anything
 * asked for its bytes: a stream with no buffer is pulled only when read.
 */
function heldUpdate(caller: { headers: Record<string, string>; workspaceId: string }) {
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let read = false
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        read = true
        await released
        controller.enqueue(EMPTY_UPDATE)
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const response = Promise.resolve(
    app.request(`${PUBLIC_URL}/api/w/${caller.workspaceId}/workspace-document/update`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/octet-stream' },
      body,
      duplex: 'half',
    } as RequestInit),
  )
  return { response, release, wasRead: () => read }
}

/**
 * The answer to a held update that must be refused without being read:
 * waits for whichever comes first, the answer or a read of its body, so a
 * request let through fails at once rather than hanging on its withheld body.
 */
async function refusedUnread(update: ReturnType<typeof heldUpdate>): Promise<Response> {
  let answered = false
  void update.response.then(() => {
    answered = true
  })
  await vi.waitFor(() => expect(answered || update.wasRead()).toBe(true))
  expect(update.wasRead()).toBe(false)
  return update.response
}

/** `count` held updates from `caller`, each past the slot and reading its body. */
async function holding(
  caller: { headers: Record<string, string>; workspaceId: string },
  count: number,
) {
  const held = Array.from({ length: count }, () => heldUpdate(caller))
  await vi.waitFor(() => expect(held.every((each) => each.wasRead())).toBe(true))
  return held
}

describe('server mode — content-sized bodies in flight', () => {
  it('refuses a user past the per-user cap before reading the body, and frees the slot after', async () => {
    const ada = await signedInWithWorkspace('ada')
    const held = await holding(ada, CONTENT_REQUEST_CAPS.perUser)

    const refused = await refusedUnread(heldUpdate(ada))
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toMatch(/^[1-9]\d*$/)
    expect(await refused.json()).toMatchObject({ error: 'too_many_requests' })

    for (const each of held) each.release()
    for (const each of held) expect((await each.response).status).toBe(200)

    const after = heldUpdate(ada)
    after.release()
    expect((await after.response).status).toBe(200)
  })

  it('refuses everyone once the instance holds its cap, whoever holds it', async () => {
    const users = Math.ceil(CONTENT_REQUEST_CAPS.total / CONTENT_REQUEST_CAPS.perUser)
    const callers = await Promise.all(
      Array.from({ length: users }, (_, i) => signedInWithWorkspace(`u${i}`)),
    )
    const held = (
      await Promise.all(
        callers.map((caller, i) =>
          holding(
            caller,
            Math.min(
              CONTENT_REQUEST_CAPS.perUser,
              CONTENT_REQUEST_CAPS.total - i * CONTENT_REQUEST_CAPS.perUser,
            ),
          ),
        ),
      )
    ).flat()
    expect(held).toHaveLength(CONTENT_REQUEST_CAPS.total)

    const bystander = await signedInWithWorkspace('bystander')
    expect((await refusedUnread(heldUpdate(bystander))).status).toBe(429)

    for (const each of held) each.release()
    for (const each of held) expect((await each.response).status).toBe(200)
  })
})

const PING = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))

/**
 * A JSON-RPC POST to `/mcp` from `subject`'s bearer, its body withheld until
 * `release` — or failed by `drop`, which is what a client that went away
 * looks like to the reader. `read` says whether anything asked for its bytes.
 */
function heldMcpCall(subject: string) {
  let settle: (outcome: 'send' | 'drop') => void = () => {}
  const settled = new Promise<'send' | 'drop'>((resolve) => {
    settle = resolve
  })
  let read = false
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        read = true
        if ((await settled) === 'drop') {
          controller.error(new Error('the client went away'))
          return
        }
        controller.enqueue(PING)
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const response = Promise.resolve(
    app.request(`${PUBLIC_URL}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${subject}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
      duplex: 'half',
    } as RequestInit),
  )
  return {
    response,
    release: () => settle('send'),
    drop: () => settle('drop'),
    wasRead: () => read,
  }
}

describe('server mode — /mcp bodies in flight', () => {
  it('refuses a user past the per-user cap before reading the body, and frees a dropped slot', async () => {
    await members.ensureProfile({
      binding: { authenticator: ISSUER, subject: 'ada' },
      displayName: 'ada',
    })
    const held = Array.from({ length: CONTENT_REQUEST_CAPS.perUser }, () => heldMcpCall('ada'))
    await vi.waitFor(() => expect(held.every((each) => each.wasRead())).toBe(true))

    const refused = await refusedUnread(heldMcpCall('ada'))
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toMatch(/^[1-9]\d*$/)
    expect(await refused.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
      id: null,
    })

    const [dropped, ...rest] = held
    dropped?.drop()
    await dropped?.response.catch(() => undefined)
    const after = heldMcpCall('ada')
    await vi.waitFor(() => expect(after.wasRead()).toBe(true))

    for (const each of [...rest, after]) each.release()
    for (const each of [...rest, after]) expect((await each.response).status).toBe(200)
  })
})
