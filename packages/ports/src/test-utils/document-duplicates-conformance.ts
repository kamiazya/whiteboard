import { describe, expect, it } from 'vitest'
import type { DocumentDuplicates, DocumentIndex } from '../index.js'
import { DocumentNotFoundError, WorkspaceNotFoundError } from '../index.js'

type DuplicatingIndex = DocumentIndex & DocumentDuplicates

/**
 * A document's CONTENT, which this package cannot read: the port is about
 * placement, so the keeper under test supplies how a marker is written into a
 * document and read back. REQUIRED, not optional — a duplicate that placed an
 * empty copy correctly would pass every placement case.
 */
interface ContentSeam {
  write(workspaceId: string, path: string, marker: string): Promise<void>
  read(workspaceId: string, path: string): Promise<string>
}

type MakeDuplicatingIndex = () => Promise<{
  index: DuplicatingIndex
  content: ContentSeam
  dispose: () => Promise<void>
}>

type WithIndex = (
  body: (index: DuplicatingIndex, content: ContentSeam) => Promise<void>,
) => Promise<void>

const WS = 'ws-duplicate-conformance'

async function roadmap(index: DuplicatingIndex, content: ContentSeam): Promise<string> {
  const { documentId } = await index.createDocument({
    workspaceId: WS,
    path: 'notes/roadmap',
    kind: 'markdown',
    name: 'Roadmap',
  })
  await content.write(WS, 'notes/roadmap', 'ship it')
  return documentId
}

/**
 * What `DocumentDuplicates` promises, for every keeper: a copy lands BESIDE
 * its source, named after it, holding what it held — the same answer whoever
 * keeps the workspace.
 */
export function describeDocumentDuplicatesConformance(makeIndex: MakeDuplicatingIndex): void {
  const withIndex: WithIndex = async (body) => {
    const { index, content, dispose } = await makeIndex()
    try {
      await index.createWorkspace({ workspaceId: WS })
      await body(index, content)
    } finally {
      await dispose()
    }
  }

  describe('DocumentDuplicates', () => {
    it('puts the copy beside a source in a folder, named after it, holding its content', async () => {
      await withIndex(async (index, content) => {
        const sourceId = await roadmap(index, content)

        const copy = await index.duplicateDocument({ workspaceId: WS, path: 'notes/roadmap' })

        expect(copy).toMatchObject({ path: 'notes/roadmap-copy', name: 'Roadmap (copy)' })
        expect(copy.kind).toBe('markdown')
        expect(copy.documentId).not.toBe(sourceId)
        await expect(content.read(WS, 'notes/roadmap-copy')).resolves.toBe('ship it')
        await expect(
          index.resolveDocument({ workspaceId: WS, path: 'notes/roadmap-copy' }),
        ).resolves.toMatchObject({ documentId: copy.documentId, name: 'Roadmap (copy)' })
      })
    })

    describeNumbering(withIndex)
    describeSource(withIndex)
    describeRefusals(withIndex)
  })
}

/** A copy is numbered past the ones already there, even when two are made at once. */
function describeNumbering(withIndex: WithIndex): void {
  it('numbers a second copy past the first', async () => {
    await withIndex(async (index, content) => {
      await roadmap(index, content)
      await index.duplicateDocument({ workspaceId: WS, path: 'notes/roadmap' })

      const second = await index.duplicateDocument({ workspaceId: WS, path: 'notes/roadmap' })

      expect(second).toMatchObject({ path: 'notes/roadmap-copy-2', name: 'Roadmap (copy 2)' })
    })
  })

  it('lands two duplicates started together on two paths', async () => {
    await withIndex(async (index, content) => {
      await roadmap(index, content)

      const copies = await Promise.all([
        index.duplicateDocument({ workspaceId: WS, path: 'notes/roadmap' }),
        index.duplicateDocument({ workspaceId: WS, path: 'notes/roadmap' }),
      ])

      expect(copies.map((copy) => copy.path).sort()).toEqual([
        'notes/roadmap-copy',
        'notes/roadmap-copy-2',
      ])
    })
  })
}

/** What the copy is named after, and what it holds. */
function describeSource(withIndex: WithIndex): void {
  it('names the copy of an unnamed source after the path it shows', async () => {
    await withIndex(async (index) => {
      await index.createDocument({ workspaceId: WS, path: 'plan', kind: 'spatial' })

      const copy = await index.duplicateDocument({ workspaceId: WS, path: 'plan' })

      expect(copy).toMatchObject({ path: 'plan-copy', name: 'plan (copy)', kind: 'spatial' })
    })
  })

  it('copies once: a later edit to the source leaves the copy as it was', async () => {
    await withIndex(async (index, content) => {
      await roadmap(index, content)
      await index.duplicateDocument({ workspaceId: WS, path: 'notes/roadmap' })

      await content.write(WS, 'notes/roadmap', 'changed afterwards')

      await expect(content.read(WS, 'notes/roadmap-copy')).resolves.toBe('ship it')
    })
  })
}

function describeRefusals(withIndex: WithIndex): void {
  it('refuses a path no document holds, and makes nothing', async () => {
    await withIndex(async (index) => {
      await expect(
        index.duplicateDocument({ workspaceId: WS, path: 'notes/gone' }),
      ).rejects.toThrow(DocumentNotFoundError)
      await expect(index.listDocuments({ workspaceId: WS })).resolves.toEqual([])
    })
  })

  it('refuses a workspace the index does not hold', async () => {
    await withIndex(async (index) => {
      await expect(
        index.duplicateDocument({ workspaceId: 'ws-nobody', path: 'notes/roadmap' }),
      ).rejects.toThrow(WorkspaceNotFoundError)
    })
  })
}
