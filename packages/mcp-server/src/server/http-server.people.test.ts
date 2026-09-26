import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunningServer } from './http-server.js'

// Its own data dir, not the project's shared one: this file WRITES rows, and
// a second process writing that one file at the same moment is SQLITE_BUSY.
let tempDir: string

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

const { findAvailablePort } = await import('../cli/daemon-run.js')
const { startHttpServer } = await import('./http-server.js')
const { clearWorkspaceIdCache } = await import('./current-workspace.js')
const { createMemberProfileStore } = await import('./security/member-profile-store.js')
const { closeDb, getDb } = await import('./store/db/index.js')

// A fresh port per acquisition, for the keep-alive reason http-server.test.ts
// gives: a repeat that re-binds a port hands fetch a socket already closed.
let nextPortBase = 5500
async function acquirePort(): Promise<number> {
  const port = await findAvailablePort(nextPortBase)
  nextPortBase = port + 1
  return port
}

// Wiring this covers: startHttpServer must build the daemon's own
// MemberProfileStore from the post-migration db handle and pass it, together
// with the pairing stores and serverDeps, into createApp — every one of
// those three is required before the membership router mounts at all, and
// the machine-owned roles store before the people router does. A unit test
// on createApp alone cannot see a composition-root wiring gap.
describe('startHttpServer membership route wiring (ADR-0041 S0-4, ADR-0049 decision 5)', () => {
  let running: RunningServer | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-http-people-'))
    clearWorkspaceIdCache()
  })

  afterEach(async () => {
    await running?.close()
    running = undefined
    await closeDb(tempDir)
    clearWorkspaceIdCache()
    await rm(tempDir, { recursive: true, force: true })
  })

  // A JSON answer, not Hono's plain-text 404, is what proves each router is
  // mounted on the real composition, with its stores threaded through.
  it('serves the shared people API, the machine owner managing it', async () => {
    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1' })

    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/any-workspace/people`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ people: [], canManage: true })
  })

  // The machine owns every workspace, so its last recorded owner may go —
  // the rule a server keeper enforces would otherwise leave a person's only
  // way out of ownership blocked by nobody else.
  it('lets the machine owner demote the only recorded owner', async () => {
    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1' })
    const members = createMemberProfileStore(await getDb())
    const ada = await members.ensureProfile({
      binding: { authenticator: 'oidc:https://idp.test', subject: randomUUID() },
      displayName: 'Ada',
    })
    const people = `http://127.0.0.1:${port}/api/workspaces/ws-${randomUUID()}/people`
    const send = (method: string, path: string, body: object) =>
      fetch(`${people}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    expect((await send('POST', '', { userId: ada.id })).status).toBe(201)
    expect((await send('PATCH', `/${ada.id}`, { role: 'owner' })).status).toBe(200)
    expect((await send('PATCH', `/${ada.id}`, { role: 'member' })).status).toBe(200)
  })

  it('adds a passkey member through its own route, refusing an unregistered workspace', async () => {
    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1' })

    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/any-workspace/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: 'c', origin: 'https://a.example', displayName: 'Ada' }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: 'unknown_workspace',
      message: 'no such workspace: any-workspace',
    })
  })
})
