/**
 * What a restore refuses before writing anything: a saved state the sync
 * surface would refuse written whole — past a limit, or with an envelope
 * naming another kind than the target records.
 */
import {
  createWorkspaceDocumentAtPath,
  writeDocumentKind,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { CANVAS_MAX_NODES } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { FakeLive, nodeIdsAt, run, spatialDoc, versionsWith } from '../test-utils/restore-fakes.js'
import { TextBreachRefusalError } from './sync-write-refusals.js'

// A version a promote carried was never a head any sync write judged.
describe('restoreVersion refuses a saved state past a sync limit', () => {
  const oversizedIds = Array.from({ length: CANVAS_MAX_NODES + 1 }, (_, i) => `n${i}`)

  it.each([
    ['in place', {}],
    ['into a new target', { targetPath: 'canvas-new' }],
    ['onto an existing target', { targetPath: 'canvas-b', overwrite: true }],
    ['as a subtree rollback', { subtree: true }],
  ] as const)('%s, writing nothing', async (_mode, input) => {
    const live = new FakeLive()
    const rootId = live.seed('canvas-a', spatialDoc(['n1']))
    live.seed('canvas-b', spatialDoc(['b1']))
    live.seed('canvas-a/later', spatialDoc(['l1']))
    const workspace = new LoroDoc()
    createWorkspaceDocumentAtPath(workspace, {
      path: 'canvas-a',
      documentId: rootId,
      kind: 'spatial',
    })
    writeWorkspaceDocumentContent(workspace, rootId, spatialDoc(oversizedIds))
    const versions = versionsWith({ v1: { doc: spatialDoc(oversizedIds), workspace } })

    const refused = await run(live, versions, input).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(TextBreachRefusalError)
    expect(refused).toMatchObject({ code: 'too_many_nodes_or_edges', status: 413 })
    const writes = live.calls.map((c) => c.method).filter((m) => m === 'save' || m === 'delete')
    expect(writes).toEqual([])
    expect(nodeIdsAt(live, 'canvas-a')).toEqual(['n1'])
    expect(nodeIdsAt(live, 'canvas-b')).toEqual(['b1'])
    expect(live.paths()).toEqual(['canvas-a', 'canvas-a/later', 'canvas-b'])
    expect(versions.saved).toEqual([])
  })
})

// A restore writes the version's envelope onto the live node, so a version
// whose envelope names another kind than the target records would write back
// the split the sync surface refuses (`document_kind_changed`).
describe('restoreVersion refuses a saved envelope naming another kind', () => {
  function markdownEnveloped(): LoroDoc {
    const doc = spatialDoc(['p1'])
    writeDocumentKind(doc, 'markdown')
    doc.commit()
    return doc
  }

  it.each([
    ['in place', {}],
    ['into a new target', { targetPath: 'canvas-new' }],
    ['onto an existing target', { targetPath: 'canvas-b', overwrite: true }],
    ['as a subtree rollback', { subtree: true }],
  ] as const)('%s, writing nothing', async (_mode, input) => {
    const live = new FakeLive()
    const rootId = live.seed('canvas-a', spatialDoc(['n1']))
    live.seed('canvas-b', spatialDoc(['b1']))
    const workspace = new LoroDoc()
    createWorkspaceDocumentAtPath(workspace, {
      path: 'canvas-a',
      documentId: rootId,
      kind: 'spatial',
    })
    writeWorkspaceDocumentContent(workspace, rootId, markdownEnveloped())
    const versions = versionsWith({ v1: { doc: markdownEnveloped(), workspace } })

    const refused = await run(live, versions, input).catch((err: unknown) => err)

    expect(refused).toMatchObject({ code: 'document_kind_changed', status: 400 })
    const writes = live.calls.map((c) => c.method).filter((m) => m === 'save' || m === 'delete')
    expect(writes).toEqual([])
    expect(nodeIdsAt(live, 'canvas-a')).toEqual(['n1'])
    expect(nodeIdsAt(live, 'canvas-b')).toEqual(['b1'])
    expect(versions.saved).toEqual([])
  })

  it('restores one whose envelope names the recorded kind', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    const past = spatialDoc(['p1'])
    writeDocumentKind(past, 'spatial')
    past.commit()

    await expect(run(live, versionsWith({ v1: { doc: past } }))).resolves.toEqual({
      kind: 'restored-in-place',
    })
    expect(nodeIdsAt(live, 'canvas-a')).toEqual(['p1'])
  })
})
