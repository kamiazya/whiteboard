/**
 * In-memory keepers for the restore operation's tests, shared by the files
 * that split them: a live store that records the write-lock depth of every
 * call, and a version history keyed by id.
 */
import {
  bindRecordOps,
  createWorkspaceDocumentAtPath,
  legacyRecordOps,
  projectWorkspaceDocument,
  type RecordView,
  readSpatialCanvas,
  readWorkspaceDocuments,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { expect } from 'vitest'
import { type RestoreVersionResult, restoreVersion } from '../operations/restore-version.js'
import type {
  LiveDocuments,
  RestoreProgressEvent,
  VersionHistory,
  WorkspaceDocuments,
} from '../server-deps.js'
import type { VersionEntry } from '../versions/version-entry.js'
import { unusedWorkspaceDocuments } from './unused-workspace-documents.js'

export const WS = '01ZVM89A4A1V9FS03Z9J64KEK1'
// Joins a workspace id and a path into one map key. NUL cannot occur in
// either, so the join is unambiguous — but it is spelled as an escape, not
// typed into the source: a literal NUL byte makes grep, `file` and diff
// tooling treat this file as binary and hide it from every text search.
const KEY_SEPARATOR = '\0'

export function spatialDoc(nodeIds: readonly string[]): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: nodeIds.map((id) =>
      textNode({
        id,
        text: id,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ),
    edges: [],
  })
  return doc
}

interface StoredDoc {
  doc: LoroDoc
  kind: DocumentKind
  id: string
}

/**
 * In-memory LiveDocuments that records, for EVERY call, the write-lock depth
 * it observed — the property under test is not just "the right calls happen"
 * but "no read or write happens outside the one lock hold" (the phantom-
 * canvas race restore-race.test.ts pins at the route layer).
 */
export class FakeLive implements LiveDocuments {
  readonly docs = new Map<string, StoredDoc>()
  readonly evicted: string[] = []
  /** The workspaces whose record was dropped unsaved, and whose per-document projections were. */
  readonly recordsDropped: string[] = []
  readonly projectionsDropped: string[] = []
  /** The documents the write observer was told of. */
  readonly written: string[] = []
  readonly calls: { method: string; lockDepth: number }[] = []
  failNextSave: Error | null = null
  private lockDepth = 0
  /** The record `open` hands out, until it is dropped. */
  private keptRecord: LoroDoc | null = null

  private key(workspaceId: string, path: string) {
    return `${workspaceId}${KEY_SEPARATOR}${path}`
  }
  private record(method: string) {
    this.calls.push({ method, lockDepth: this.lockDepth })
  }

  /**
   * The record restore writes into, as the daemon holds one: opened over what
   * these documents hold, saved back into them, and dropped unsaved on
   * failure, with every call logged at the lock depth it ran at.
   */
  workspaceDocuments(): WorkspaceDocuments {
    return {
      ...unusedWorkspaceDocuments(),
      open: async () => {
        this.record('open')
        // ONE record across opens, as the daemon's cache keeps one: a write
        // that was not saved stays in it until something drops it, so a
        // missing eviction shows up as the next open reading the write.
        const record = this.heldRecord()
        return bindRecordOps(legacyRecordOps, record, () => this.saveRecord(record))
      },
      withRecord: async (_workspaceId, fn) => {
        this.record('open')
        const record = this.heldRecord()
        const session = bindRecordOps(legacyRecordOps, record, () => this.saveRecord(record))
        try {
          return await fn(session)
        } finally {
          session.release()
        }
      },
      evict: (workspaceId) => {
        this.record('evictRecord')
        this.recordsDropped.push(workspaceId)
        this.keptRecord = null
      },
      evictProjections: (workspaceId) => {
        this.record('evictProjections')
        this.projectionsDropped.push(workspaceId)
      },
    }
  }

  /**
   * The node ids the record holds for the canvas at `path`, read as the next
   * operation to open the record would read them: through the kept record, so
   * a write that was dropped is absent and one that was not is there. Not a
   * logged call: it is the test looking, not the operation.
   */
  async nodeIdsInRecord(path: string): Promise<string[]> {
    const record = this.heldRecord()
    const session = bindRecordOps(legacyRecordOps, record, async () => {})
    const asserted = <T>() => ({ parse: (value: unknown) => value as T })
    const entry = await session.read(
      { query: 'workspaceDocumentEntry', args: { path } },
      asserted<{ documentId: string } | null>(),
    )
    if (entry === null) return []
    const canvas = await session.read(
      { query: 'spatialCanvas', args: { documentId: entry.documentId } },
      asserted<{ canvas: { nodes: Array<{ id: string }> } }>(),
    )
    return canvas.canvas.nodes.map((node) => node.id)
  }

