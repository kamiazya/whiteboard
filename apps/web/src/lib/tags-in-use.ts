/**
 * The workspace's tag vocabulary counted by what carries it
 * ([ADR-0040](../../../docs/contributing/adr/0040-scoped-tags.md) decision
 * 5), as the browser keeper spells the daemon's `GET /document-tags`
 * `inUse`: one row per tag, a scoped tag's key and value beside it, in
 * code-unit order so both keepers answer the same list for the same
 * workspace. The daemon's twin is server-core's `tagsInUse`; this app cannot
 * import that package, and the row shape is the daemon-client contract both
 * are held to.
 */
import { parseScopedTag } from '@kamiazya/whiteboard-model'
import type { TagInUse } from './files-source.js'

export interface TagBearer {
  readonly what: 'document' | 'board' | 'node' | 'edge'
  readonly tags: readonly string[]
}

const COUNTED = { document: 'documents', board: 'boards', node: 'nodes', edge: 'edges' } as const

export function countTagsInUse(bearers: readonly TagBearer[]): TagInUse[] {
  const rows = new Map<string, TagInUse>()
  for (const bearer of bearers) {
    for (const tag of new Set(bearer.tags)) {
      const scoped = parseScopedTag(tag)
      const row = rows.get(tag) ?? {
        tag,
        ...(scoped === undefined ? {} : { key: scoped.key, value: scoped.value }),
        documents: 0,
        boards: 0,
        nodes: 0,
        edges: 0,
      }
      const column = COUNTED[bearer.what]
      rows.set(tag, { ...row, [column]: row[column] + 1 })
    }
  }
  return [...rows.values()].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
}
