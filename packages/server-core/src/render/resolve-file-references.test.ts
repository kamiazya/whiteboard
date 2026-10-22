import type { WorkspaceId } from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { createReferencedDocumentLoader } from './resolve-file-references.js'

const workspaceId = 'ws' as WorkspaceId
const slow = { documentId: 'doc-slow', path: 'slow', kind: 'markdown' } as DocumentEntry

describe('createReferencedDocumentLoader', () => {
  // Reads run one at a time while lookups start at once, so a lookup can
  // reject while the read ahead of it is still pending. That rejection has to
  // reach the caller of its own turn, and nothing else: a rejection nobody is
  // listening to yet is an unhandled rejection, which fails a vitest run and
  // can end a Node process.
  it('hands a lookup that fails during an earlier read to its own caller, unhandled by nobody', async () => {
    let releaseRead!: () => void
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const deps = {
      documentIndex: {
        resolveDocumentById: async () => null,
        resolveDocument: async ({ path }: { path: string }) => {
          if (path === 'broken') throw new Error('index unavailable')
          return slow
        },
      },
      documentStore: {
        loadSnapshot: async () => {
          await readHeld
          return null
        },
      },
    } as unknown as ServerDeps
    const load = createReferencedDocumentLoader(deps, workspaceId)

    const first = load('slow')
    const second = load('broken')
    // A macrotask boundary: where Node decides a rejection went unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseRead()

    await expect(first).resolves.toEqual({ documentId: 'doc-slow', name: 'slow' })
    await expect(second).rejects.toThrow('index unavailable')
  })
})