  private heldRecord(): LoroDoc {
    this.keptRecord ??= this.recordOfDocuments()
    return this.keptRecord
  }

  /** A workspace record holding the documents its path grammar admits; a restore never writes to the rest. */
  private recordOfDocuments(): LoroDoc {
    const record = new LoroDoc()
    for (const [key, stored] of this.docs) {
      const path = key.split(KEY_SEPARATOR)[1] as string
      // The live store here takes any path a generator names (a sibling whose
      // path extends another's); the record refuses the ones the grammar does.
      try {
        createWorkspaceDocumentAtPath(record, { path, documentId: stored.id, kind: stored.kind })
      } catch {
        continue
      }
      writeWorkspaceDocumentContent(record, stored.id, stored.doc)
    }
    return record
  }

  /** The save of an opened record: what it holds is what these documents hold afterwards. */
  private async saveRecord(record: LoroDoc): Promise<void> {
    this.record('save')
    if (this.failNextSave !== null) {
      const err = this.failNextSave
      this.failNextSave = null
      throw err
    }
    for (const entry of readWorkspaceDocuments(record)) {
      const stored = this.docs.get(this.key(WS, entry.path))
      const projected = projectWorkspaceDocument(record, entry.documentId)
      if (stored !== undefined && projected !== null) {
        this.docs.set(this.key(WS, entry.path), { ...stored, doc: projected, kind: entry.kind })
      }
    }
  }

  /** What restore is handed over these documents and a history. */
  deps(versions: VersionHistory) {
    return {
      versions,
      liveDocuments: this,
      workspaceDocuments: this.workspaceDocuments(),
      documentWritten: this.documentWritten,
    }
  }

  /** The observer a composition root hands restore, noting each document it is told of. */
  readonly documentWritten = async ({ path }: { path?: string }) => {
    this.record('documentWritten')
    if (path !== undefined) this.written.push(path)
  }

  seed(path: string, doc: LoroDoc, kind: DocumentKind = 'spatial', id = generateDocumentId()) {
    this.docs.set(this.key(WS, path), { doc, kind, id })
    return id
  }
  stored(path: string): StoredDoc | undefined {
    return this.docs.get(this.key(WS, path))
  }
  paths(): string[] {
    return [...this.docs.keys()].map((key) => key.split(KEY_SEPARATOR)[1] as string).sort()
  }

  async get(workspaceId: string, path: string): Promise<LoroDoc> {
    this.record('get')
    const existing = this.docs.get(this.key(workspaceId, path))
    if (existing !== undefined) return existing.doc
    // Mirrors the daemon store: an unknown path lazily answers an empty doc.
    const doc = new LoroDoc()
    this.docs.set(this.key(workspaceId, path), { doc, kind: 'spatial', id: generateDocumentId() })
    return doc
  }
  async save(
    workspaceId: string,
    path: string,
    doc: LoroDoc,
    options?: { overwrite?: boolean; kind?: DocumentKind },
  ): Promise<void> {
    this.record('save')
    if (this.failNextSave !== null) {
      const err = this.failNextSave
      this.failNextSave = null
      throw err
    }
    // The daemon's store writes through the record it keeps; this fake builds
    // the record from the documents, so it is rebuilt after one changes.
    this.keptRecord = null
    const existing = this.docs.get(this.key(workspaceId, path))
    if (existing !== undefined && existing.doc !== doc && options?.overwrite !== true) {
      throw new DocumentPathTakenError(workspaceId, path)
    }
    this.docs.set(this.key(workspaceId, path), {
      doc,
      kind: options?.kind ?? existing?.kind ?? 'spatial',
      id: existing?.id ?? generateDocumentId(),
    })
  }
  async exists(workspaceId: string, path: string): Promise<boolean> {
    this.record('exists')
    return this.docs.has(this.key(workspaceId, path))
  }
  async kind(workspaceId: string, path: string): Promise<DocumentKind | null> {
    this.record('kind')
    return this.docs.get(this.key(workspaceId, path))?.kind ?? null
  }
  async list(workspaceId: string): Promise<readonly { documentId?: string; path: string }[]> {
    this.record('list')
    return [...this.docs.entries()]
      .filter(([key]) => key.startsWith(`${workspaceId}${KEY_SEPARATOR}`))
      .map(([key, value]) => ({
        documentId: value.id,
        path: key.split(KEY_SEPARATOR)[1] as string,
      }))
  }
  async rename(workspaceId: string, oldPath: string, newPath: string): Promise<void> {
    this.record('rename')
    this.keptRecord = null
    const entry = this.docs.get(this.key(workspaceId, oldPath))
    if (entry === undefined) return
    this.docs.delete(this.key(workspaceId, oldPath))
    this.docs.set(this.key(workspaceId, newPath), entry)
  }
  async delete(workspaceId: string, path: string): Promise<void> {
    this.record('delete')
    this.keptRecord = null
    this.docs.delete(this.key(workspaceId, path))
  }
  evict(_workspaceId: string, path: string): void {
    this.record('evict')
    this.evicted.push(path)
  }
  async withWriteLock<T>(_workspaceId: string, fn: () => Promise<T>): Promise<T> {
    this.lockDepth += 1
    // The hold itself is a call, so a restore that reaches nothing before it
    // answers (a version that does not exist) still shows it ran inside one.
    this.record('withWriteLock')
    try {
      return await fn()
    } finally {
      this.lockDepth -= 1
    }
  }
}

