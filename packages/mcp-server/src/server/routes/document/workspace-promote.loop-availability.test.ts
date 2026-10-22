/**
 * What judging a promote's carried versions costs the loop that serves
 * every other request. Each distinct (point, document) is a projection, a
 * size judgement and a digest, all synchronous; within the budget a move
 * may still hold a few hundred of them, so the judging hands the loop back
 * between judgements rather than running them as one stall.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  MARKDOWN_BODY_KEY,
} from '@kamiazya/whiteboard-loro-adapter'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  loopTurnShare,
  measureLoopAvailability,
} from '../../../shared/test-utils/loop-availability.js'
import {
  resolveTestServerDeps,
  seedWorkspaceRow,
  testDocumentRouterOptions,
} from '../_test-helpers.js'

let tempDir: string
let serverDeps: ServerDeps
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('../document.js')
const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { _clearWorkspaceDocCacheForTests } = await import('../../store/document-store.js')
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'promote-loop-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await seedWorkspaceRow(tempDir, 'session1')
  serverDeps = await resolveTestServerDeps(tempDir)
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

const NOTE_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const BODY_CHARS = 16 * 1024
/** Distinct points, so each row is a judgement of its own. */
const POINTS = 300

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

/** A note of `BODY_CHARS`, then `POINTS` one-character edits, each saved as a version. */
function browserRecordWithManyVersions() {
  const doc = new LoroDoc()
  doc.setPeerId(2n)
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: NOTE_ID, kind: 'markdown' })
  const body = documentContainers(doc, NOTE_ID).getText(MARKDOWN_BODY_KEY)
  body.insert(0, 'a'.repeat(BODY_CHARS))
  doc.commit()
  const versions = []
  for (let i = 0; i < POINTS; i += 1) {
    body.insert(body.length, 'b')
    doc.commit()
    versions.push({
      id: `01BRWVERS${String(i).padStart(17, '0')}`,
      documentId: NOTE_ID,
      createdAt: 1_000 + i,
      auto: false,
      frontiers: b64u(encodeFrontiers(doc.oplogFrontiers())),
    })
  }
  return { snapshot: b64u(new Uint8Array(doc.export({ mode: 'snapshot' }))), versions }
}

it('hands the loop back between judgements of the carried versions', async () => {
  const app = createDocumentRouter(
    testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }),
  )
  const body = JSON.stringify(browserRecordWithManyVersions())
  const { result: res, availability } = await measureLoopAvailability(
    async () =>
      await app.request('/api/w/session1/workspace-document/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    { intervalMs: 5 },
  )
  expect(res.status).toBe(200)
  const kept = ((await res.json()) as { versionsKept: string[] }).versionsKept
  // Every row reached the judge, so the run measured the judging rather than a refusal.
  expect(kept).toHaveLength(POINTS)
  // Long enough, in sampler intervals, for a stall to be told from noise.
  expect(availability.elapsedMs).toBeGreaterThan(50)

  // Scale-free, for the reason loop-availability.ts gives: a bound in
  // milliseconds is partly a claim that the machine was quiet. Measured on
  // this fixture (300 judgements, ~1.1 s): a share of 0.34-0.36 and a worst
  // stall of 42-52 ms, 4% of the request, which is the record's import and
  // merge rather than the judging. With judging as one run it was ZERO
  // ticks and one 1,410 ms stall, the whole request.
  expect(loopTurnShare(availability)).toBeGreaterThan(0.05)
  expect(availability.worstStallMs).toBeLessThan(availability.elapsedMs * 0.25)
})
