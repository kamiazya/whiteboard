/**
 * The `describeDocumentIndexConformance` cases about INPUT the model refuses:
 * what every keeper must refuse to store, and what it must still read when a
 * row was stored before it refused it. Split from the main suite by size only;
 * it runs as part of that suite and is not called on its own.
 */
import { DOCUMENT_NAME_MAX_LENGTH } from '@kamiazya/whiteboard-model'
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
  describeBoundedDocumentName(withIndex, ws)
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
 * A document's display name past `DOCUMENT_NAME_MAX_LENGTH`. Refused by the
 * keeper itself rather than only at the request edges, because the keeper is
 * the one place every writer — a dialog, a tool, a frontmatter `title` —
 * passes through, so an edge that forgets the bound cannot store a name
 * every listing would then carry.
 */
const OVER_BOUND_NAME = 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1)
const AT_BOUND_NAME = 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH)
// A second name at the bound: two siblings may not show one name.
const OTHER_AT_BOUND_NAME = 'm'.repeat(DOCUMENT_NAME_MAX_LENGTH)

function describeBoundedDocumentName(withIndex: WithIndex, WS: string): void {
  describe('a document name past the bound', () => {
    describeRefusedDocumentName(withIndex, WS)
    describeDocumentNameAtBound(withIndex, WS)
  })
}

function describeRefusedDocumentName(withIndex: WithIndex, WS: string): void {
  it('is refused on create, and nothing is created', async () => {
    await withIndex(async (index) => {
      await expect(
        index.createDocument({
          workspaceId: WS,
          path: 'long',
          kind: 'spatial',
          name: OVER_BOUND_NAME,
        }),
      ).rejects.toMatchObject({ name: 'ZodError' })
      expect(await index.listDocuments({ workspaceId: WS })).toEqual([])
    })
  })

  it('is refused on rename, and the name stays as it was', async () => {
    await withIndex(async (index) => {
      const { documentId } = await index.createDocument({
        workspaceId: WS,
        path: 'kept',
        kind: 'spatial',
        name: 'Kept',
      })
      await expect(
        index.setDocumentName({ workspaceId: WS, documentId, name: OVER_BOUND_NAME }),
      ).rejects.toMatchObject({ name: 'ZodError' })
      expect((await index.resolveDocumentById({ workspaceId: WS, documentId }))?.name).toBe('Kept')
    })
  })
}

function describeDocumentNameAtBound(withIndex: WithIndex, WS: string): void {
  it('is taken at exactly the bound, on create and on rename', async () => {
    await withIndex(async (index) => {
      const created = await index.createDocument({
        workspaceId: WS,
        path: 'at-bound',
        kind: 'spatial',
        name: AT_BOUND_NAME,
      })
      expect(created.name).toBe(AT_BOUND_NAME)
      const { documentId } = await index.createDocument({
        workspaceId: WS,
        path: 'renamed',
        kind: 'markdown',
      })
      await index.setDocumentName({ workspaceId: WS, documentId, name: OTHER_AT_BOUND_NAME })
      expect((await index.resolveDocumentById({ workspaceId: WS, documentId }))?.name).toBe(
        OTHER_AT_BOUND_NAME,
      )
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

/** A canonical id per refused layer, so only the layer can be what refuses the create. */
function refusedWorkspaceId(n: number): string {
  return `01ARZ3NDEKTSV4RRFFQ69G5FA${n}`
}

function describeRefusedWorkspaceIdentity(withIndex: WithIndex): void {
  describe('a workspace identity the model refuses', () => {
    it('is refused on create, and no workspace appears', async () => {
      await withIndex(async (index) => {
        for (const [n, layers] of REFUSED_LAYERS.entries()) {
          await expect(
            index.createWorkspace({ workspaceId: refusedWorkspaceId(n), ...layers }),
          ).rejects.toMatchObject({ name: 'ZodError' })
        }
        const rows = await index.listWorkspaces()
        const refused = new Set(REFUSED_LAYERS.map((_, n) => refusedWorkspaceId(n)))
        expect(rows.some((row) => refused.has(row.workspaceId))).toBe(false)
        for (const row of rows) expect(workspaceEntrySchema.safeParse(row).success).toBe(true)
      })
    })

    it('is refused on rename, and the workspace and its siblings stay as they were', async () => {
      await withIndex(async (index, seedWorkspace) => {
        await seedWorkspace({
          workspaceId: '01W968V4H3K149VMAVD6W15TEG',
          segment: 'named',
          displayName: 'Named',
        })
        for (const layers of REFUSED_LAYERS) {
          await expect(
            index.renameWorkspace({ workspaceId: '01W968V4H3K149VMAVD6W15TEG', ...layers }),
          ).rejects.toMatchObject({ name: 'ZodError' })
        }
        expect(await index.resolveWorkspace('named')).toMatchObject({
          workspaceId: '01W968V4H3K149VMAVD6W15TEG',
          displayName: 'Named',
        })
        const rows = await index.listWorkspaces()
        expect(rows.map((row) => row.workspaceId)).toContain('0175T8F2WH2MX756J1T7SHKGB8')
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
          workspaceId: '015TAGD8CN1TY1PFFPMS8WVDEY',
          segment: 'my team',
          displayName: 'n'.repeat(201),
        })

        const rows = await index.listWorkspaces()
        for (const row of rows) expect(workspaceEntrySchema.safeParse(row).success).toBe(true)
        expect(rows.find((row) => row.workspaceId === '015TAGD8CN1TY1PFFPMS8WVDEY')).toEqual({
          workspaceId: '015TAGD8CN1TY1PFFPMS8WVDEY',
        })
        expect((await index.resolveWorkspace('0175T8F2WH2MX756J1T7SHKGB8'))?.workspaceId).toBe(
          '0175T8F2WH2MX756J1T7SHKGB8',
        )
        expect(await index.resolveWorkspace('my team')).toBeNull()

        await index.renameWorkspace({
          workspaceId: '015TAGD8CN1TY1PFFPMS8WVDEY',
          segment: 'my-team',
          displayName: 'My team',
        })
        expect(await index.resolveWorkspace('my-team')).toEqual({
          workspaceId: '015TAGD8CN1TY1PFFPMS8WVDEY',
          segment: 'my-team',
          displayName: 'My team',
        })
      })
    })
  })
}
