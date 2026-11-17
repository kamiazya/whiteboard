import { expect, it } from 'vitest'
import type { DocumentIndex, WorkspaceEntry } from '../index.js'
import {
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
} from '../index.js'

// The conformance suite's own fixture shape, restated so this file imports
// nothing back from the suite that calls it.
type WithIndex = (
  body: (index: DocumentIndex, seed: (entry: WorkspaceEntry) => Promise<void>) => Promise<void>,
) => Promise<void>

/**
 * The moves an index REFUSES, and which refusal it names. Every keeper answers
 * the same one, in the same order — not-found before into-self before taken —
 * or a caller mapping the error to a status code gets a different answer per
 * keeper for the same request.
 */
export function describeMoveRefusals(withIndex: WithIndex, WS: string): void {
  describeRefusalOrder(withIndex, WS)
  describeFolderCollisions(withIndex, WS)
}

function describeRefusalOrder(withIndex: WithIndex, WS: string): void {
  it('refuses a move into the moving subtree', async () => {
    await withIndex(async (index) => {
      await index.createDocument({ workspaceId: WS, path: 'a', kind: 'spatial' })
      await index.createDocument({ workspaceId: WS, path: 'a/x', kind: 'spatial' })

      await expect(index.moveDocument({ workspaceId: WS, from: 'a', to: 'a/b' })).rejects.toThrow(
        DocumentMoveIntoSelfError,
      )

      expect(await index.resolveDocument({ workspaceId: WS, path: 'a' })).not.toBeNull()
      expect(await index.resolveDocument({ workspaceId: WS, path: 'a/x' })).not.toBeNull()
    })
  })

  it('refuses to move a path that names nothing', async () => {
    await withIndex(async (index) => {
      await expect(
        index.moveDocument({ workspaceId: WS, from: 'absent', to: 'somewhere' }),
      ).rejects.toThrow(DocumentNotFoundError)
    })
  })

  it('answers not-found, not move-into-self, for an absent path moved under itself', async () => {
    await withIndex(async (index) => {
      // Nothing is there to move, so whether `to` sits under it is moot.
      await expect(
        index.moveDocument({ workspaceId: WS, from: 'absent', to: 'absent/inner' }),
      ).rejects.toThrow(DocumentNotFoundError)
    })
  })

  it('refuses to move a document up onto a folder a sibling still holds', async () => {
    await withIndex(async (index) => {
      // `a/b` -> `a` vacates `a` only when everything under it is leaving;
      // `a/c` stays, so the folder stays, and the move would land on it.
      await index.createDocument({ workspaceId: WS, path: 'a/b', kind: 'spatial' })
      await index.createDocument({ workspaceId: WS, path: 'a/c', kind: 'spatial' })

      await expectTakenAt(index.moveDocument({ workspaceId: WS, from: 'a/b', to: 'a' }), 'a')
    })
  })
}

function describeFolderCollisions(withIndex: WithIndex, WS: string): void {
  // A FOLDER is a path that only prefixes other documents. A tree holds it as
  // a node, so a move cannot land a second node on it: these three are where
  // a row-backed double, which has nothing at that path, used to say yes.
  it('refuses to move a document onto a path only a folder holds', async () => {
    await withIndex(async (index) => {
      await index.createDocument({ workspaceId: WS, path: 'x', kind: 'spatial' })
      await index.createDocument({ workspaceId: WS, path: 'f/kept', kind: 'spatial' })

      await expectTakenAt(index.moveDocument({ workspaceId: WS, from: 'x', to: 'f' }), 'f')

      expect((await index.listDocuments({ workspaceId: WS })).map((e) => e.path)).toEqual([
        'f/kept',
        'x',
      ])
    })
  })

  it('refuses to rename a folder onto a path a document holds', async () => {
    await withIndex(async (index) => {
      await index.createDocument({ workspaceId: WS, path: 'f/x', kind: 'spatial' })
      await index.createDocument({ workspaceId: WS, path: 'd', kind: 'spatial' })

      await expectTakenAt(index.moveDocument({ workspaceId: WS, from: 'f', to: 'd' }), 'd')

      expect((await index.listDocuments({ workspaceId: WS })).map((e) => e.path)).toEqual([
        'd',
        'f/x',
      ])
    })
  })

  it('refuses to rename a folder onto another folder, rather than merging the two', async () => {
    await withIndex(async (index) => {
      await index.createDocument({ workspaceId: WS, path: 'f/x', kind: 'spatial' })
      await index.createDocument({ workspaceId: WS, path: 'g/y', kind: 'spatial' })

      await expectTakenAt(index.moveDocument({ workspaceId: WS, from: 'f', to: 'g' }), 'g')

      expect((await index.listDocuments({ workspaceId: WS })).map((e) => e.path)).toEqual([
        'f/x',
        'g/y',
      ])
    })
  })
}

/** The named refusal, and the path it names — "something threw" would pass a store whose unique index throws anyway. */
async function expectTakenAt(move: Promise<void>, path: string): Promise<void> {
  const rejection = await move.then(
    () => null,
    (err: unknown) => err,
  )
  expect(rejection).toBeInstanceOf(DocumentPathTakenError)
  expect((rejection as DocumentPathTakenError).path).toBe(path)
}
