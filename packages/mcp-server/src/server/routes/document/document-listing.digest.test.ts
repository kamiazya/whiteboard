/**
 * Every document the daemon lists carries a content digest, whatever its
 * kind and whether or not a reader can still serve its content. The facts
 * cache validates on that digest and falls back to the keeper's own version
 * only for an entry without one, so while this holds the fallback is never
 * asked.
 */
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  resolveTestServerDeps,
  withTempDataDir,
  writeDocumentUpdate,
} from '../_test-helpers.js'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const tmp = withTempDataDir('whiteboard-listing-digest-')
const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: WS })
})

it('lists a digest for a canvas, a note and a document holding a retired shape', async () => {
  await createTestDocument(serverDeps, { workspaceId: WS, path: 'board', kind: 'spatial' })
  await createTestDocument(serverDeps, { workspaceId: WS, path: 'note', kind: 'markdown' })
  await createTestDocument(serverDeps, { workspaceId: WS, path: 'old', kind: 'spatial' })
  const retired = new LoroDoc()
  const from = retired.version()
  retired.getMap('nodes').set('old', { id: 'old', 'x-whiteboard': { a: 1 } })
  retired.commit()
  await writeDocumentUpdate(serverDeps, WS, 'old', retired.export({ mode: 'update', from }))

  const entries = await serverDeps.documentIndex.listDocuments({ workspaceId: WS })
  expect(entries.map((entry) => entry.path).sort()).toEqual(['board', 'note', 'old'])
  for (const entry of entries) {
    expect(typeof entry.contentDigest, entry.path).toBe('string')
  }
})
