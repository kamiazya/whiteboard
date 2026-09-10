import type { VersionEntry, VersionHistory } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'

/**
 * A `VersionHistory` that keeps its rows in a Map, for a harness that
 * drives the real tools through a real McpServer and needs the version
 * verbs to WORK rather than to be observed. Without one, `wb_version_save`
 * reaches `deps.versions.save` on `undefined` and answers a tool error —
 * which the errand scoreboard counted as one cheap call for a week, since
 * a refusal is still a call. See `mcp-errand-corpus.ts`'s `call`.
 */
export class InMemoryVersionHistory implements VersionHistory {
  private readonly rows = new Map<string, { entry: VersionEntry; snapshot: Uint8Array }>()
  private next = 0

  async save(
    _workspaceId: string,
    path: string,
    doc: LoroDoc,
    options: Parameters<VersionHistory['save']>[3],
  ): Promise<VersionEntry> {
    this.next += 1
    const entry: VersionEntry = {
      id: `v${this.next}`,
      path,
      createdAt: new Date(this.next * 1000).toISOString(),
      elementCount: 0,
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
