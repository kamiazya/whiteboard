import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import type { RestoreProgressEvent } from '../operations/restore-version.js'
import type { CanvasClientNotifier, ServerDeps, VersionCreated } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { FakeLiveDocuments } from '../test-utils/fake-live-documents.js'
import { FakeVersionHistory } from '../test-utils/fake-version-history.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { createVersionListTool } from './version-list.js'
import {
  createVersionRestoreTool,
  RestoreTargetExistsError,
  SubtreeNeedsWorkspaceVersionError,
  SubtreeTakesNoTargetError,
  VersionNotFoundError,
} from './version-restore.js'
import { createVersionSaveTool } from './version-save.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const PATH = 'notes/plan'

function textDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text }],
    edges: [],
  })
  return doc
}

function textOf(doc: LoroDoc): string | undefined {
  const node = readSpatialCanvas(doc).nodes[0]
  return node?.type === 'text' ? node.text : undefined
}

class RecordingNotifier implements CanvasClientNotifier {
  readonly versions: VersionCreated[] = []
  readonly restores: RestoreProgressEvent[] = []
  agentActivity(): void {}
  async requestViewport(): Promise<boolean> {
    return false
  }
  versionCreated(event: VersionCreated): void {
    this.versions.push(event)
  }
  restoreProgress(event: RestoreProgressEvent): void {
    this.restores.push(event)
  }
}

/** A second document in the same workspace, for the batch cases. */
async function addDocument(deps: ServerDeps, documentId: string, path: string): Promise<string> {
  const store = deps.documentStore as FakeDocumentStore
  await registerDocumentInWorkspace(store, WORKSPACE_ID, documentId, path)
  await seedDoc(store, documentId, (doc) => {
    writeSpatialCanvas(doc, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'other' }],
      edges: [],
    })
  })
  return documentId
}

async function setup(text = 'original') {
  const store = new FakeDocumentStore()
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID, PATH)
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeSpatialCanvas(doc, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text }],
      edges: [],
    })
  })
  const versions = new FakeVersionHistory()
  const live = new FakeLiveDocuments()
  const notifier = new RecordingNotifier()
  const deps: ServerDeps = makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    versions,
    liveDocuments: live,
    clientNotifier: notifier,
  })
  return { store, versions, live, notifier, deps }
}

describe('wb_version_save', () => {
  test('records the version in the history under the document PATH, as a manual save, and answers the row', async () => {
    const { deps, versions } = await setup()

    const result = await createVersionSaveTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      label: 'before the risky edit',
    })

    expect(versions.saves).toEqual([
      { path: PATH, options: { auto: false, label: 'before the risky edit' } },
    ])
    expect(result.saved[0]?.documentId).toBe(DOCUMENT_ID)
    // The row as an agent reads it: the id to restore by, the label, who
    // saved it — not the path it already named, nor the panel's columns.
    expect(result.saved[0]?.version).toEqual({
      id: 'v1',
      createdAt: '1970-01-01T00:00:01.000Z',
      label: 'before the risky edit',
      auto: false,
    })
  })

  test('tells a watching client, addressed by documentId, with the row it just saved', async () => {
    const { deps, notifier } = await setup()

    const result = await createVersionSaveTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      label: 'v1',
    })

    // The client gets the WHOLE row (the History panel draws its columns);
    // the agent gets the projection, and the two name the same version.
    expect(notifier.versions).toHaveLength(1)
    expect(notifier.versions[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      version: { id: result.saved[0]?.version.id, path: PATH, branchName: 'main' },
    })
  })

  test('refuses a workspaceId that does not own the document, before recording anything', async () => {
    const { deps, versions } = await setup()

    await expect(
      createVersionSaveTool(deps).execute({
        workspaceId: 'ws-other',
        documentIds: [DOCUMENT_ID],
        label: 'v1',
      }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
    expect(versions.saves).toEqual([])
  })

  test('saves one version per document in a single call, in the order asked for', async () => {
    // Axis B: the cost of checkpointing N documents was N calls, because the
    // tool took one `documentId`. The label is shared rather than per
    // document — one label across a set is what makes them ONE checkpoint,
    // and a caller wanting different labels is asking for different saves.
    const { deps, versions } = await setup()
    const second = await addDocument(deps, '01H8XJZ9K5N4M3P2Q1R0S9T8V8', 'notes/other')

    const result = await createVersionSaveTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID, second],
      label: 'before the risky edit',
    })

    expect(versions.saves.map((save) => save.path)).toEqual([PATH, 'notes/other'])
    expect(result.saved.map((entry) => entry.documentId)).toEqual([DOCUMENT_ID, second])
  })

  test('one document outside the workspace records NOTHING, not a prefix', async () => {
    // The payoff of resolving every document before saving any. Without it
    // the good document is checkpointed and the call still fails, so a
    // caller who retries gets two rows for it — and cannot tell from the
    // error that it happened.
    const { deps, versions, notifier } = await setup()
    const stranger = '01H8XJZ9K5N4M3P2Q1R0S9T8V9'

    await expect(
      createVersionSaveTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID, stranger],
        label: 'v1',
      }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)

    expect(versions.saves).toEqual([])
    expect(notifier.versions).toEqual([])
  })
})

describe('wb_version_list', () => {
  test("answers the history's rows for the document's path, newest first", async () => {
    const { deps } = await setup()
    const save = createVersionSaveTool(deps)
    await save.execute({ workspaceId: WORKSPACE_ID, documentIds: [DOCUMENT_ID], label: 'first' })
    await save.execute({ workspaceId: WORKSPACE_ID, documentIds: [DOCUMENT_ID], label: 'second' })

    const result = await createVersionListTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
    })

    expect(result.documentId).toBe(DOCUMENT_ID)
    expect(result.versions.map((v) => v.label)).toEqual(['second', 'first'])
  })

  test('refuses a workspaceId that does not own the document', async () => {
    const { deps } = await setup()
    await expect(
      createVersionListTool(deps).execute({ workspaceId: 'ws-other', documentId: DOCUMENT_ID }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })
})

