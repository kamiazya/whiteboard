import type { RecordView } from '@kamiazya/whiteboard-loro-adapter'
import { countSpatialNodes } from '@kamiazya/whiteboard-loro-adapter'
import { compareCodeUnit } from '@kamiazya/whiteboard-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import type { AdoptedVersion, VersionHistory } from '../server-deps.js'
import type { VersionEntry } from '../versions/version-entry.js'
import { TooManyVersionsError } from '../versions/version-refusal.js'
import type { FakeDocumentStore } from './fake-document-store.js'

/**
 * The history as the tools see it: rows keyed by path, each holding a
 * snapshot of the doc as it was saved. Records every `save` call so a test
 * can assert what the tool asked for, not only what came back.
 *
 * The one fake of this port, for harnesses that drive the real tools and need
 * the version verbs to WORK rather than to be observed: without a history,
 * `wb_version_save` reaches `deps.versions.save` on `undefined` and answers a
 * tool error, which an errand scoreboard counts as one cheap call. A row
 * carries what the store would — the element count of the document as STORED
 * — so an assertion about a saved version means the same against either.
 * Given the document store the tools write to, the fake reads the stored
 * document the way a keeper reads its record; given none, every document it is
 * asked about is empty.
 */
export class FakeVersionHistory implements VersionHistory {
  readonly saves: { path: string; options: Parameters<VersionHistory['save']>[2] }[] = []
  /** Rows another keeper saved, by id — a second adopt of one id keeps the first. */
  readonly adopted = new Map<string, AdoptedVersion>()
  private readonly rows = new Map<string, { entry: VersionEntry; snapshot: Uint8Array }>()
  private next = 0

  constructor(private readonly store?: FakeDocumentStore) {}

  /** The document at `path` as the store holds it, empty when nothing is stored. */
  private async storedAt(workspaceId: string, path: string): Promise<LoroDoc> {
    const doc = new LoroDoc()
    const entry = await this.store?.documentIndex.resolveDocument({ workspaceId, path })
    const saved =
      entry === null || entry === undefined
        ? null
        : await this.store?.loadSnapshot({
            docRef: { kind: 'document', workspaceId, documentId: entry.documentId },
          })
    if (saved !== null && saved !== undefined) {
      doc.import(reassembleSnapshot(saved.manifest, saved.chunks))
    }
    return doc
  }

  async save(
    workspaceId: string,
    path: string,
    options: Parameters<VersionHistory['save']>[2],
  ): Promise<VersionEntry> {
    const doc = await this.storedAt(workspaceId, path)
    this.saves.push({ path, options })
    this.next += 1
    const entry: VersionEntry = {
      id: `v${this.next}`,
      path,
      createdAt: new Date(this.next * 1000).toISOString(),
      elementCount: countSpatialNodes(doc),
      auto: options.auto,
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.operator === undefined ? {} : { operator: options.operator }),
    }
    this.rows.set(entry.id, { entry, snapshot: doc.export({ mode: 'snapshot' }) })
    return entry
  }
  async saveAll(
    workspaceId: string,
    documents: readonly { documentId: string; path: string }[],
    options: Parameters<VersionHistory['saveAll']>[2],
  ): Promise<readonly string[]> {
    const recorded: string[] = []
    for (const { documentId, path } of documents) {
      try {
        await this.save(workspaceId, path, options)
      } catch (err) {
        if (err instanceof TooManyVersionsError) continue
        throw err
      }
      recorded.push(documentId)
    }
    return recorded
  }
  async load(_workspaceId: string, id: string): Promise<Uint8Array | null> {
    return this.rows.get(id)?.snapshot ?? null
  }
  async loadWorkspaceAt(): Promise<RecordView | null> {
    return null
  }
  async adopt(_workspaceId: string, rows: readonly AdoptedVersion[]): Promise<readonly string[]> {
    for (const row of rows) if (!this.adopted.has(row.id)) this.adopted.set(row.id, row)
    return rows.map((row) => row.id).filter((id) => this.adopted.has(id))
  }
  async list(_workspaceId: string, path: string): Promise<readonly VersionEntry[]> {
    return [...this.rows.values()]
      .map((row) => row.entry)
      .filter((entry) => entry.path === path)
      .sort((a, b) => compareCodeUnit(b.createdAt, a.createdAt))
  }
}
