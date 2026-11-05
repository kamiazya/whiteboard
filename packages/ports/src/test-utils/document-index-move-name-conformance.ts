import { describe, expect, it } from 'vitest'
import type { DocumentFolders, DocumentIndex } from '../index.js'
import { DisplayNameTakenError } from '../index.js'

type WithIndex<I extends DocumentIndex> = (body: (index: I) => Promise<void>) => Promise<void>

const create = (index: DocumentIndex, workspaceId: string, path: string, name?: string) =>
  index.createDocument({
    workspaceId,
    path,
    kind: 'markdown',
    ...(name === undefined ? {} : { name }),
  })

const paths = async (index: DocumentIndex, workspaceId: string) =>
  (await index.listDocuments({ workspaceId })).map((entry) => entry.path)

/**
 * A move is held to the same duplicate-name rule a create and a rename are:
 * the document that lands in a folder cannot show the name a sibling document
 * there already shows. A document shows its name or, unnamed, the segment it
 * lands at — so a path change alone can make a duplicate.
 */
export function describeMoveDocumentName(
  withIndex: WithIndex<DocumentIndex>,
  workspaceId: string,
): void {
  describe('a document moved where a sibling already shows its name', () => {
    it('is refused, and stays where it was', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'week/plan', 'Plan')
        await create(index, workspaceId, 'month/other', 'plan')

        await expect(
          index.moveDocument({ workspaceId, from: 'month/other', to: 'week/other' }),
        ).rejects.toThrow(DisplayNameTakenError)
        expect(await paths(index, workspaceId)).toEqual(['month/other', 'week/plan'])
      })
    })

    it('is refused when it is unnamed and the segment it lands at is the sibling name', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'week/plan', 'Plan')
        await create(index, workspaceId, 'month/x')

        await expect(
          index.moveDocument({ workspaceId, from: 'month/x', to: 'week/PLAN' }),
        ).rejects.toThrow(DisplayNameTakenError)
        await expect(
          index.moveDocument({ workspaceId, from: 'month/x', to: 'week/plan-b' }),
        ).resolves.toBeUndefined()
      })
    })

    it('is refused for an unnamed sibling that shows the same segment elsewhere in the name', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'week/plan')
        await create(index, workspaceId, 'month/other', 'Plan')
        await expect(
          index.moveDocument({ workspaceId, from: 'month/other', to: 'week/other' }),
        ).rejects.toThrow(DisplayNameTakenError)
      })
    })

    describeMoveKeepsName(withIndex, workspaceId)
  })
}

function describeMoveKeepsName(withIndex: WithIndex<DocumentIndex>, workspaceId: string): void {
  describe('a document move that shows no name a sibling shows', () => {
    it('is no duplicate for a rename in place that keeps the name it shows', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'week/plan', 'Plan')
        await create(index, workspaceId, 'week/other', 'Other')
        await index.moveDocument({ workspaceId, from: 'week/other', to: 'week/other-2' })
        expect(await paths(index, workspaceId)).toEqual(['week/other-2', 'week/plan'])
      })
    })

    it('is no duplicate in a folder that holds no such name', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'week/plan', 'Plan')
        await create(index, workspaceId, 'month/plan', 'Plan')
        await index.moveDocument({ workspaceId, from: 'month/plan', to: 'year/plan' })
        expect(await paths(index, workspaceId)).toEqual(['week/plan', 'year/plan'])
      })
    })
  })
}

/**
 * The same refusal for a folder: a folder landing under a parent that has a
 * folder showing its name is refused. Folders and documents are compared
 * separately.
 */
export function describeMoveFolderName(
  withIndex: WithIndex<DocumentIndex & DocumentFolders>,
  workspaceId: string,
): void {
  describe('a folder moved where a sibling folder already shows its name', () => {
    it('is refused, and stays where it was', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'term/week-6/x')
        await create(index, workspaceId, 'old/w6/x')
        await index.setFolderName({ workspaceId, path: 'term/week-6', name: 'Week 6' })
        await index.setFolderName({ workspaceId, path: 'old/w6', name: 'week 6' })

        await expect(
          index.moveDocument({ workspaceId, from: 'old/w6', to: 'term/w6' }),
        ).rejects.toThrow(DisplayNameTakenError)
        expect(await paths(index, workspaceId)).toEqual(['old/w6/x', 'term/week-6/x'])
      })
    })

    it('is refused when an unnamed sibling folder shows the name as its segment', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'term/notes/x')
        await create(index, workspaceId, 'old/w/x')
        await index.setFolderName({ workspaceId, path: 'old/w', name: 'Notes' })
        await expect(
          index.moveDocument({ workspaceId, from: 'old/w', to: 'term/w' }),
        ).rejects.toThrow(DisplayNameTakenError)
      })
    })

    it('is no duplicate beside a document of that name', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'term/plan', 'Plan')
        await create(index, workspaceId, 'old/w/x')
        await index.setFolderName({ workspaceId, path: 'old/w', name: 'Plan' })
        await index.moveDocument({ workspaceId, from: 'old/w', to: 'term/w' })
        expect(await paths(index, workspaceId)).toContain('term/w/x')
      })
    })
  })
}

/**
 * A document created WITHOUT a name shows the segment it is addressed by. When
 * that would read the same as a sibling's name, the create takes the next free
 * address instead of refusing: no name was chosen, so nothing was said that
 * could be corrected.
 */
export function describeUnnamedCreate(
  withIndex: WithIndex<DocumentIndex>,
  workspaceId: string,
): void {
  describe('an unnamed document whose address would read as a sibling name', () => {
    it('takes the next free address', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'week/other', 'Plan')
        const created = await create(index, workspaceId, 'week/plan')
        expect(created.path).toBe('week/plan-2')
        expect(
          (await index.resolveDocument({ workspaceId, path: 'week/plan-2' }))?.documentId,
        ).toBe(created.documentId)
      })
    })

    it('skips an address that is taken or that reads as a sibling too', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'week/other', 'Plan')
        await create(index, workspaceId, 'week/plan-2')
        await create(index, workspaceId, 'week/third', 'plan-3')
        expect((await create(index, workspaceId, 'week/plan')).path).toBe('week/plan-4')
      })
    })

    it('keeps the address when nothing shows its label', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'week/other', 'Plan')
        expect((await create(index, workspaceId, 'month/plan')).path).toBe('month/plan')
        expect((await create(index, workspaceId, 'week/notes')).path).toBe('week/notes')
      })
    })

    it('still reports a taken address as taken', async () => {
      await withIndex(async (index) => {
        await create(index, workspaceId, 'week/plan')
        await expect(create(index, workspaceId, 'week/plan')).rejects.toThrow()
        expect(await paths(index, workspaceId)).toEqual(['week/plan'])
      })
    })
  })
}
