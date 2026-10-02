/**
 * The membership gate of the SSE transport against the router, with a stub
 * decision. The workspace id travels in the request body, so the router is the
 * only place the check can live; these cases pin what the gate does with it
 * rather than who a real keeper admits.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import type { WorkspaceAdmit } from '../security/membership-gate.js'
import type { WorkspaceAccessDecision } from '../security/workspace-access.js'
import { resetSyncStreamsForTests } from '../sync-streams.js'
import { createSyncSseRouter } from './sync-sse.js'

// Its own data dir: resolving a workspace handle opens the store, and one
// shared with a file running in parallel waits on that file's lock.
setDataDirForTests(mkdtempSync(join(tmpdir(), 'wb-sse-admit-')))
afterAll(() => resetDataDirForTests())
afterEach(() => resetSyncStreamsForTests())

const SETTLE = 10_000

/** A router whose gate answers from `decisions` and records every workspace it was asked about. */
function routerDeciding(decisions: Record<string, WorkspaceAccessDecision>) {
  const asked: string[] = []
  const admit: WorkspaceAdmit = async (_c, workspaceId) => {
    asked.push(workspaceId)
    return decisions[workspaceId] ?? 'admitted'
  }
  const app = createSyncSseRouter({
    workspaceDocuments: { onUpdated: () => () => {} },
    admit,
  })
  const post = (route: 'subscribe' | 'message', body: unknown) =>
    app.request(`/api/sync/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { asked, post }
}

describe('the sync route refuses a request the gate refuses', () => {
  it(
    'refuses a subscribe naming a workspace the caller may not enter, before any stream lookup',
    async () => {
      const { post } = routerDeciding({ 'ws-closed': 'not_a_member' })

      // The stream does not exist: a refused caller must learn nothing of that.
      const res = await post('subscribe', {
        streamId: 'no-such-stream',
        subscribe: ['workspace:ws-closed'],
      })

      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'not_a_member' })
    },
    SETTLE,
  )

  it(
    'refuses a client_ready for a document of a workspace the caller may not enter',
    async () => {
      const { post } = routerDeciding({ 'ws-closed': 'requires_person_session' })

      const res = await post('message', {
        streamId: 'no-such-stream',
        doc: 'ws-closed/plan',
        message: { type: 'client_ready' },
      })

      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'requires_person_session' })
    },
    SETTLE,
  )

  it(
    'answers with the first refusal, and decides each workspace once',
    async () => {
      const { asked, post } = routerDeciding({
        'ws-first': 'not_a_member',
        'ws-second': 'requires_person_session',
      })

      const res = await post('subscribe', {
        streamId: 'no-such-stream',
        subscribe: ['ws-open/a', 'ws-open/b', 'ws-first/c', 'ws-second/d'],
      })

      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'not_a_member' })
      // `ws-open` decided once for both of its keys; nothing past the refusal asked.
      expect(asked).toEqual(['ws-open', 'ws-first'])
    },
    SETTLE,
  )

  it(
    'lets a request through when every workspace it names is admitted',
    async () => {
      const { post } = routerDeciding({})

      const res = await post('subscribe', {
        streamId: 'no-such-stream',
        subscribe: ['ws-open/a'],
      })

      // Past the gate, so the answer is the stream lookup's.
      expect(res.status).toBe(404)
    },
    SETTLE,
  )
})
