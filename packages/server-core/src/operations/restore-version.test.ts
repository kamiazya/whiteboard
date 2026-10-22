import {
  createWorkspaceDocumentAtPath,
  readSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { RestoreProgressEvent } from '../server-deps.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  expectAllCallsLocked,
  FakeLive,
  nodeIdsAt,
  run,
  spatialDoc,
  versionsWith,
  WS,
} from '../test-utils/restore-fakes.js'
import { restoreVersion } from './restore-version.js'

describe('restoreVersion result union', () => {
  it('answers not-found for a version id history does not hold', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    const result = await run(live, versionsWith({}))
    expect(result).toEqual({ kind: 'not-found' })
    expectAllCallsLocked(live)
  })

  it("answers not-found for a version that belongs to ANOTHER document's history, and writes nothing", async () => {
    // A version id is unique per workspace, so `load` alone would happily
    // answer another document's past state — and the reconcile would then
    // overwrite this document with unrelated content. The history the
    // caller named (`path`) has to hold the id.
    const live = new FakeLive()
    const liveDoc = spatialDoc(['mine'])
    live.seed('canvas-a', liveDoc)
    const before = liveDoc.oplogVersion()
    const result = await run(
      live,
      versionsWith({ v1: { doc: spatialDoc(['theirs']), path: 'canvas-b' } }),
    )
    expect(result).toEqual({ kind: 'not-found' })
    expect(liveDoc.oplogVersion().compare(before)).toBe(0)
    expect(live.calls.map((c) => c.method)).not.toContain('save')
  })

  it('refuses a version of another document even when this document has versions of its own', async () => {
    // With an empty history any "take the first row" lookup also answers
    // undefined, so the ownership test above cannot tell it from a lookup by
    // id. Here the path's history is non-empty and its first row is not the
    // one asked for.
    const live = new FakeLive()
    const liveDoc = spatialDoc(['mine'])
    live.seed('canvas-a', liveDoc)
    const before = liveDoc.oplogVersion()
    const result = await run(
      live,
      versionsWith({
        v0: { doc: spatialDoc(['mine-old']), path: 'canvas-a' },
        v1: { doc: spatialDoc(['theirs']), path: 'canvas-b' },
      }),
      { versionId: 'v1' },
    )
    expect(result).toEqual({ kind: 'not-found' })
    expect(liveDoc.oplogVersion().compare(before)).toBe(0)
    expect(live.calls.map((c) => c.method)).not.toContain('save')
  })

  it('answers output-exists for an existing target without overwrite, and writes nothing', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    live.seed('canvas-b', spatialDoc(['other']))
    const result = await run(live, versionsWith({ v1: { doc: spatialDoc(['n1', 'n2']) } }), {
      targetPath: 'canvas-b',
    })
    expect(result).toEqual({ kind: 'output-exists', targetPath: 'canvas-b' })
    expect(live.calls.map((c) => c.method)).not.toContain('save')
    expectAllCallsLocked(live)
  })

  it('answers invalid-target-path for a malformed targetPath, before touching the target', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    const result = await run(live, versionsWith({ v1: { doc: spatialDoc(['n1']) } }), {
      targetPath: 'bad path/..',
    })
    expect(result).toEqual({ kind: 'invalid-target-path' })
    expect(live.calls.map((c) => c.method)).not.toContain('save')
  })

  it('answers subtree-needs-workspace-version when the version is not workspace-scoped', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    const result = await run(live, versionsWith({ v1: { doc: spatialDoc(['n1']) } }), {
      subtree: true,
    })
    expect(result).toEqual({ kind: 'subtree-needs-workspace-version' })
    expectAllCallsLocked(live)
  })

  it('refuses subtree combined with a distinct targetPath', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    const result = await run(live, versionsWith({ v1: { doc: spatialDoc(['n1']) } }), {
      subtree: true,
      targetPath: 'canvas-b',
    })
    expect(result).toEqual({ kind: 'subtree-takes-no-target' })
    expect(live.calls.map((c) => c.method)).not.toContain('save')
  })
})

