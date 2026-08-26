/**
 * The dual-plane listing parity scoreboard (dual-plane collapse S5a).
 *
 * The INSTRUMENT for S5b's read flip: `DualPlaneDocumentIndex` currently
 * answers reads from the `documents` table while mirroring mutations into
 * the workspace tree. Flipping the reads to the tree is only safe if the
 * two planes agree after ANY sequence of production writes — so this
 * generates random command sequences over the real writers (index
 * mutations, the route save path, the pin path) and asserts, after every
 * step, that the row listing and the tree listing are the same listing.
 *
 * Model-based on purpose: an example test would pin the arrangements we
 * thought of, and the divergence S5b would ship is by definition the one
 * we did not.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterAll, beforeAll, describe, expect, vi } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument, cacheBackedWorkspaceDocs } = await import('./document-store.js')
const { DualPlaneDocumentIndex } = await import('./workspace-plane.js')
const { SqliteDocumentIndex } = await import('./sqlite-document-index.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')
const { FsBlobStore } = await import('./fs/fs-blob-store.js')
const { setDocumentPinned, loadWorkspaceNames } = await import('./names-store.js')
const { LoroWorkspaceDocumentIndex } = await import('@kamiazya/whiteboard-workspace-index')
const { readPinnedDocumentIds, resolveWorkspaceDocumentById } = await import(
  '@kamiazya/whiteboard-loro-adapter'
)
const { getDataDir } = await import('../config.js')
const portErrors = await import('@kamiazya/whiteboard-ports')
const { DocumentNotFoundError: RowDocumentNotFoundError } = await import('./db/upsert-workspace.js')
const { ConflictError } = await import('./document-store.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'listing-parity-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})
afterAll(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

// Small on purpose: a pool this dense actually produces collisions, nested
// moves, and delete-then-recreate — the arrangements the parity claim is
// about. A sparse generator would pass vacuously (see AGENTS.md's PBT
// rules); the mutation check below is what proves it does not.
const PATHS = ['a', 'b', 'c', 'a/x', 'a/y', 'b/x'] as const

const pathArb = fc.constantFrom(...PATHS)
const commandArb = fc.oneof(
  fc.record({ op: fc.constant('create' as const), path: pathArb }),
  fc.record({ op: fc.constant('save' as const), path: pathArb }),
  fc.record({ op: fc.constant('move' as const), from: pathArb, to: pathArb }),
  fc.record({
    op: fc.constant('name' as const),
    path: pathArb,
    name: fc.option(fc.constantFrom('Alpha', 'Beta'), { nil: undefined }),
  }),
  fc.record({ op: fc.constant('delete' as const), path: pathArb }),
  fc.record({ op: fc.constant('pin' as const), path: pathArb, pinned: fc.boolean() }),
)
type Command = typeof commandArb extends fc.Arbitrary<infer T> ? T : never

// The production write can REFUSE a generated command (path taken, nothing
// at the source, delete with descendants). A refusal is a fine outcome —
// the parity claim then covers "a refusal changed neither plane" — but only
// the port's own taxonomy is swallowed; anything else is a real failure.
function isExpectedRefusal(err: unknown): boolean {
  return (
    err instanceof portErrors.DocumentPathTakenError ||
    err instanceof portErrors.DocumentNotFoundError ||
    err instanceof portErrors.DocumentMoveIntoSelfError ||
    err instanceof portErrors.DocumentHasDescendantsError ||
    err instanceof RowDocumentNotFoundError ||
    err instanceof ConflictError
  )
}

function comparable(entries: DocumentEntry[]): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    documentId: entry.documentId,
    path: entry.path,
    kind: entry.kind,
    name: entry.name,
  }))
}

let runCounter = 0

describe('dual-plane listing parity (S5a scoreboard)', () => {
  fcTest.prop(
    [fc.array(commandArb, { minLength: 1, maxLength: 10 })],
    withDefaults({ numRuns: 40 }),
  )(
    'rows and tree answer the same listing after any production write sequence',
    async (commands: Command[]) => {
      const workspaceId = `parity-${runCounter++}`
      const db = await getDb(tempDir)
      const rows = new SqliteDocumentIndex(db)
      const index = new DualPlaneDocumentIndex(rows, db)
      const tree = new LoroWorkspaceDocumentIndex(
        cacheBackedWorkspaceDocs(),
        new FsBlobStore(getDataDir()),
      )
      await index.createWorkspace({ workspaceId })
      // At least one document, through the route save path, so the tree
      // workspace record exists — an empty workspace's listing semantics
      // (rows: [], tree: no record) is not what this instrument measures.
      await saveDocument(workspaceId, 'seed', new LoroDoc(), { kind: 'spatial' })

      for (const command of commands) {
        try {
          switch (command.op) {
            case 'create':
              await index.createDocument({ workspaceId, path: command.path, kind: 'markdown' })
              break
            case 'save':
              await saveDocument(workspaceId, command.path, new LoroDoc(), {
                kind: 'spatial',
                overwrite: true,
              })
              break
            case 'move':
              await index.moveDocument({ workspaceId, from: command.from, to: command.to })
              break
            case 'name': {
              const entry = await index.resolveDocument({ workspaceId, path: command.path })
              if (entry === null) break
              await index.setDocumentName({
                workspaceId,
                documentId: entry.documentId,
                ...(command.name === undefined ? {} : { name: command.name }),
              })
              break
            }
            case 'delete':
              await index.deleteDocument({ workspaceId, path: command.path })
              break
            case 'pin':
              await setDocumentPinned(workspaceId, command.path, command.pinned)
              break
          }
        } catch (err) {
          if (!isExpectedRefusal(err)) throw err
        }

        const rowListing = await index.listDocuments({ workspaceId })
        const treeListing = await tree.listDocuments({ workspaceId })
        expect(comparable(treeListing)).toEqual(comparable(rowListing))

        // Pin parity: the row columns and the workspace record's pinned
        // list must name the same documents in the same order.
        const names = await loadWorkspaceNames(workspaceId)
        const workspaceDoc = await cacheBackedWorkspaceDocs().open(workspaceId)
        expect(workspaceDoc).not.toBeNull()
        if (workspaceDoc === null) throw new Error('unreachable')
        const pinnedPaths = readPinnedDocumentIds(workspaceDoc).flatMap((documentId) => {
          const entry = resolveWorkspaceDocumentById(workspaceDoc, documentId)
          return entry === null ? [] : [entry.path]
        })
        expect(pinnedPaths).toEqual(names.pinned)
      }
    },
  )
})
