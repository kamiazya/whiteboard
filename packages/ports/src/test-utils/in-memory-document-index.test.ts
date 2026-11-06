import { describe } from 'vitest'
import { describeDocumentDuplicatesConformance } from './document-duplicates-conformance.js'
import { describeDocumentIndexConformance } from './document-index-conformance.js'
import { describeDocumentPinsConformance } from './document-pins-conformance.js'
import {
  DuplicatingInMemoryDocumentIndex,
  InMemoryDocumentIndex,
} from './in-memory-document-index.js'

// The same suite the sqlite store answers to, run here so the double cannot
// drift from the guarantees while still satisfying the interface.
describe('InMemoryDocumentIndex', () => {
  describeDocumentIndexConformance(async () => {
    const index = new InMemoryDocumentIndex()
    return {
      index,
      dispose: async () => {},
      // Unchecked, unlike `createWorkspace`: the seam stands for whatever a
      // registry already holds, including rows from before a bound.
      seedWorkspace: async (entry) => index.seedWorkspace(entry),
    }
  })
})

describe('InMemoryDocumentIndex pins', () => {
  describeDocumentPinsConformance(async () => ({
    index: new InMemoryDocumentIndex(),
    dispose: async () => {},
  }))
})

describe('DuplicatingInMemoryDocumentIndex', () => {
  describeDocumentDuplicatesConformance(async () => {
    const markers = new Map<string, string>()
    const threads = new Map<string, readonly string[]>()
    const index = new DuplicatingInMemoryDocumentIndex({
      copy: (from, to, { withoutAnnotations }) => {
        const marker = markers.get(from)
        if (marker !== undefined) markers.set(to, marker)
        const held = threads.get(from)
        if (held !== undefined && !withoutAnnotations) threads.set(to, held)
      },
    })
    const idAt = async (workspaceId: string, path: string): Promise<string> => {
      const entry = await index.resolveDocument({ workspaceId, path })
      if (entry === null) throw new Error(`no document at ${path}`)
      return entry.documentId
    }
    return {
      index,
      content: {
        write: async (workspaceId, path, marker) => {
          markers.set(await idAt(workspaceId, path), marker)
        },
        read: async (workspaceId, path) => markers.get(await idAt(workspaceId, path)) ?? '',
        comment: async (workspaceId, path, threadId) => {
          const id = await idAt(workspaceId, path)
          threads.set(id, [...(threads.get(id) ?? []), threadId])
        },
        threadIds: async (workspaceId, path) =>
          [...(threads.get(await idAt(workspaceId, path)) ?? [])].sort(),
      },
      dispose: async () => {},
    }
  })
})
