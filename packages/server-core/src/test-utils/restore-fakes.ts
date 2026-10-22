/**
 * In-memory keepers for the restore operation's tests, shared by the files
 * that split them: a live store that records the write-lock depth of every
 * call, and a version history keyed by id.
 */
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { expect } from 'vitest'
import { type RestoreVersionResult, restoreVersion } from '../operations/restore-version.js'
import type { LiveDocuments, RestoreProgressEvent, VersionHistory } from '../server-deps.js'
import type { VersionEntry } from '../versions/version-entry.js'

export const WS = 'ws-1'
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
  readonly calls: { method: string; lockDepth: number }[] = []
  failNextSave: Error | null = null
  private lockDepth = 0

  private key(workspaceId: string, path: string) {
    return `${workspaceId}${KEY_SEPARATOR}${path}`
  }
  private record(method: string) {
    this.calls.push({ method, lockDepth: this.lockDepth })
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
    const entry = this.docs.get(this.key(workspaceId, oldPath))
    if (entry === undefined) return
    this.docs.delete(this.key(workspaceId, oldPath))
    this.docs.set(this.key(workspaceId, newPath), entry)
  }
  async delete(workspaceId: string, path: string): Promise<void> {
    this.record('delete')
    this.docs.delete(this.key(workspaceId, path))
  }
  evict(_workspaceId: string, path: string): void {
    this.record('evict')
    this.evicted.push(path)
  }
  async withWriteLock<T>(_workspaceId: string, fn: () => Promise<T>): Promise<T> {
    this.lockDepth += 1
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
    _doc: LoroDoc,
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
  async load(_workspaceId: string, id: string): Promise<LoroDoc | null> {
    return this.byId.get(id)?.doc ?? null
  }
  async loadWorkspaceAt(_workspaceId: string, id: string): Promise<LoroDoc | null> {
    return this.byId.get(id)?.workspace ?? null
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
    { versions, liveDocuments: live },
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