describe('restoreVersion in-place mode', () => {
  it('reconciles the live doc, saves with overwrite, and reports restored-in-place', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1', 'gone']))
    const result = await run(live, versionsWith({ v1: { doc: spatialDoc(['n1', 'n2']) } }))
    expect(result).toEqual({ kind: 'restored-in-place' })
    expect(live.calls.map((c) => c.method)).toContain('save')
    expectAllCallsLocked(live)
  })

  it('evicts the live doc when save fails, and the failure propagates', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    live.failNextSave = new Error('disk full')
    await expect(run(live, versionsWith({ v1: { doc: spatialDoc(['n2']) } }))).rejects.toThrow(
      'disk full',
    )
    expect(live.evicted).toEqual(['canvas-a'])
  })

  it('evicts the live doc when reconcile itself fails', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    // Not a LoroDoc at all: reconcileDocContent throws before any save runs.
    const poisoned = versionsWith({ v1: { doc: {} as LoroDoc } })
    await expect(run(live, poisoned)).rejects.toThrow()
    expect(live.evicted).toEqual(['canvas-a'])
    expect(live.calls.map((c) => c.method)).not.toContain('save')
  })

  it('brackets progress: complete fires even when the body throws', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    live.failNextSave = new Error('disk full')
    const events: RestoreProgressEvent[] = []
    await expect(
      run(
        live,
        versionsWith({ v1: { doc: spatialDoc(['n2']), label: 'before-cleanup' } }),
        {},
        (e) => events.push(e),
      ),
    ).rejects.toThrow('disk full')
    expect(events).toEqual([
      { workspaceId: WS, path: 'canvas-a', phase: 'started', label: 'before-cleanup' },
      { workspaceId: WS, path: 'canvas-a', phase: 'complete' },
    ])
  })
})

describe('restoreVersion restore-to-target mode', () => {
  it('creates a brand-new target stamped with the SOURCE kind, evicts the target cache slot, and reports the past element count', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']), 'markdown')
    const past = spatialDoc(['n1', 'n2', 'n3'])
    const result = await run(live, versionsWith({ v1: { doc: past } }), {
      targetPath: 'canvas-new',
    })
    expect(result).toEqual({
      kind: 'restored-to-target',
      targetPath: 'canvas-new',
      documentId: live.stored('canvas-new')?.id,
      elementCount: 3,
    })
    expect(live.stored('canvas-new')?.id).not.toBe(live.stored('canvas-a')?.id)
    expect(live.stored('canvas-new')?.kind).toBe('markdown')
    expect(live.evicted).toEqual(['canvas-new'])
    expectAllCallsLocked(live)
  })

  it('reconciles onto an existing target of the SAME kind with overwrite, keeping that kind', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1', 'n2']), 'markdown')
    live.seed('canvas-b', spatialDoc(['old']), 'markdown')
    const result = await run(live, versionsWith({ v1: { doc: spatialDoc(['n1', 'n2']) } }), {
      targetPath: 'canvas-b',
      overwrite: true,
    })
    expect(result).toMatchObject({
      kind: 'restored-to-target',
      targetPath: 'canvas-b',
      documentId: live.stored('canvas-b')?.id,
    })
    expect(live.stored('canvas-b')?.kind).toBe('markdown')
    expectAllCallsLocked(live)
  })

  it.each([
    ['markdown', 'spatial'],
    ['spatial', 'markdown'],
  ] as const)('refuses to overwrite a %s target with a %s version, and writes nothing', async (sourceKind, targetKind) => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']), sourceKind)
    const target = spatialDoc(['precious'])
    live.seed('canvas-b', target, targetKind)
    const opsBefore = target.oplogVersion()
    const events: RestoreProgressEvent[] = []

    const result = await run(
      live,
      versionsWith({ v1: { doc: spatialDoc(['n1']) } }),
      { targetPath: 'canvas-b', overwrite: true },
      (event) => events.push(event),
    )

    expect(result).toEqual({
      kind: 'kind-mismatch',
      targetPath: 'canvas-b',
      sourceKind,
      targetKind,
    })
    expect(live.stored('canvas-b')?.kind).toBe(targetKind)
    expect(target.oplogVersion().compare(opsBefore)).toBe(0)
    expect(live.calls.map((call) => call.method)).not.toContain('save')
    expect(events).toEqual([])
    expectAllCallsLocked(live)
  })

  it('maps a path-taken save refusal to output-exists (the backstop under the lock)', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    live.seed('canvas-b', spatialDoc(['other']))
    // exists() lies "false" to force the save itself to refuse — the seam
    // contract's DocumentPathTakenError arm.
    live.exists = async function (this: FakeLive) {
      return false
    }.bind(live)
    const result = await run(live, versionsWith({ v1: { doc: spatialDoc(['n1']) } }), {
      targetPath: 'canvas-b',
    })
    expect(result).toEqual({ kind: 'output-exists', targetPath: 'canvas-b' })
  })

  it('targetPath === path collapses into the in-place mode', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1']))
    const result = await run(live, versionsWith({ v1: { doc: spatialDoc(['n1', 'n2']) } }), {
      targetPath: 'canvas-a',
    })
    expect(result).toEqual({ kind: 'restored-in-place' })
  })
})