export class FakeVersions implements VersionHistory {
  constructor(
    private readonly byId: Map<
      string,
      { doc: LoroDoc | null; workspace: LoroDoc | null; label?: string; path: string }
    >,
  ) {}
  readonly saved: {
    path: string
    options: { auto: boolean; label?: string; restoredFrom?: string }
  }[] = []
  async save(
    _workspaceId: string,
    path: string,
    options: { auto: boolean; label?: string; restoredFrom?: string },
  ): Promise<VersionEntry> {
    this.saved.push({ path, options })
    return {
      id: `saved-${this.saved.length}`,
      path,
      createdAt: '2026-01-01T00:00:00.000Z',
      elementCount: 0,
      auto: options.auto,
      ...(options.restoredFrom === undefined ? {} : { restoredFrom: options.restoredFrom }),
    }
  }
  async load(_workspaceId: string, id: string): Promise<Uint8Array | null> {
    return this.byId.get(id)?.doc?.export({ mode: 'snapshot' }) ?? null
  }
  async loadWorkspaceAt(_workspaceId: string, id: string): Promise<RecordView | null> {
    const workspace = this.byId.get(id)?.workspace
    if (workspace === undefined || workspace === null) return null
    const session = bindRecordOps(legacyRecordOps, workspace, async () => {})
    return session.view(session.version().encodedFrontiers)
  }
  async list(_workspaceId: string, path: string): Promise<readonly VersionEntry[]> {
    return [...this.byId.entries()]
      .filter(([, value]) => value.path === path)
      .map(([id, value]) => ({
        id,
        path,
        createdAt: '2026-01-01T00:00:00.000Z',
        elementCount: 0,
        auto: false,
        ...(value.label === undefined ? {} : { label: value.label }),
      }))
  }
  async adopt(): Promise<readonly string[]> {
    throw new Error("a restore never adopts another keeper's versions")
  }
}

export function versionsWith(
  entries: Record<
    string,
    { doc?: LoroDoc; workspace?: LoroDoc; label?: string; path?: string }
  > = {},
): FakeVersions {
  return new FakeVersions(
    new Map(
      Object.entries(entries).map(([id, entry]) => [
        id,
        {
          doc: entry.doc ?? null,
          workspace: entry.workspace ?? null,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          path: entry.path ?? 'canvas-a',
        },
      ]),
    ),
  )
}

export function run(
  live: FakeLive,
  versions: VersionHistory,
  input: Partial<Parameters<typeof restoreVersion>[1]> = {},
  progress?: (event: RestoreProgressEvent) => void,
): Promise<RestoreVersionResult> {
  return restoreVersion(
    live.deps(versions),
    { workspaceId: WS, path: 'canvas-a', versionId: 'v1', ...input },
    progress,
  )
}

/** Every LiveDocuments call this run made happened inside the lock hold. */
export function expectAllCallsLocked(live: FakeLive) {
  expect(live.calls.length).toBeGreaterThan(0)
  for (const call of live.calls) {
    expect(call, `${call.method} ran outside the workspace write lock`).toMatchObject({
      lockDepth: 1,
    })
  }
}

/** The node ids of the live document at `path`, or null when none is stored. */
export function nodeIdsAt(live: FakeLive, path: string): string[] | null {
  const stored = live.stored(path)
  return stored === undefined ? null : readSpatialCanvas(stored.doc).nodes.map((n) => n.id)
}
