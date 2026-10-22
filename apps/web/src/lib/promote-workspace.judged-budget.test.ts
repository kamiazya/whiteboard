// @vitest-environment node
/**
 * A move whose saved versions cost the daemon more to check than one move
 * allows: the daemon refuses with its budget, and the browser re-sends once
 * with the newest versions that fit, says how many stayed behind, and keeps
 * its copy.
 *
 * Node rather than jsdom for the IndexedDB reads, for the reason
 * promote-workspace.carried.test.ts gives.
 */
import 'fake-indexeddb/auto'
import type { PromoteWorkspaceRequest } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { MARKDOWN_BODY_KEY } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { promoteWorkspace } from './promote-workspace.js'

claimIsolatedWhiteboardDb('promote-workspace-judged-budget-node')

const BASE = 'http://127.0.0.1:3099'

/**
 * A daemon that refuses the first move's versions past `limit` and takes the
 * next, confirming every version it was sent.
 */
function budgetedDaemon(limit: number) {
  const promotes: PromoteWorkspaceRequest[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/workspace-document/promote') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as PromoteWorkspaceRequest
      promotes.push(body)
      if (promotes.length === 1) {
        return Response.json(
          { error: 'promote_too_many_carried', message: 'over the budget', limit },
          { status: 413 },
        )
      }
      return Response.json({
        ok: true,
        recorded: [],
        shadowed: [],
        trashStored: [],
        versionsKept: (body.versions ?? []).map((each) => each.id),
      })
    }
    if (url.endsWith('/documents')) return jsonResponse({ documents: [] })
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
  return { fetch, promotes }
}

function noteBody(text: string): Uint8Array {
  const content = new LoroDoc()
  content.getText(MARKDOWN_BODY_KEY).insert(0, text)
  content.commit()
  return new Uint8Array(content.export({ mode: 'snapshot' }))
}

/** A note saved three times, oldest first: a long body, then two short ones. */
async function noteWithThreeVersions(): Promise<string[]> {
  const index = new FoldingBrowserIndex()
  await ensureBrowserWorkspace(index)
  const workspaceId = getBrowserWorkspaceId()
  const docs = new BrowserWorkspaceDocs()
  const note = await index.createDocument({ workspaceId, path: 'note', kind: 'markdown' })
  const store = new BrowserVersionStore({ docs, index })
  const ids: string[] = []
  const now = vi.spyOn(Date, 'now')
  for (const [at, body] of [
    [1_000, 'a'.repeat(5_000)],
    [2_000, 'b'.repeat(20)],
    [3_000, 'c'.repeat(20)],
  ] as const) {
    expect(await seedWorkspaceDocumentContent(note.documentId, noteBody(body))).toBe(true)
    now.mockReturnValue(at)
    ids.push((await store.save(workspaceId, 'note', { label: `at ${at}` })).id)
  }
  now.mockRestore()
  return ids
}

const promote = (fetch: typeof globalThis.fetch) =>
  promoteWorkspace({
    fetch,
    keeperBaseUrl: BASE,
    workspaceId: 'ws-a',
    workspaceDocs: new BrowserWorkspaceDocs(),
  })

describe('promoteWorkspace past the daemon budget for checking saved versions', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('re-sends once with the newest versions that fit, and counts the rest as left behind', async () => {
    const [oldest, middle, newest] = await noteWithThreeVersions()
    // Room for the two short bodies, not for the long one.
    const daemon = budgetedDaemon(1_000)

    const result = await promote(daemon.fetch)

    expect(daemon.promotes).toHaveLength(2)
    expect(daemon.promotes[0]?.versions?.map((each) => each.id).sort()).toEqual(
      [oldest, middle, newest].sort(),
    )
    expect(daemon.promotes[1]?.versions?.map((each) => each.id).sort()).toEqual(
      [middle, newest].sort(),
    )
    if (result.kind !== 'ok') throw new Error(`expected the move to land, got ${result.reason}`)
    expect(result.versionsLeftBehind).toBe(1)
    // Named, so the browser copy that still holds it is kept and the person is told.
    expect(result.leftBehind).toEqual([
      '1 older saved version: checking more would take the daemon longer than one move allows',
    ])
  })

  it('leaves every version behind when not even the newest fits', async () => {
    await noteWithThreeVersions()
    const daemon = budgetedDaemon(1)

    const result = await promote(daemon.fetch)

    expect(daemon.promotes).toHaveLength(2)
    expect(daemon.promotes[1]?.versions).toBeUndefined()
    if (result.kind !== 'ok') throw new Error(`expected the move to land, got ${result.reason}`)
    expect(result.versionsLeftBehind).toBe(3)
  })

  it('re-sends at most once, reporting a second refusal as the failure', async () => {
    await noteWithThreeVersions()
    let posts = 0
    const alwaysRefusing = (async () => {
      posts += 1
      return Response.json(
        { error: 'promote_too_many_carried', message: 'over the budget', limit: 1_000 },
        { status: 413 },
      )
    }) as typeof globalThis.fetch

    expect(await promote(alwaysRefusing)).toEqual({ kind: 'failed', reason: 'over the budget' })
    expect(posts).toBe(2)
  })

  it('reports a count refusal carrying no budget without re-sending', async () => {
    await noteWithThreeVersions()
    let posts = 0
    const countRefusing = (async () => {
      posts += 1
      return Response.json(
        { error: 'promote_too_many_carried', message: 'one move carries at most 2' },
        { status: 413 },
      )
    }) as typeof globalThis.fetch

    expect(await promote(countRefusing)).toEqual({
      kind: 'failed',
      reason: 'one move carries at most 2',
    })
    expect(posts).toBe(1)
  })
})
