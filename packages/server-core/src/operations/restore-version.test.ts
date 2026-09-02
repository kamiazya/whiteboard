import {
  createWorkspaceDocumentAtPath,
  readSpatialCanvas,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, VersionHistory } from '../server-deps.js'
import type { VersionEntry } from '../versions/version-entry.js'
import {
  type RestoreProgressEvent,
  type RestoreVersionResult,
  restoreVersion,
} from './restore-version.js'

const WS = 'ws-1'
// Joins a workspace id and a path into one map key. NUL cannot occur in
// either, so the join is unambiguous — but it is spelled as an escape, not
// typed into the source: a literal NUL byte makes grep, `file` and diff
// tooling treat this file as binary and hide it from every text search.
const KEY_SEPARATOR = '\0'

function spatialDoc(nodeIds: readonly string[]): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: nodeIds.map((id) => ({
      id,
      type: 'text' as const,
      text: id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })),
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
class FakeLive implements LiveDocuments {
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
  async list(workspaceId: string): Promise<readonly { id?: string; path: string }[]> {
    this.record('list')
    return [...this.docs.entries()]
      .filter(([key]) => key.startsWith(`${workspaceId}${KEY_SEPARATOR}`))
      .map(([key, value]) => ({ id: value.id, path: key.split(KEY_SEPARATOR)[1] as string }))
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

class FakeVersions implements VersionHistory {
  constructor(
    private readonly byId: Map<
      string,
      { doc: LoroDoc | null; workspace: LoroDoc | null; label?: string; path: string }
    >,
  ) {}
  async save(): Promise<VersionEntry> {
    throw new Error('restoreVersion never saves a version')
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
        hasThumbnail: false,
        branchName: 'main',
        ...(value.label === undefined ? {} : { label: value.label }),
      }))
  }
}

function versionsWith(
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

function run(
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
function expectAllCallsLocked(live: FakeLive) {
  expect(live.calls.length).toBeGreaterThan(0)
  for (const call of live.calls) {
    expect(call, `${call.method} ran outside the workspace write lock`).toMatchObject({
      lockDepth: 1,
    })
  }
}

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
      elementCount: 3,
    })
    expect(live.stored('canvas-new')?.kind).toBe('markdown')
    expect(live.evicted).toEqual(['canvas-new'])
    expectAllCallsLocked(live)
  })

  it('reconciles onto an existing target with overwrite and stamps the source kind', async () => {
    const live = new FakeLive()
    live.seed('canvas-a', spatialDoc(['n1', 'n2']), 'markdown')
    live.seed('canvas-b', spatialDoc(['old']), 'spatial')
    const result = await run(live, versionsWith({ v1: { doc: spatialDoc(['n1', 'n2']) } }), {
      targetPath: 'canvas-b',
      overwrite: true,
    })
    expect(result).toMatchObject({ kind: 'restored-to-target', targetPath: 'canvas-b' })
    expect(live.stored('canvas-b')?.kind).toBe('markdown')
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
