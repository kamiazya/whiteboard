import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import type { RestoreProgressEvent } from '../operations/restore-version.js'
import type {
  CanvasClientNotifier,
  LiveDocuments,
  ServerDeps,
  VersionCreated,
  VersionHistory,
} from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import type { VersionEntry } from '../versions/version-entry.js'
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

/**
 * The history as the tools see it: rows keyed by path, each holding a
 * snapshot of the doc as it was saved. Records every `save` call so a test
 * can assert what the tool asked for, not only what came back.
 */
class FakeVersionHistory implements VersionHistory {
  readonly saves: { path: string; options: Parameters<VersionHistory['save']>[3] }[] = []
  private readonly rows = new Map<string, { entry: VersionEntry; snapshot: Uint8Array }>()
  private next = 0

  async save(
    _workspaceId: string,
    path: string,
    doc: LoroDoc,
    options: Parameters<VersionHistory['save']>[3],
  ): Promise<VersionEntry> {
    this.saves.push({ path, options })
    this.next += 1
    const entry: VersionEntry = {
      id: `v${this.next}`,
      path,
      createdAt: new Date(this.next * 1000).toISOString(),
      elementCount: readSpatialCanvas(doc).nodes.length,
      auto: options.auto,
      hasThumbnail: false,
      branchName: options.branchName ?? 'main',
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.operator === undefined ? {} : { operator: options.operator }),
    }
    this.rows.set(entry.id, { entry, snapshot: doc.export({ mode: 'snapshot' }) })
    return entry
  }
  async load(_workspaceId: string, id: string): Promise<LoroDoc | null> {
    const row = this.rows.get(id)
    if (row === undefined) return null
    const doc = new LoroDoc()
    doc.import(row.snapshot)
    return doc
  }
  async loadWorkspaceAt(): Promise<LoroDoc | null> {
    return null
  }
  async list(_workspaceId: string, path: string): Promise<readonly VersionEntry[]> {
    return [...this.rows.values()]
      .map((row) => row.entry)
      .filter((entry) => entry.path === path)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}

/** Live docs by path — what the restore operation reconciles onto. */
class FakeLiveDocuments implements LiveDocuments {
  readonly docs = new Map<string, LoroDoc>()
  async get(_workspaceId: string, path: string): Promise<LoroDoc> {
    let doc = this.docs.get(path)
    if (doc === undefined) {
      doc = new LoroDoc()
      this.docs.set(path, doc)
    }
    return doc
  }
  async save(_workspaceId: string, path: string, doc: LoroDoc): Promise<void> {
    this.docs.set(path, doc)
  }
  async exists(_workspaceId: string, path: string): Promise<boolean> {
    return this.docs.has(path)
  }
  async kind(): Promise<DocumentKind | null> {
    return 'spatial'
  }
  async list(): Promise<readonly { id?: string; path: string }[]> {
    return [...this.docs.keys()].map((path) => ({ path }))
  }
  async rename(): Promise<void> {
    throw new Error('not exercised')
  }
  async delete(): Promise<void> {
    throw new Error('not exercised')
  }
  evict(): void {}
  async withWriteLock<T>(_workspaceId: string, fn: () => Promise<T>): Promise<T> {
    return fn()
  }
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
      documentId: DOCUMENT_ID,
      label: 'before the risky edit',
    })

    expect(versions.saves).toEqual([
      { path: PATH, options: { auto: false, label: 'before the risky edit' } },
    ])
    expect(result.documentId).toBe(DOCUMENT_ID)
    expect(result.version).toMatchObject({ id: 'v1', path: PATH, label: 'before the risky edit' })
  })

  test('tells a watching client, addressed by documentId, with the row it just saved', async () => {
    const { deps, notifier } = await setup()

    const result = await createVersionSaveTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      label: 'v1',
    })

    expect(notifier.versions).toEqual([
      { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, version: result.version },
    ])
  })

  test('refuses a workspaceId that does not own the document, before recording anything', async () => {
    const { deps, versions } = await setup()

    await expect(
      createVersionSaveTool(deps).execute({
        workspaceId: 'ws-other',
        documentId: DOCUMENT_ID,
        label: 'v1',
      }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
    expect(versions.saves).toEqual([])
  })
})

describe('wb_version_list', () => {
  test("answers the history's rows for the document's path, newest first", async () => {
    const { deps } = await setup()
    const save = createVersionSaveTool(deps)
    await save.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, label: 'first' })
    await save.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, label: 'second' })

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
