import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import type { ServerDeps, VersionHistory } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { loadDocument } from '../tools/document-io.js'
import { restoreVersion, TargetExistsError, VersionNotFoundError } from './restore-version.js'

const WORKSPACE_ID = 'ws-1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const OTHER_DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'

function canvasWith(ids: readonly string[]): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: ids.map((id, i) => ({
      id,
      type: 'text' as const,
      x: i * 10,
      y: 0,
      width: 80,
      height: 40,
      text: id,
    })),
    edges: [],
  })
  return doc
}

function nodeIds(doc: LoroDoc): string[] {
  return readSpatialCanvas(doc)
    .nodes.map((n) => n.id)
    .sort()
}

/**
 * A history holding one version, keyed by id. Answers `null` for anything
 * else, which is the seam's real "no such version" answer rather than a
 * throw — the operation has to tell those apart.
 */
function historyWith(entries: Record<string, LoroDoc>): VersionHistory {
  return {
    load: async (_workspaceId, id) => entries[id] ?? null,
    loadWorkspaceAt: async () => null,
    list: async () => Object.keys(entries).map((id) => ({ id })),
  }
}

async function seedWorkspace(store: FakeDocumentStore, ids: readonly string[]) {
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeSpatialCanvas(doc, readSpatialCanvas(canvasWith(ids)))
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID, 'design')
}

describe('restoreVersion', () => {
  test('in-place restore reconciles the live document to the past state', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, ['keep-me', 'added-after-v1'])
    const deps: ServerDeps = makeTestDeps({
      documentStore: store,
      documentIndex: store.documentIndex,
      versions: historyWith({ v1: canvasWith(['keep-me']) }),
    })

    const result = await restoreVersion(deps, {
      workspaceId: WORKSPACE_ID,
      path: 'design',
      versionId: 'v1',
    })

    expect(result).toEqual({ kind: 'in-place' })
    // A CRDT cannot rewind, so the restore is a NEW edit whose RESULT equals
    // the past state — the node added after v1 is gone from the projection.
    const { doc } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(nodeIds(doc)).toEqual(['keep-me'])
  })

  test('refuses a version the history does not hold, rather than restoring nothing silently', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, ['keep-me'])
    const deps: ServerDeps = makeTestDeps({
      documentStore: store,
      documentIndex: store.documentIndex,
      versions: historyWith({ v1: canvasWith(['keep-me']) }),
    })

    await expect(
      restoreVersion(deps, { workspaceId: WORKSPACE_ID, path: 'design', versionId: 'nope' }),
    ).rejects.toBeInstanceOf(VersionNotFoundError)
  })

  test('restores into a brand-new target, leaving the source untouched', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, ['keep-me', 'added-after-v1'])
    const deps: ServerDeps = makeTestDeps({
      documentStore: store,
      documentIndex: store.documentIndex,
      versions: historyWith({ v1: canvasWith(['keep-me']) }),
    })

    const result = await restoreVersion(deps, {
      workspaceId: WORKSPACE_ID,
      path: 'design',
      versionId: 'v1',
      targetPath: 'design-v1',
    })

    expect(result.kind).toBe('into-target')
    if (result.kind !== 'into-target') return
    expect(result.elementCount).toBe(1)

    // The new document holds the past state...
    const created = await deps.documentIndex.resolveDocument({
      workspaceId: WORKSPACE_ID,
      path: 'design-v1',
    })
    expect(created).not.toBeNull()
    if (created === null) return
    // The restored content is whatever the SOURCE stores, so a kind-aware
    // reader opening the copy must get the same editor. Without this the
    // copy lands with no recorded kind and opens under the wrong one.
    expect(created.kind).toBe('spatial')
    const { doc: target } = await loadDocument(deps, WORKSPACE_ID, created.documentId)
    expect(nodeIds(target)).toEqual(['keep-me'])

    // ...and the SOURCE is untouched, which is what separates this mode from
    // an in-place restore: a caller asking for a copy has not asked to lose
    // the document they copied from.
    const { doc: source } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(nodeIds(source)).toEqual(['added-after-v1', 'keep-me'])
  })

  test('refuses an existing target without overwrite, rather than silently replacing it', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, ['keep-me'])
    await seedDoc(store, OTHER_DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, readSpatialCanvas(canvasWith(['occupied'])))
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, OTHER_DOCUMENT_ID, 'design-v1')
    const deps: ServerDeps = makeTestDeps({
      documentStore: store,
      documentIndex: store.documentIndex,
      versions: historyWith({ v1: canvasWith(['keep-me']) }),
    })

    await expect(
      restoreVersion(deps, {
        workspaceId: WORKSPACE_ID,
        path: 'design',
        versionId: 'v1',
        targetPath: 'design-v1',
      }),
    ).rejects.toBeInstanceOf(TargetExistsError)

    // Refusing means the occupant is still there, not merely that a promise
    // rejected — the assertion that would catch a refusal issued too late.
    const { doc: occupant } = await loadDocument(deps, WORKSPACE_ID, OTHER_DOCUMENT_ID)
    expect(nodeIds(occupant)).toEqual(['occupied'])
  })

  test('overwrite reconciles the existing target onto the past state', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, ['keep-me'])
    await seedDoc(store, OTHER_DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, readSpatialCanvas(canvasWith(['occupied'])))
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, OTHER_DOCUMENT_ID, 'design-v1')
    const deps: ServerDeps = makeTestDeps({
      documentStore: store,
      documentIndex: store.documentIndex,
      versions: historyWith({ v1: canvasWith(['keep-me']) }),
    })

    const { doc: before } = await loadDocument(deps, WORKSPACE_ID, OTHER_DOCUMENT_ID)
    const beforeVersion = before.oplogVersion()

    const result = await restoreVersion(deps, {
      workspaceId: WORKSPACE_ID,
      path: 'design',
      versionId: 'v1',
      targetPath: 'design-v1',
      overwrite: true,
    })

    expect(result.kind).toBe('into-target')
    const { doc: target } = await loadDocument(deps, WORKSPACE_ID, OTHER_DOCUMENT_ID)
    expect(nodeIds(target)).toEqual(['keep-me'])

    // The projection alone cannot tell a reconcile from a wholesale swap —
    // both end up showing the past state, which is why asserting only the
    // node ids let a swap pass. The difference is LINEAGE: a reconcile
    // appends new ops to the target's own history, so the restored doc still
    // descends from what the target had. A swap installs `past`'s history
    // instead, and a client holding the target would find its own ops gone.
    expect(target.oplogVersion().compare(beforeVersion)).not.toBe(-1)
    expect(target.oplogVersion().compare(beforeVersion)).not.toBeUndefined()
  })

  test('targetPath equal to the source path is the in-place restore, not a self-overwrite', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, ['keep-me', 'added-after-v1'])
    const deps: ServerDeps = makeTestDeps({
      documentStore: store,
      documentIndex: store.documentIndex,
      versions: historyWith({ v1: canvasWith(['keep-me']) }),
    })

    // Without this collapse a caller restoring onto their own document would
    // have to pass overwrite:true against themselves, or be refused for
    // colliding with the document they are restoring.
    const result = await restoreVersion(deps, {
      workspaceId: WORKSPACE_ID,
      path: 'design',
      versionId: 'v1',
      targetPath: 'design',
    })

    expect(result).toEqual({ kind: 'in-place' })
    const { doc } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(nodeIds(doc)).toEqual(['keep-me'])
  })
})
