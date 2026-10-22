/**
 * Resolving an address runs on every request, so it must cost what the
 * address names, not what the registry holds: a keeper shared by many people
 * keeps every person's workspaces in one registry, and a resolution that read
 * them all would let anyone slow everyone by creating workspaces.
 *
 * Counted rather than timed — the rows the registry hands the index.
 */
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { matchesWorkspaceLookup, type WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { describe, expect, it } from 'vitest'
import { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import type { WorkspaceDocs } from './workspace-docs.js'

const FOREIGN = 500

const refuse = (): Promise<never> => Promise.reject(new Error('not reached by resolution'))
const unusedDocs: WorkspaceDocs = {
  open: refuse,
  create: refuse,
  save: refuse,
  readCursor: refuse,
  catchUp: refuse,
}

describe('resolving a workspace address over a large registry', () => {
  it('reads a bounded number of registry rows', async () => {
    const mine: WorkspaceEntry = { workspaceId: generateDocumentId(), segment: 'design' }
    const rows: WorkspaceEntry[] = [
      ...Array.from({ length: FOREIGN }, (_, i) => ({
        workspaceId: generateDocumentId(),
        namespace: 'stranger',
        segment: `w${i}`,
      })),
      mine,
    ]
    const read = { rows: 0 }
    const index = new LoroWorkspaceDocumentIndex(
      unusedDocs,
      { put: refuse, get: refuse, has: refuse, delete: refuse },
      {
        async listWorkspaces() {
          read.rows += rows.length
          return rows
        },
        async findWorkspace(lookup) {
          const found = rows.find((row) => matchesWorkspaceLookup(row, lookup)) ?? null
          if (found !== null) read.rows += 1
          return found
        },
        renameWorkspace: refuse,
      },
    )

    // The subject is present: each form resolves to the row it names.
    expect(await index.resolveWorkspace('design')).toEqual(mine)
    expect(await index.resolveWorkspace(mine.workspaceId, 'stranger')).toEqual(mine)
    expect(await index.resolveWorkspace('stranger/w7', 'me')).toMatchObject({ segment: 'w7' })
    expect(await index.resolveWorkspace('absent')).toBeNull()
    expect(read.rows).toBeLessThanOrEqual(4)
  })
})