describe('restoreVersion subtree mode', () => {
  function workspaceDocWith(
    docs: { path: string; documentId: string; kind?: DocumentKind; nodeIds: string[] }[],
  ): LoroDoc {
    const workspace = new LoroDoc()
    for (const entry of docs) {
      createWorkspaceDocumentAtPath(workspace, {
        path: entry.path,
        documentId: entry.documentId,
        kind: entry.kind ?? 'spatial',
      })
      writeWorkspaceDocumentContent(workspace, entry.documentId, spatialDoc(entry.nodeIds))
    }
    return workspace
  }

  it('reverts descendants, deletes documents born after the version, renames moved ones, and recreates deleted ones', async () => {
    const live = new FakeLive()
    const rootId = generateDocumentId()
    const movedId = generateDocumentId()
    const deletedId = generateDocumentId()
    // Live state: root exists, child was moved, one child was deleted since
    // the version, and one was created after it.
    live.seed('canvas-a', spatialDoc(['root-new']), 'spatial', rootId)
    live.seed('canvas-a/moved-here', spatialDoc(['moved']), 'spatial', movedId)
    live.seed('canvas-a/born-later', spatialDoc(['newborn']))
    live.seed('elsewhere', spatialDoc(['unrelated']))

    const pastWorkspace = workspaceDocWith([
      { path: 'canvas-a', documentId: rootId, nodeIds: ['root-old'] },
      { path: 'canvas-a/child', documentId: movedId, nodeIds: ['moved'] },
      { path: 'canvas-a/deleted', documentId: deletedId, kind: 'markdown', nodeIds: ['gone'] },
    ])

    const events: RestoreProgressEvent[] = []
    const result = await run(
      live,
      versionsWith({
        v1: { doc: spatialDoc(['root-old']), workspace: pastWorkspace, label: 'ws' },
      }),
      { subtree: true },
      (e) => events.push(e),
    )
    expect(result).toEqual({ kind: 'restored-subtree', restoredCount: 3 })
    expect(live.paths()).toEqual(['canvas-a', 'canvas-a/child', 'canvas-a/deleted', 'elsewhere'])
    expect(live.stored('canvas-a/deleted')?.kind).toBe('markdown')
    // The recreated document (no live row) is evicted; reconciled ones are not.
    expect(live.evicted).toEqual(['canvas-a/deleted'])
    expect(events).toEqual([
      { workspaceId: WS, path: 'canvas-a', phase: 'started', label: 'ws' },
      { workspaceId: WS, path: 'canvas-a', phase: 'complete' },
    ])
    expectAllCallsLocked(live)
  })

  // The version must hold the outside document too: a past workspace that
  // never held it cannot tell a scoped rollback from a workspace-wide one.
  it('leaves a document outside the subtree alone even when the version held it', async () => {
    const live = new FakeLive()
    const rootId = generateDocumentId()
    const elsewhereId = generateDocumentId()
    live.seed('canvas-a', spatialDoc(['root-new']), 'spatial', rootId)
    live.seed('elsewhere', spatialDoc(['elsewhere-new']), 'spatial', elsewhereId)
    const pastWorkspace = workspaceDocWith([
      { path: 'canvas-a', documentId: rootId, nodeIds: ['root-old'] },
      { path: 'elsewhere', documentId: elsewhereId, nodeIds: ['elsewhere-old'] },
    ])
    const versions = versionsWith({
      v1: { doc: spatialDoc(['root-old']), workspace: pastWorkspace },
    })
    const result = await run(live, versions, { subtree: true })
    expect(result).toEqual({ kind: 'restored-subtree', restoredCount: 1 })
    expect(nodeIdsAt(live, 'elsewhere')).toEqual(['elsewhere-new'])
    expect(versions.saved.map((s) => s.path)).toEqual(['canvas-a'])
  })

  it('reverts the content of a surviving descendant in place, keeping its identity', async () => {
    const live = new FakeLive()
    const rootId = generateDocumentId()
    const childId = generateDocumentId()
    live.seed('canvas-a', spatialDoc(['root-new']), 'spatial', rootId)
    live.seed('canvas-a/child', spatialDoc(['child-new']), 'spatial', childId)
    const pastWorkspace = workspaceDocWith([
      { path: 'canvas-a', documentId: rootId, nodeIds: ['root-old'] },
      { path: 'canvas-a/child', documentId: childId, nodeIds: ['child-old'] },
    ])
    await run(
      live,
      versionsWith({ v1: { doc: spatialDoc(['root-old']), workspace: pastWorkspace } }),
      { subtree: true },
    )
    expect(nodeIdsAt(live, 'canvas-a')).toEqual(['root-old'])
    expect(nodeIdsAt(live, 'canvas-a/child')).toEqual(['child-old'])
    expect(live.stored('canvas-a')?.id).toBe(rootId)
    expect(live.stored('canvas-a/child')?.id).toBe(childId)
    expect(live.calls.filter((c) => c.method === 'delete')).toEqual([])
  })

  it('leaves a sibling whose name merely starts with the subtree path alone', async () => {
    const live = new FakeLive()
    const rootId = generateDocumentId()
    live.seed('canvas-a', spatialDoc(['root']), 'spatial', rootId)
    live.seed('canvas-ab', spatialDoc(['sibling']))
    const pastWorkspace = workspaceDocWith([
      { path: 'canvas-a', documentId: rootId, nodeIds: ['root'] },
    ])
    const result = await run(
      live,
      versionsWith({ v1: { doc: spatialDoc(['root']), workspace: pastWorkspace } }),
      { subtree: true },
    )
    expect(result).toEqual({ kind: 'restored-subtree', restoredCount: 1 })
    expect(live.paths()).toEqual(['canvas-a', 'canvas-ab'])
  })

  fcTest.prop(
    [
      fc.string({
        minLength: 1,
        maxLength: 6,
        unit: fc.constantFrom(...'abcxyz-_.019'.split('')),
      }),
    ],
    withDefaults(),
  )(
    'never deletes a live sibling whose path extends the subtree path without a separator',
    async (suffix) => {
      const live = new FakeLive()
      const rootId = generateDocumentId()
      live.seed('canvas-a', spatialDoc(['root']), 'spatial', rootId)
      live.seed(`canvas-a${suffix}`, spatialDoc(['sibling']))
      const pastWorkspace = workspaceDocWith([
        { path: 'canvas-a', documentId: rootId, nodeIds: ['root'] },
      ])
      await run(
        live,
        versionsWith({ v1: { doc: spatialDoc(['root']), workspace: pastWorkspace } }),
        { subtree: true },
      )
      expect(live.paths()).toEqual(['canvas-a', `canvas-a${suffix}`].sort())
    },
  )

  it('records the merge point on every document a subtree rollback moved, and on no other', async () => {
    const live = new FakeLive()
    const [rootId, childId, sameId] = Array.from({ length: 3 }, () => generateDocumentId())
    live.seed('canvas-a', spatialDoc(['root-new']), 'spatial', rootId)
    live.seed('canvas-a/child', spatialDoc(['child-new']), 'spatial', childId)
    live.seed('canvas-a/same', spatialDoc(['same']), 'spatial', sameId)
    const pastWorkspace = workspaceDocWith([
      { path: 'canvas-a', documentId: rootId, nodeIds: ['root-old'] },
      { path: 'canvas-a/child', documentId: childId, nodeIds: ['child-old'] },
      { path: 'canvas-a/same', documentId: sameId, nodeIds: ['same'] },
    ])
    const versions = versionsWith({
      v1: { doc: spatialDoc(['root-old']), workspace: pastWorkspace },
    })
    await run(live, versions, { subtree: true })
    expect(versions.saved.map((s) => s.path).sort()).toEqual(['canvas-a', 'canvas-a/child'])
    expect(versions.saved.every((s) => s.options.restoredFrom === 'v1')).toBe(true)
  })

  // Deletions run first, and the order is load-bearing: a document the
  // version holds may sit at a path some later-born document now occupies.
  // The test above cannot see that order — its born-later document sits at a
  // path no past document needs, so it stays green whichever loop runs
  // first (measured: swapping them left every test in this file passing).
  // This one puts the squatter ON the past document's path. Restored last,
  // the squatter is still there when the past document tries to land, and
  // `save` refuses an occupied path it was not told to overwrite.
  it('deletes a later-born document before restoring the past one whose path it occupies', async () => {
    const live = new FakeLive()
    const rootId = generateDocumentId()
    const deletedId = generateDocumentId()
    live.seed('canvas-a', spatialDoc(['root']), 'spatial', rootId)
    const squatterId = live.seed('canvas-a/slot', spatialDoc(['squatter']))

    const pastWorkspace = workspaceDocWith([
      { path: 'canvas-a', documentId: rootId, nodeIds: ['root'] },
      { path: 'canvas-a/slot', documentId: deletedId, nodeIds: ['original'] },
    ])

    const result = await run(
      live,
      versionsWith({ v1: { doc: spatialDoc(['root']), workspace: pastWorkspace } }),
      { subtree: true },
    )
    expect(result).toEqual({ kind: 'restored-subtree', restoredCount: 2 })
    expect(live.paths()).toEqual(['canvas-a', 'canvas-a/slot'])
    const slot = live.stored('canvas-a/slot')
    if (slot === undefined) throw new Error('canvas-a/slot was not restored')
    // The past document, not the squatter under a new coat of content.
    expect(slot.id).not.toBe(squatterId)
    expect(readSpatialCanvas(slot.doc).nodes.map((node) => node.id)).toEqual(['original'])
    expectAllCallsLocked(live)
  })
})

