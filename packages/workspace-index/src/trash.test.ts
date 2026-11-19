import type { TrashEntry } from '@kamiazya/whiteboard-loro-adapter'
import { DOCUMENT_NAME_MAX_LENGTH, MARKDOWN_MAX_CHARS, nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { blobRefKey } from '@kamiazya/whiteboard-ports'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import {
  INDEX_SUBJECTS,
  indexOver,
  inMemoryBlobStore,
  liveWorkspaceDocs,
  notRenamingRegistry,
} from './test-utils/index-subjects.js'

const WS = '01NA8GJR52H92D8CBCA44CWA9E'

describe.each(INDEX_SUBJECTS)('trash over $name', (subject) => {
  /** Writes a trash row straight into a record, as a synced update from another writer would. */
  const recordRow = (record: unknown, entry: TrashEntry) =>
    subject.kind.write(record, [{ op: 'recordTrashEntry', args: { entry } }])

  describe('deleting a document', () => {
    let blobs: ReturnType<typeof inMemoryBlobStore>
    let docs: ReturnType<typeof liveWorkspaceDocs>
    let index: LoroWorkspaceDocumentIndex<unknown>

    beforeEach(async () => {
      blobs = inMemoryBlobStore()
      docs = liveWorkspaceDocs(subject)
      index = indexOver(subject, docs, blobs)
      await index.createWorkspace({ workspaceId: WS })
    })

    async function seedCanvas(path: string, text: string): Promise<string> {
      const created = await index.createDocument({ workspaceId: WS, path, kind: 'spatial' })
      subject.writeCanvas(docs.peek(WS), created.documentId, {
        nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
        edges: [],
      })
      return created.documentId
    }

    it('evacuates the content before removing it, and lists it as recoverable', async () => {
      const documentId = await seedCanvas('design', 'important')

      await index.deleteDocument({ workspaceId: WS, path: 'design' })

      expect(await index.resolveDocument({ workspaceId: WS, path: 'design' })).toBeNull()
      const trashed = await index.listTrash({ workspaceId: WS })
      expect(trashed).toHaveLength(1)
      expect(trashed[0]?.documentId).toBe(documentId)
      expect(trashed[0]?.path).toBe('design')
      // The bytes are really there, not merely a row claiming they are.
      expect(blobs.size()).toBe(1)
    })

    it('lists the display name the document had, beside its path', async () => {
      await index.createDocument({
        workspaceId: WS,
        path: 'untitled-7',
        kind: 'markdown',
        name: 'Team Charter',
      })
      await index.deleteDocument({ workspaceId: WS, path: 'untitled-7' })

      const [row] = await index.listTrash({ workspaceId: WS })

      expect(row?.name).toBe('Team Charter')
    })

    it('restores the document under the id it had, so a share link survives', async () => {
      const documentId = await seedCanvas('design', 'important')
      await index.deleteDocument({ workspaceId: WS, path: 'design' })

      const restored = await index.restoreDocument({ workspaceId: WS, documentId })

      expect(restored?.documentId).toBe(documentId)
      expect(await index.resolveDocumentById({ workspaceId: WS, documentId })).not.toBeNull()
      // Content, not just placement.
      const node = subject.readCanvas(docs.peek(WS), documentId).nodes[0]
      expect(node === undefined ? null : nodeText(node)).toBe('important')
      // Off the trash listing once it is back.
      expect(await index.listTrash({ workspaceId: WS })).toHaveLength(0)
    })

    it('does not evacuate when the delete is refused', async () => {
      await seedCanvas('design', 'parent')
      await seedCanvas('design/notes', 'child')

      await expect(index.deleteDocument({ workspaceId: WS, path: 'design' })).rejects.toThrow()

      // Nothing was written: a refused delete that had already evacuated would
      // leave a blob and a trash row for a document that is still there.
      expect(blobs.size()).toBe(0)
      expect(await index.listTrash({ workspaceId: WS })).toHaveLength(0)
    })

    it('leaves nothing behind when a document is deleted twice', async () => {
      await seedCanvas('design', 'important')
      await index.deleteDocument({ workspaceId: WS, path: 'design' })
      // The port says deleting an absent path succeeds. It must not also
      // evacuate nothing into a second trash row.
      await index.deleteDocument({ workspaceId: WS, path: 'design' })

      expect(await index.listTrash({ workspaceId: WS })).toHaveLength(1)
    })
  })

  describe('restoring a document', () => {
    let blobs: ReturnType<typeof inMemoryBlobStore>
    let docs: ReturnType<typeof liveWorkspaceDocs>
    let index: LoroWorkspaceDocumentIndex<unknown>

    beforeEach(async () => {
      blobs = inMemoryBlobStore()
      docs = liveWorkspaceDocs(subject)
      index = indexOver(subject, docs, blobs)
      await index.createWorkspace({ workspaceId: WS })
    })

    async function createAndDelete(path: string): Promise<string> {
      const { documentId } = await index.createDocument({
        workspaceId: WS,
        path,
        kind: 'markdown',
      })
      await index.deleteDocument({ workspaceId: WS, path })
      return documentId
    }

    it('puts a nested document back under the folder it came from', async () => {
      const documentId = await createAndDelete('design/notes')

      const restored = await index.restoreDocument({ workspaceId: WS, documentId })

      expect(restored?.path).toBe('design/notes')
      expect(
        (await index.resolveDocument({ workspaceId: WS, path: 'design/notes' }))?.documentId,
      ).toBe(documentId)
    })

    it('puts a top-level document back at the top level', async () => {
      const documentId = await createAndDelete('notes')

      const restored = await index.restoreDocument({ workspaceId: WS, documentId })

      expect(restored?.path).toBe('notes')
    })

    it('answers null and keeps the trash row when the evacuated bytes are gone', async () => {
      const documentId = await createAndDelete('design')
      const [row] = await index.listTrash({ workspaceId: WS })
      if (row === undefined) throw new Error('expected a trash row')
      await blobs.delete({ ref: row.blob })

      expect(await index.restoreDocument({ workspaceId: WS, documentId })).toBeNull()

      // The row is the only record the document existed.
      expect((await index.listTrash({ workspaceId: WS })).map((entry) => entry.documentId)).toEqual(
        [documentId],
      )
    })

    it('answers null and keeps the trash row when the bytes hold no document', async () => {
      const documentId = await createAndDelete('design')
      const { ref } = await blobs.put({
        bytes: new Uint8Array(subject.kind.exportSnapshot(await subject.kind.empty())),
        contentType: 'application/octet-stream',
      })
      recordRow(docs.peek(WS), { documentId, path: 'design', deletedAt: 1, blob: ref })

      expect(await index.restoreDocument({ workspaceId: WS, documentId })).toBeNull()

      expect((await index.listTrash({ workspaceId: WS })).map((entry) => entry.documentId)).toEqual(
        [documentId],
      )
    })

    it('answers null and places nothing when the bytes hold a different document', async () => {
      // A trash row is synced data, so it can name any blob the keeper holds —
      // here the bytes another row evacuated.
      const named = await createAndDelete('design')
      const other = await createAndDelete('elsewhere')
      const otherRow = (await index.listTrash({ workspaceId: WS })).find(
        (row) => row.documentId === other,
      )
      if (otherRow === undefined) throw new Error('expected a trash row')
      recordRow(docs.peek(WS), {
        documentId: named,
        path: 'design',
        deletedAt: 1,
        blob: otherRow.blob,
      })

      expect(await index.restoreDocument({ workspaceId: WS, documentId: named })).toBeNull()

      expect(await index.resolveDocumentById({ workspaceId: WS, documentId: other })).toBeNull()
      expect(await index.listDocuments({ workspaceId: WS })).toEqual([])
      expect(
        (await index.listTrash({ workspaceId: WS })).map((entry) => entry.documentId).sort(),
      ).toEqual([named, other].sort())
    })
  })

  describe('restoring a document judges it as a sync write would', () => {
    // A trash row and the bytes it names both arrive from outside — a sync
    // update can rewrite a row, a promotion carries bytes — so what a restore
    // places is held to the bounds any other write of the record is.
    let blobs: ReturnType<typeof inMemoryBlobStore>
    let docs: ReturnType<typeof liveWorkspaceDocs>
    let index: LoroWorkspaceDocumentIndex<unknown>

    beforeEach(async () => {
      blobs = inMemoryBlobStore()
      docs = liveWorkspaceDocs(subject)
      index = indexOver(subject, docs, blobs)
      await index.createWorkspace({ workspaceId: WS })
    })

    async function trashed(
      path: string,
      shape: (record: unknown, documentId: string) => void = () => {},
    ): Promise<{ documentId: string; row: TrashEntry }> {
      const { documentId } = await index.createDocument({ workspaceId: WS, path, kind: 'markdown' })
      shape(docs.peek(WS), documentId)
      await index.deleteDocument({ workspaceId: WS, path })
      const row = (await index.listTrash({ workspaceId: WS })).find(
        (entry) => entry.documentId === documentId,
      )
      if (row === undefined) throw new Error('expected a trash row')
      return { documentId, row }
    }

    async function expectRefusedAndUntouched(documentId: string): Promise<void> {
      expect(await index.restoreDocument({ workspaceId: WS, documentId })).toBeNull()
      expect(await index.listDocuments({ workspaceId: WS })).toEqual([])
      expect(await subject.kind.nodes(docs.peek(WS))).toEqual([])
      expect((await index.listTrash({ workspaceId: WS })).map((entry) => entry.documentId)).toEqual(
        [documentId],
      )
    }

    it.each([
      ['an empty segment', 'a//b'],
      ['a parent step', '../x'],
      ['a control character', 'a\u0007b/notes'],
    ])('refuses a row whose path holds %s', async (_shape, path) => {
      const { documentId, row } = await trashed('notes')
      recordRow(docs.peek(WS), { ...row, path })

      await expectRefusedAndUntouched(documentId)
    })

    it('refuses bytes holding a body past the length bound', async () => {
      const { documentId } = await trashed('notes', (record, id) =>
        subject.writeBody(record, id, 'x'.repeat(MARKDOWN_MAX_CHARS + 1)),
      )

      await expectRefusedAndUntouched(documentId)
    })

    it('refuses bytes holding a name past the length bound', async () => {
      const { documentId } = await trashed('notes', (record, id) =>
        subject.kind.write(record, [
          {
            op: 'setWorkspaceDocumentName',
            args: { documentId: id, name: 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1) },
          },
        ]),
      )

      await expectRefusedAndUntouched(documentId)
    })

    it('restores a document at the bounds', async () => {
      const { documentId } = await trashed('design/notes', (record, id) => {
        subject.writeBody(record, id, 'x'.repeat(MARKDOWN_MAX_CHARS))
        subject.kind.write(record, [
          {
            op: 'setWorkspaceDocumentName',
            args: { documentId: id, name: 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH) },
          },
        ])
      })

      const restored = await index.restoreDocument({ workspaceId: WS, documentId })

      expect(restored?.path).toBe('design/notes')
    })
  })

  describe('purging a trashed document', () => {
    let blobs: ReturnType<typeof inMemoryBlobStore>
    let docs: ReturnType<typeof liveWorkspaceDocs>
    let index: LoroWorkspaceDocumentIndex<unknown>

    beforeEach(async () => {
      blobs = inMemoryBlobStore()
      docs = liveWorkspaceDocs(subject)
      index = indexOver(subject, docs, blobs)
      await index.createWorkspace({ workspaceId: WS })
    })

    async function createAndDelete(path: string): Promise<string> {
      const { documentId } = await index.createDocument({ workspaceId: WS, path, kind: 'markdown' })
      await index.deleteDocument({ workspaceId: WS, path })
      return documentId
    }

    it('destroys the evacuated bytes, not only the row that points at them', async () => {
      const documentId = await createAndDelete('design')
      const [row] = await index.listTrash({ workspaceId: WS })
      if (row === undefined) throw new Error('expected a trash row')
      expect(blobs.size()).toBe(1)

      await index.purgeTrashEntry({ workspaceId: WS, documentId })

      expect(blobs.size()).toBe(0)
      expect(await blobs.has({ ref: row.blob })).toEqual({ exists: false })
    })

    it("destroys the purged entry's own bytes while another entry with different bytes stays", async () => {
      const purged = await createAndDelete('design')
      const kept = await createAndDelete('notes')
      const rows = await index.listTrash({ workspaceId: WS })
      const purgedRow = rows.find((entry) => entry.documentId === purged)
      const keptRow = rows.find((entry) => entry.documentId === kept)
      if (purgedRow === undefined || keptRow === undefined)
        throw new Error('expected two trash rows')
      expect(blobs.size()).toBe(2)

      await index.purgeTrashEntry({ workspaceId: WS, documentId: purged })

      expect(await blobs.has({ ref: purgedRow.blob })).toEqual({ exists: false })
      expect(await blobs.has({ ref: keptRow.blob })).toEqual({ exists: true })
    })

    it('keeps the bytes another trash row still names', async () => {
      const documentId = await createAndDelete('design')
      const other = await createAndDelete('notes')
      const [row] = (await index.listTrash({ workspaceId: WS })).filter(
        (entry) => entry.documentId === documentId,
      )
      if (row === undefined) throw new Error('expected a trash row')
      // A second row naming the same blob, as a replica's copy of one document would.
      recordRow(docs.peek(WS), { ...row, documentId: other })

      await index.purgeTrashEntry({ workspaceId: WS, documentId })

      expect(await blobs.has({ ref: row.blob })).toEqual({ exists: true })
    })

    it('keeps the bytes another trash row still names when one of them is restored', async () => {
      const documentId = await createAndDelete('design')
      const other = await createAndDelete('notes')
      const [row] = (await index.listTrash({ workspaceId: WS })).filter(
        (entry) => entry.documentId === documentId,
      )
      if (row === undefined) throw new Error('expected a trash row')
      recordRow(docs.peek(WS), { ...row, documentId: other })

      await index.restoreDocument({ workspaceId: WS, documentId })

      expect(await blobs.has({ ref: row.blob })).toEqual({ exists: true })
    })

    it('keeps the evacuated bytes when the restore cannot be saved', async () => {
      const documentId = await createAndDelete('design')
      const failing = vi.spyOn(docs, 'save').mockRejectedValueOnce(new Error('disk full'))

      await expect(index.restoreDocument({ workspaceId: WS, documentId })).rejects.toThrow(
        'disk full',
      )

      failing.mockRestore()
      expect(blobs.size()).toBe(1)
    })

    it('leaves the document restored and its row gone when dropping the old bytes fails', async () => {
      const documentId = await createAndDelete('design')
      const failing = vi.spyOn(blobs, 'delete').mockRejectedValueOnce(new Error('disk gone'))

      await expect(index.restoreDocument({ workspaceId: WS, documentId })).rejects.toThrow(
        'disk gone',
      )

      failing.mockRestore()
      expect(await index.listTrash({ workspaceId: WS })).toEqual([])
      expect(await index.resolveDocumentById({ workspaceId: WS, documentId })).not.toBeNull()
    })

    it('removes a row whose bytes are already gone, the one way to clear it', async () => {
      const documentId = await createAndDelete('design')
      const [row] = await index.listTrash({ workspaceId: WS })
      if (row === undefined) throw new Error('expected a trash row')
      await blobs.delete({ ref: row.blob })

      expect(await index.purgeTrashEntry({ workspaceId: WS, documentId })).toBe(true)

      expect(await index.listTrash({ workspaceId: WS })).toEqual([])
    })

    it('keeps the row, so a retry can finish, when destroying the bytes fails', async () => {
      const documentId = await createAndDelete('design')
      const failing = vi.spyOn(blobs, 'delete').mockRejectedValueOnce(new Error('disk gone'))

      await expect(index.purgeTrashEntry({ workspaceId: WS, documentId })).rejects.toThrow(
        'disk gone',
      )
      expect((await index.listTrash({ workspaceId: WS })).map((e) => e.documentId)).toEqual([
        documentId,
      ])

      failing.mockRestore()
      expect(await index.purgeTrashEntry({ workspaceId: WS, documentId })).toBe(true)
      expect(blobs.size()).toBe(0)
    })
  })

  describe('a trash blob another workspace still names', () => {
    const OTHER = '0175T8F2WH2MX756J1T7SHKGB8'
    let blobs: ReturnType<typeof inMemoryBlobStore>
    let docs: ReturnType<typeof liveWorkspaceDocs>
    let index: LoroWorkspaceDocumentIndex<unknown>
    let asked: { workspaceId: string; digestHex: string }[]

    beforeEach(async () => {
      blobs = inMemoryBlobStore()
      docs = liveWorkspaceDocs(subject)
      asked = []
      // One blob store under two workspaces' records, as a keeper whose store is
      // shared across workspaces has; the predicate is that keeper's answer.
      index = indexOver(subject, docs, blobs, notRenamingRegistry, {
        trashBlobNamedElsewhere: async ({ workspaceId, ref }) => {
          asked.push({ workspaceId, digestHex: ref.digestHex })
          const others = [WS, OTHER].filter((id) => id !== workspaceId)
          const rows = await Promise.all(others.map((id) => subject.kind.trash(docs.peek(id))))
          return rows.some((held) => held.some((row) => blobRefKey(row.blob) === blobRefKey(ref)))
        },
      })
      await index.createWorkspace({ workspaceId: WS })
      await index.createWorkspace({ workspaceId: OTHER })
    })

    /** The same trashed document recorded in both workspaces, over one blob. */
    async function trashedInBoth(): Promise<string> {
      const { documentId } = await index.createDocument({
        workspaceId: WS,
        path: 'design',
        kind: 'markdown',
      })
      await index.deleteDocument({ workspaceId: WS, path: 'design' })
      const [row] = await index.listTrash({ workspaceId: WS })
      if (row === undefined) throw new Error('expected a trash row')
      recordRow(docs.peek(OTHER), row)
      return documentId
    }

    it('keeps the bytes when the entry is purged in one workspace', async () => {
      const documentId = await trashedInBoth()

      await index.purgeTrashEntry({ workspaceId: WS, documentId })

      expect(await index.restoreDocument({ workspaceId: OTHER, documentId })).not.toBeNull()
      expect(asked.map((call) => call.workspaceId)).toContain(WS)
    })

    it('keeps the bytes when the entry is restored in one workspace', async () => {
      const documentId = await trashedInBoth()

      await index.restoreDocument({ workspaceId: WS, documentId })

      expect(await index.restoreDocument({ workspaceId: OTHER, documentId })).not.toBeNull()
    })

    it('destroys the bytes once no workspace names them', async () => {
      const documentId = await trashedInBoth()
      await index.purgeTrashEntry({ workspaceId: WS, documentId })

      await index.purgeTrashEntry({ workspaceId: OTHER, documentId })

      expect(blobs.size()).toBe(0)
    })
  })
})
