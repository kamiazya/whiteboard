import { SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import { expect, it } from 'vitest'
import type { DocumentIndex, WorkspaceEntry } from '../index.js'
import { WorkspaceNotHeldError } from '../index.js'

// The conformance suite's own fixture shape, restated so this file imports
// nothing back from the suite that calls it.
type WithIndex = (
  body: (index: DocumentIndex, seed: (entry: WorkspaceEntry) => Promise<void>) => Promise<void>,
) => Promise<void>

/**
 * `renameWorkspace`'s `heldBy` is a precondition every keeper honours, or a
 * caller relying on it to keep a segment with its holder is relying on
 * nothing. Seeded without a namespace, so a single-person keeper that stores
 * none is held to it too.
 */
export function describeRenameHeldBy(withIndex: WithIndex): void {
  it('renames only while the namespace `heldBy` names holds the workspace', async () => {
    await withIndex(async (index, seedWorkspace) => {
      await seedWorkspace({ workspaceId: 'ws-held', segment: 'held' })

      await expect(
        index.renameWorkspace({ workspaceId: 'ws-held', heldBy: 'someone', segment: 'moved' }),
      ).rejects.toThrow(WorkspaceNotHeldError)
      expect((await index.resolveWorkspace('held'))?.workspaceId).toBe('ws-held')

      const renamed = await index.renameWorkspace({
        workspaceId: 'ws-held',
        heldBy: SINGLE_PERSON_NAMESPACE,
        segment: 'moved',
      })
      expect(renamed.segment).toBe('moved')
    })
  })
}
