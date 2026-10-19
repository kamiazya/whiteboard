// The workspace record's trash: what it records about each document a delete
// evacuated, in a map beside the tree. The bytes themselves live in
// content-addressed storage; only the row naming them syncs.
import { documentIdSchema } from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'

/** Where a deleted document's evacuated bytes are recorded. */
export const WORKSPACE_TRASH_KEY = 'trash'

/** What the trash records about a document that was deleted. */
export const trashEntrySchema = z
  .object({
    documentId: documentIdSchema,
    /** Where it was, for a listing a human can read. */
    path: z.string().min(1),
    deletedAt: z.number().int().nonnegative(),
    blob: z.object({
      algorithm: z.literal('sha-256'),
      digestHex: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  })
  .strict()
export type TrashEntry = z.infer<typeof trashEntrySchema>

/**
 * Records an evacuation in the workspace document itself.
 *
 * The METADATA syncs and the BYTES do not: a blob ref travels in the tree
 * like any other value, while the bytes sit in content-addressed storage that
 * every keeper already has. Deleting on one device therefore leaves the other
 * able to see what went and ask for it.
 */
export function recordTrashEntry(doc: LoroDoc, entry: TrashEntry): void {
  doc.getMap(WORKSPACE_TRASH_KEY).set(entry.documentId, trashEntrySchema.parse(entry))
  doc.commit()
}

export function readTrashEntries(doc: LoroDoc): TrashEntry[] {
  const raw = doc.getMap(WORKSPACE_TRASH_KEY).toJSON() as Record<string, unknown>
  const out: TrashEntry[] = []
  for (const value of Object.values(raw)) {
    const parsed = trashEntrySchema.safeParse(value)
    // A damaged entry is skipped rather than thrown on: it is one row of a
    // trash listing, and refusing the whole listing would hide every other
    // recoverable document behind it.
    if (parsed.success) out.push(parsed.data)
  }
  return out.sort((left, right) => right.deletedAt - left.deletedAt)
}

export function forgetTrashEntry(doc: LoroDoc, documentId: string): void {
  doc.getMap(WORKSPACE_TRASH_KEY).delete(documentId)
  doc.commit()
}