describe('wb_version_restore', () => {
  test('reconciles the LIVE document to the saved state through the operation, and answers the label', async () => {
    const { deps, versions, live } = await setup()
    const saved = await versions.save(WORKSPACE_ID, PATH, textDoc('original'), {
      auto: false,
      label: 'checkpoint',
    })
    const liveDoc = textDoc('original')
    live.docs.set(PATH, liveDoc)
    writeSpatialCanvas(liveDoc, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'modified' }],
      edges: [],
    })
    liveDoc.commit()
    const before = liveDoc.oplogVersion()

    const result = await createVersionRestoreTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: saved.id,
    })

    expect(result).toEqual({
      documentId: DOCUMENT_ID,
      restoredVersionId: saved.id,
      label: 'checkpoint',
      mode: 'in-place',
    })
    expect(textOf(liveDoc)).toBe('original')
    // The SAME doc instance moved forward — a reconcile, not a swap — so a
    // client holding it stays on its lineage.
    expect(live.docs.get(PATH)).toBe(liveDoc)
    expect(liveDoc.oplogVersion().compare(before)).toBe(1)
  })

  test('brackets a watching client with started (carrying the label) and complete', async () => {
    const { deps, versions, notifier } = await setup()
    const saved = await versions.save(WORKSPACE_ID, PATH, textDoc('original'), {
      auto: false,
      label: 'checkpoint',
    })

    await createVersionRestoreTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: saved.id,
    })

    expect(notifier.restores).toEqual([
      { workspaceId: WORKSPACE_ID, path: PATH, phase: 'started', label: 'checkpoint' },
      { workspaceId: WORKSPACE_ID, path: PATH, phase: 'complete' },
    ])
  })

  test('restores into a NEW targetPath as a copy, reporting the mode and the element count', async () => {
    const { deps, versions, live } = await setup()
    const saved = await versions.save(WORKSPACE_ID, PATH, textDoc('original'), {
      auto: false,
      label: 'checkpoint',
    })
    const source = textDoc('moved on since')
    live.docs.set(PATH, source)

    const result = await createVersionRestoreTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: saved.id,
      targetPath: 'notes/plan-copy',
    })

    expect(result).toEqual({
      documentId: DOCUMENT_ID,
      restoredVersionId: saved.id,
      label: 'checkpoint',
      mode: 'into-target',
      targetPath: 'notes/plan-copy',
      elementCount: 1,
    })
    const copy = live.docs.get('notes/plan-copy')
    expect(copy && textOf(copy)).toBe('original')
    // The source stayed as it was: a copy is not an in-place restore.
    expect(live.docs.get(PATH)).toBe(source)
    expect(textOf(source)).toBe('moved on since')
  })

  test('refuses an existing targetPath without overwrite, and reconciles onto it with overwrite', async () => {
    const { deps, versions, live } = await setup()
    const saved = await versions.save(WORKSPACE_ID, PATH, textDoc('original'), {
      auto: false,
      label: 'checkpoint',
    })
    const occupant = textDoc('occupant')
    live.docs.set('notes/other', occupant)
    const tool = createVersionRestoreTool(deps)

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        versionId: saved.id,
        targetPath: 'notes/other',
      }),
    ).rejects.toThrow(RestoreTargetExistsError)
    expect(textOf(occupant)).toBe('occupant')

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: saved.id,
      targetPath: 'notes/other',
      overwrite: true,
    })
    expect(result).toMatchObject({ mode: 'into-target', targetPath: 'notes/other' })
    // Reconciled onto the SAME instance a client may hold, not swapped.
    expect(live.docs.get('notes/other')).toBe(occupant)
    expect(textOf(occupant)).toBe('original')
  })

  test('refuses a subtree rollback from a version that is not workspace-scoped', async () => {
    const { deps, versions } = await setup()
    const saved = await versions.save(WORKSPACE_ID, PATH, textDoc('original'), {
      auto: false,
      label: 'checkpoint',
    })
    await expect(
      createVersionRestoreTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        versionId: saved.id,
        subtree: true,
      }),
    ).rejects.toThrow(SubtreeNeedsWorkspaceVersionError)
  })

  test('refuses subtree combined with a distinct targetPath', async () => {
    const { deps, versions } = await setup()
    const saved = await versions.save(WORKSPACE_ID, PATH, textDoc('original'), {
      auto: false,
      label: 'checkpoint',
    })
    await expect(
      createVersionRestoreTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        versionId: saved.id,
        targetPath: 'notes/other',
        subtree: true,
      }),
    ).rejects.toThrow(SubtreeTakesNoTargetError)
  })

  test('throws VersionNotFoundError for a versionId the history does not hold', async () => {
    const { deps } = await setup()
    await expect(
      createVersionRestoreTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        versionId: 'nonexistent',
      }),
    ).rejects.toThrow(VersionNotFoundError)
  })

  test('throws WorkspaceDocumentNotFoundError when workspaceId does not own documentId', async () => {
    const { deps, versions } = await setup()
    const saved = await versions.save(WORKSPACE_ID, PATH, textDoc('original'), {
      auto: false,
      label: 'v1',
    })
    await expect(
      createVersionRestoreTool(deps).execute({
        workspaceId: 'ws-other',
        documentId: DOCUMENT_ID,
        versionId: saved.id,
      }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })
})
