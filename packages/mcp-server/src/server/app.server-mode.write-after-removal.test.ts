/**
 * Membership is judged when a request arrives, and a write's body is read
 * after that. A person removed while their body is still arriving must not
 * have the write land: the write itself checks again, in the workspace's
 * write lock, right before it changes anything. Driven through server mode's
 * whole `/api`, since the check spans the gate and the operation's lock.
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
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-write-after-removal-'))
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

async function signedIn(subject: string) {
  const binding = { authenticator: ISSUER, subject }
  const user = await members.ensureProfile({ binding, displayName: subject })
  const token = await sessions.create(binding, Date.now(), 60_000, Date.now())
  return { userId: user.id, headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL } }
}

/** ada owns a workspace and bob is a member of it. */
async function sharedWorkspace() {
  const ada = await signedIn('ada')
  const bob = await signedIn('bob')
  const created = await app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...ada.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'shared' }),
  })
  expect(created.status).toBe(201)
  const { workspaceId } = (await created.json()) as { workspaceId: string }
  await members.addMember(workspaceId, bob.userId)
  return { ada, bob, workspaceId }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

function probeUpdate(): Uint8Array {
  const edit = new LoroDoc()
  edit.getMap('probe').set('written', true)
  return edit.export({ mode: 'update' })
}

interface Write {
  readonly method: 'POST' | 'PUT'
  readonly path: string
  readonly contentType: string
  readonly bytes: () => Uint8Array
  /** Whether what the write carries is now stored, read as the owner. */
  readonly landed: (headers: Record<string, string>, workspaceId: string) => Promise<boolean>
}

const get = (headers: Record<string, string>, url: string) =>
  app.request(`${PUBLIC_URL}${url}`, { headers })

// Each route that takes a stored-content body: the record, a document, a file.
const WRITES: Record<string, Write> = {
  'workspace-document update': {
    method: 'POST',
    path: 'workspace-document/update',
    contentType: 'application/octet-stream',
    bytes: probeUpdate,
    async landed(headers, workspaceId) {
      const res = await get(headers, `/api/w/${workspaceId}/workspace-document/snapshot`)
      expect(res.status).toBe(200)
      const doc = new LoroDoc()
      doc.import(new Uint8Array(await res.arrayBuffer()))
      return doc.getMap('probe').get('written') === true
    },
  },
  'document update': {
    method: 'POST',
    path: 'document/board/update',
    contentType: 'application/octet-stream',
    bytes: probeUpdate,
    async landed(headers, workspaceId) {
      const res = await get(headers, `/api/w/${workspaceId}/document/board/snapshot`)
      if (res.status === 404) return false
      expect(res.status).toBe(200)
      const doc = new LoroDoc()
      doc.import(new Uint8Array(await res.arrayBuffer()))
      return doc.getMap('probe').get('written') === true
    },
  },
  'file upload': {
    method: 'PUT',
    path: 'document/board/file/probe-file',
    contentType: 'image/png',
    bytes: () => PNG,
    async landed(headers, workspaceId) {
      const res = await get(headers, `/api/w/${workspaceId}/document/board/file/probe-file`)
      if (res.status === 404) return false
      expect(res.status).toBe(200)
      return true
    },
  },
}

/** `write` from `headers`, its body withheld until `release`. */
function held(write: Write, headers: Record<string, string>, workspaceId: string) {
  const bytes = write.bytes()
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
        controller.enqueue(bytes)
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const response = Promise.resolve(
    app.request(`${PUBLIC_URL}/api/w/${workspaceId}/${write.path}`, {
      method: write.method,
      headers: { ...headers, 'content-type': write.contentType },
      body,
      duplex: 'half',
    } as RequestInit),
  )
  return { response, release, wasRead: () => read }
}

function people() {
  return serverModePeople(handle.db, tempDir).people
}

describe.each(Object.entries(WRITES))('server mode — a %s outliving its membership', (_, write) => {
  it('lands for a member who is still one when the body arrives', async () => {
    const { ada, bob, workspaceId } = await sharedWorkspace()
    expect(await write.landed(ada.headers, workspaceId)).toBe(false)
    const request = held(write, bob.headers, workspaceId)
    await vi.waitFor(() => expect(request.wasRead()).toBe(true))
    request.release()
    expect((await request.response).status).toBeLessThan(300)
    expect(await write.landed(ada.headers, workspaceId)).toBe(true)
  })

  it('is refused for a member removed while the body was arriving', async () => {
    const { ada, bob, workspaceId } = await sharedWorkspace()
    const request = held(write, bob.headers, workspaceId)
    await vi.waitFor(() => expect(request.wasRead()).toBe(true))

    expect(await people().roles.remove(workspaceId, bob.userId)).toBe('ok')
    request.release()

    const res = await request.response
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'not_a_member' })
    expect(await write.landed(ada.headers, workspaceId)).toBe(false)
  })
})

describe('server mode — a write outliving its author’s deactivation', () => {
  it('is refused for a member deactivated while the body was arriving', async () => {
    const write = WRITES['workspace-document update'] as Write
    const { ada, bob, workspaceId } = await sharedWorkspace()
    const request = held(write, bob.headers, workspaceId)
    await vi.waitFor(() => expect(request.wasRead()).toBe(true))

    await people().administration.deactivation.deactivate(bob.userId, Date.now())
    request.release()

    expect((await request.response).status).toBe(403)
    expect(await write.landed(ada.headers, workspaceId)).toBe(false)
  })
})
