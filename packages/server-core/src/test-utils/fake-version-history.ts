import { readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import type { VersionHistory } from '../server-deps.js'
import type { VersionEntry } from '../versions/version-entry.js'

/**
 * The history as the tools see it: rows keyed by path, each holding a
 * snapshot of the doc as it was saved. Records every `save` call so a test
 * can assert what the tool asked for, not only what came back.
 */
export class FakeVersionHistory implements VersionHistory {
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
