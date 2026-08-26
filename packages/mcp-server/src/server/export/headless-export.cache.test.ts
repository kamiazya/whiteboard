// The export path reads documents through a `(workspaceId, path)`-keyed LRU
// of live LoroDoc instances. The MCP tool surface writes them by documentId,
// with a fresh LoroDoc per call, and nothing on that path touches the cache —
// so an export can serve bytes from before an agent's edit.
//
// It fails in the worst available shape: both loaders answer "nothing found"
// with an EMPTY document rather than an error, so a stale or missed read is
// indistinguishable from a canvas that really is empty. The route returns 200
// and a file path for a picture of nothing.
//
// Deliberately not mocking the store. The existing `headless-export.test.ts`
// calls `clearCache()` in beforeEach AND afterEach, which designs this defect
// out of every case in the file; this one exists to keep the cache in play.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { exportCanvasHeadlessSvg } = await import('./headless-export.js')
const { saveDocument, getDoc } = await import('../store/document-store.js')
const { clearCache } = await import('../store/doc-cache.js')
const { getDb } = await import('../store/db/index.js')
const { LibsqlDocumentStore } = await import('../store/libsql/libsql-document-store.js')
const { resolveDocumentIdAtPath } = await import('../store/document-store.js')

const WORKSPACE = 'ws_cache'
const PATH = 'design'

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-export-cache-test-'))
  clearCache()
})

afterEach(async () => {
  clearCache()
  await rm(tempDir, { recursive: true, force: true })
})

function textDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  doc
    .getMap('nodes')
    .set('n1', { id: 'n1', type: 'text', x: 0, y: 0, width: 300, height: 80, text })
  doc.commit()
  return doc
}

/**
 * The MCP tool surface's write, reproduced exactly: resolve the documentId,
 * build a FRESH LoroDoc, and save it against `document:<id>` through the
 * store the composition root actually injects — WorkspaceRoutedDocumentStore,
 * which merges the write into the live cached projection and the workspace
 * record. That freshness is the whole point — a caller mutating the cached
 * instance in place leaves the cache correct by identity, and every tool
 * call does the opposite.
 */
async function writeThroughToolPath(text: string): Promise<void> {
  const db = await getDb(tempDir)
  const documentId = await resolveDocumentIdAtPath(WORKSPACE, PATH)
  if (documentId === undefined || documentId === null) throw new Error('no documentId for path')
  const doc = textDoc(text)
  const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1024 * 1024)
  const { WorkspaceRoutedDocumentStore } = await import('../store/workspace-plane.js')
  await new WorkspaceRoutedDocumentStore(new LibsqlDocumentStore(db)).saveSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE, documentId },
    manifest,
    chunks,
    // The tools' own value (`document-io.ts`). It is what tells a reader the
    // stored bytes are ahead of anything it is holding.
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

describe('an export after an agent edit', () => {
  it('renders what the tool wrote, not what was cached before it', async () => {
    await saveDocument(WORKSPACE, PATH, new LoroDoc())

    // Stands in for anything that opens the document BY PATH between the
    // create and the edit — a browser tab's WS connect, a snapshot GET, a
    // version read. Each populates this cache; none is unusual.
    await getDoc(WORKSPACE, PATH)

    await writeThroughToolPath('日本語のテキスト')

    const { svg } = await exportCanvasHeadlessSvg({ workspaceId: WORKSPACE, path: PATH })

    expect(svg).toContain('日本語のテキスト')
  })

  // Two writers, neither a prefix of the other: an open editor holding the
  // cached document while an agent writes the same one. The frontier
  // comparison answers `undefined` here rather than "behind", and treating
  // that as up-to-date would drop the agent's node while looking correct —
  // the editor's own edit is still there, so the export is not obviously
  // wrong.
  it('merges a diverged history instead of preferring the copy it holds', async () => {
    await saveDocument(WORKSPACE, PATH, new LoroDoc())
    const cached = await getDoc(WORKSPACE, PATH)
    cached.getMap('nodes').set('editor', {
      id: 'editor',
      type: 'text',
      x: 0,
      y: 200,
      width: 300,
      height: 80,
      text: 'from the editor',
    })
    cached.commit()

    await writeThroughToolPath('from the agent')

    const { svg } = await exportCanvasHeadlessSvg({ workspaceId: WORKSPACE, path: PATH })

    expect(svg).toContain('from the editor')
    expect(svg).toContain('from the agent')
  })

  it('is not merely a smaller picture — the empty case is a valid-looking export', async () => {
    await saveDocument(WORKSPACE, PATH, new LoroDoc())
    await getDoc(WORKSPACE, PATH)
    await writeThroughToolPath('hello')

    const { svg } = await exportCanvasHeadlessSvg({ workspaceId: WORKSPACE, path: PATH })

    // The observed failure was `<svg width="21" height="21" …><rect/></svg>`:
    // a well-formed 200 that a caller cannot tell from an empty canvas. Pin
    // the dimension so a regression cannot hide behind "the text assertion is
    // just about fonts".
    expect(svg).not.toMatch(/width="21" height="21"/)
  })
})