/**
 * A restore is a MERGE, and a merge that leaves no row is a merge nobody can
 * find afterwards.
 *
 * `reconcileDocContent` commits new ops whose result equals the past state,
 * so what comes out is a descendant of BOTH the state you were on and the
 * one you restored. Before this, nothing recorded that moment: the next row
 * appeared only when the document had been quiet for five minutes, by which
 * time it was an ordinary checkpoint saying nothing about where it came
 * from. The history read as a straight line through a point where two
 * branches had actually joined.
 *
 * The row is what carries the REASON. The topology is already derivable
 * from the stored frontiers (Loro's `cmpFrontiers` answers -1/1/0/undefined, and
 * undefined is a real branch point), but no amount of frontier arithmetic
 * can say WHY the branches met — the same reason a merge commit carries a
 * message.
 */
describe('a restore records the merge point it creates', () => {
  it('saves a row naming the version it restored', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['now']))
    const versions = versionsWith({ 'v-past': { doc: spatialDoc(['then']), path: 'canvas-a' } })

    const result = await restoreVersion(
      { versions, liveDocuments: live },
      { workspaceId: WS, path: 'canvas-a', versionId: 'v-past' },
    )

    expect(result).toEqual({ kind: 'restored-in-place' })
    expect(versions.saved).toHaveLength(1)
    expect(versions.saved[0]?.path).toBe('canvas-a')
    // Named, so the panel can say "restored from …" rather than leaving the
    // reader to infer it from two timestamps.
    expect(versions.saved[0]?.options.restoredFrom).toBe('v-past')
    // Not a bookmark: nobody typed a name for it.
    expect(versions.saved[0]?.options.auto).toBe(true)
  })

  it('records the merge on a brand-new target created by the restore', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['now']))
    const versions = versionsWith({ 'v-past': { doc: spatialDoc(['then']), path: 'canvas-a' } })

    const result = await restoreVersion(
      { versions, liveDocuments: live },
      { workspaceId: WS, path: 'canvas-a', versionId: 'v-past', targetPath: 'canvas-new' },
    )

    expect(result).toMatchObject({ kind: 'restored-to-target', targetPath: 'canvas-new' })
    expect(versions.saved).toEqual([
      { path: 'canvas-new', options: { auto: true, restoredFrom: 'v-past' } },
    ])
  })

  it('records the merge against the TARGET when restoring into another document', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['now']))
    live.seed('canvas-b', spatialDoc(['other']))
    const versions = versionsWith({ 'v-past': { doc: spatialDoc(['then']), path: 'canvas-a' } })

    await restoreVersion(
      { versions, liveDocuments: live },
      {
        workspaceId: WS,
        path: 'canvas-a',
        versionId: 'v-past',
        targetPath: 'canvas-b',
        overwrite: true,
      },
    )

    // The document that CHANGED is the one whose history gained a point.
    expect(versions.saved).toHaveLength(1)
    expect(versions.saved[0]?.path).toBe('canvas-b')
    expect(versions.saved[0]?.options.restoredFrom).toBe('v-past')
  })
})
