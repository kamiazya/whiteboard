/**
 * The `describeDocumentIndexConformance` cases about INPUT the model refuses:
 * what every keeper must refuse to store, and what it must still read when a
 * row was stored before it refused it. Split from the main suite by size only;
 * it runs as part of that suite and is not called on its own.
 */
import { describe, expect, it } from 'vitest'
import type { DocumentIndex, WorkspaceEntry } from '../index.js'
import { documentEntrySchema, workspaceEntrySchema } from '../index.js'

type WithIndex = (
  body: (
    index: DocumentIndex,
    seedWorkspace: (entry: WorkspaceEntry) => Promise<void>,
  ) => Promise<void>,
) => Promise<void>

/** The suite's input cases, over the main suite's fixture and its workspace `ws`. */
export function describeRefusedInput(withIndex: WithIndex, ws: string): void {
  describeOffGrammarPaths(withIndex, ws)
  describeRefusedWorkspaceIdentity(withIndex)
  describePreBoundWorkspaceRow(withIndex)
}

/**
 * Paths the model's grammar refuses — a space, a non-ASCII letter, an empty
 * or relative segment, one past the length bound. Every keeper refuses them
 * on WRITE, because a listing hydrates every entry through
 * `documentEntrySchema`: one stored off-grammar path made the whole
 * workspace's list and search unreadable, not merely that document.
 */
const OFF_GRAMMAR_PATHS = ['my doc', 'Notes/\u00c4', '../up', 'a//b', 'a'.repeat(1025)]

function describeOffGrammarPaths(withIndex: WithIndex, WS: string): void {
  describe('a path the model refuses', () => {
    it('is refused on create, and nothing is created', async () => {
      await withIndex(async (index) => {
        for (const path of OFF_GRAMMAR_PATHS) {
          await expect(
            index.createDocument({ workspaceId: WS, path, kind: 'spatial' }),
          ).rejects.toMatchObject({ name: 'ZodError' })
        }
        expect(await index.listDocuments({ workspaceId: WS })).toEqual([])
      })
    })

    it('is refused as a move destination, and the document stays where it was', async () => {
      await withIndex(async (index) => {
        await index.createDocument({ workspaceId: WS, path: 'plan', kind: 'spatial' })
        for (const to of OFF_GRAMMAR_PATHS) {
          await expect(
            index.moveDocument({ workspaceId: WS, from: 'plan', to }),
          ).rejects.toMatchObject({ name: 'ZodError' })
        }
        const listed = await index.listDocuments({ workspaceId: WS })
        expect(listed.map((entry) => entry.path)).toEqual(['plan'])
        for (const entry of listed) expect(documentEntrySchema.safeParse(entry).success).toBe(true)
      })
    })
  })
}

/**
 * One identity layer at a time, each a value `createWorkspaceInputSchema` /
 * `renameWorkspaceInputSchema` refuse. The ULID-shaped segment is lowercase
 * because the model's refusal is case-insensitive, and an implementation
 * checking only the uppercase spelling would let it through.
 */
const REFUSED_LAYERS: ReadonlyArray<{ segment?: string; displayName?: string }> = [
  { segment: 'my team' },
  { segment: 'Team_2' },
  { segment: '01arz3ndektsv4rrffq69g5fav' },
  { segment: 's'.repeat(201) },
  { displayName: 'n'.repeat(201) },
  { displayName: ' padded ' },
]

function describeRefusedWorkspaceIdentity(withIndex: WithIndex): void {
  describe('a workspace identity the model refuses', () => {
    it('is refused on create, and no workspace appears', async () => {
      await withIndex(async (index) => {
        for (const [n, layers] of REFUSED_LAYERS.entries()) {
          await expect(
            index.createWorkspace({ workspaceId: `ws-refused-${n}`, ...layers }),
          ).rejects.toMatchObject({ name: 'ZodError' })
        }
        const rows = await index.listWorkspaces()
        expect(rows.some((row) => row.workspaceId.startsWith('ws-refused-'))).toBe(false)
        for (const row of rows) expect(workspaceEntrySchema.safeParse(row).success).toBe(true)
      })
    })

    it('is refused on rename, and the workspace and its siblings stay as they were', async () => {
      await withIndex(async (index, seedWorkspace) => {
        await seedWorkspace({ workspaceId: 'ws-named', segment: 'named', displayName: 'Named' })
        for (const layers of REFUSED_LAYERS) {
          await expect(
            index.renameWorkspace({ workspaceId: 'ws-named', ...layers }),
          ).rejects.toMatchObject({ name: 'ZodError' })
        }
        expect(await index.resolveWorkspace('named')).toMatchObject({
          workspaceId: 'ws-named',
          displayName: 'Named',
        })
        const rows = await index.listWorkspaces()
        expect(rows.map((row) => row.workspaceId)).toContain('ws-other')
        for (const row of rows) expect(workspaceEntrySchema.safeParse(row).success).toBe(true)
      })
    })
  })
}

/**
 * A row a keeper stored before the bounds existed, or through a writer that
 * did not check them. The read must not refuse it: a strict parse of the
 * whole registry turned one such row into a switcher with nothing in it and
 * no rename left to repair it with. A refused layer reads as ABSENT — the
 * workspace is reached by its canonical id until it is renamed — so every row
 * still answers to `workspaceEntrySchema`, and a refused segment can never
 * shadow another workspace's address.
 */
function describePreBoundWorkspaceRow(withIndex: WithIndex): void {
  describe('a workspace row stored before the identity bounds', () => {
    it('still lists, with its refused layers read as absent, and can be renamed', async () => {
      await withIndex(async (index, seedWorkspace) => {
        await seedWorkspace({
          workspaceId: 'ws-pre-bound',
          segment: 'my team',
          displayName: 'n'.repeat(201),
        })

        const rows = await index.listWorkspaces()
        for (const row of rows) expect(workspaceEntrySchema.safeParse(row).success).toBe(true)
        expect(rows.find((row) => row.workspaceId === 'ws-pre-bound')).toEqual({
          workspaceId: 'ws-pre-bound',
        })
        expect((await index.resolveWorkspace('ws-other'))?.workspaceId).toBe('ws-other')
        expect(await index.resolveWorkspace('my team')).toBeNull()

        await index.renameWorkspace({
          workspaceId: 'ws-pre-bound',
          segment: 'my-team',
          displayName: 'My team',
        })
        expect(await index.resolveWorkspace('my-team')).toEqual({
          workspaceId: 'ws-pre-bound',
          segment: 'my-team',
          displayName: 'My team',
        })
      })
    })
  })
}
