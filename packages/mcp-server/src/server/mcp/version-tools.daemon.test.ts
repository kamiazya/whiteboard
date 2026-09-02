import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import {
  createVersionListTool,
  createVersionRestoreTool,
  createVersionSaveTool,
  type ServerDeps,
} from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))
const tmp = withTempDataDir('whiteboard-version-tools-')
const { getDefaultServerDeps } = await import('../../di/default-server-deps.js')
const { clearCache } = await import('../store/doc-cache.js')
const { _clearWorkspaceDocCacheForTests } = await import('../store/document-store.js')
const { FileVersionStore } = await import('../store/version-store.js')

const WS = 'session1'

async function load(deps: ServerDeps, documentId: string): Promise<LoroDoc> {
  const snapshot = await deps.documentStore.loadSnapshot({
    docRef: { kind: 'document', workspaceId: WS, documentId },
  })
  const doc = new LoroDoc()
  if (snapshot !== null) doc.import(reassembleSnapshot(snapshot.manifest, snapshot.chunks))
  return doc
}

async function writeText(deps: ServerDeps, documentId: string, text: string): Promise<void> {
  const doc = await load(deps, documentId)
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text }],
    edges: [],
  })
  doc.commit()
  const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1_000_000)
  await deps.documentStore.saveSnapshot({
    docRef: { kind: 'document', workspaceId: WS, documentId },
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

async function textOf(deps: ServerDeps, documentId: string): Promise<string | undefined> {
  const node = readSpatialCanvas(await load(deps, documentId)).nodes[0]
  return node?.type === 'text' ? node.text : undefined
}

// The daemon keeps ONE version history — the file-backed store the History
// panel lists — and the MCP tools are its second surface. Both halves of
// that sentence are measured here against the real store rather than a
// fake, because the defect this replaces was invisible to every fake: the
// tools used to keep their own records inside the document, addressed by a
// frontier of the per-document PROJECTION, whose lineage is reborn each time
// the cache drops. Measured before the change: a restore in the same
// process worked, and the same restore after `clearCache()` threw
// `The given ID (1@…) is not contained by the doc` — so every agent
// checkpoint died with the daemon's next idle shutdown, and the History
// panel never showed it while it lived.
describe('wb_version_* tools over the daemon history', () => {
  it('a tool-saved version is listed by the daemon history and restores after the cache drops', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    const { documentId } = await deps.documentIndex.createDocument({
      workspaceId: WS,
      path: 'canvas-a',
      kind: 'spatial',
    })
    await writeText(deps, documentId, 'original')

    const saved = await createVersionSaveTool(deps).execute({
      workspaceId: WS,
      documentId,
      label: 'checkpoint',
    })

    // The History panel's own read sees what the agent saved.
    const panel = await new FileVersionStore().list(WS, 'canvas-a')
    expect(panel.map((v) => v.id)).toEqual([saved.version.id])
    expect(panel[0]?.label).toBe('checkpoint')
    // Recorded as the daemon acting as an agent, so the panel can say who.
    expect(panel[0]?.operator?.kind).toBe('ai')
    const listed = await createVersionListTool(deps).execute({ workspaceId: WS, documentId })
    expect(listed.versions.map((v) => v.id)).toEqual([saved.version.id])

    await writeText(deps, documentId, 'modified')
    expect(await textOf(deps, documentId)).toBe('modified')

    // Simulate the daemon restarting between the checkpoint and the rollback.
    clearCache()
    _clearWorkspaceDocCacheForTests()
    const reborn = await getDefaultServerDeps()
    const restored = await createVersionRestoreTool(reborn).execute({
      workspaceId: WS,
      documentId,
      versionId: saved.version.id,
    })
    expect(restored).toMatchObject({ documentId, restoredVersionId: saved.version.id })
    expect(await textOf(reborn, documentId)).toBe('original')
  })
})
