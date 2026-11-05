// The workspace record's trash: what it records about each document a delete
// evacuated, in a map beside the tree. The bytes themselves live in
// content-addressed storage; only the row naming them syncs.
import { documentIdSchema } from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'

/** Where a deleted document's evacuated bytes are recorded. */
export const WORKSPACE_TRASH_KEY = 'trash'

/** The most folder names one trash row keeps — the nearest, when more were named. */
export const TRASH_FOLDER_NAMES_MAX = 256

const folderNameRowSchema = z.object({ path: z.string().min(1), name: z.string().min(1) })

function trashEntryShape(folderNameRow: z.ZodType<{ path: string; name: string }>) {
  return {
    documentId: documentIdSchema,
    /** Where it was, for a listing a human can read. */
    path: z.string().min(1),
    /**
     * The display name it had. Absent on rows recorded before names were kept
     * and for a document that never had one; a listing falls back to the path.
     */
    name: z.string().min(1).optional(),
    /**
     * The display names of the folders above it when it left, so a restore
     * can show them again: an empty folder is not kept, so the delete that
     * emptied one took its name with it. Absent when none had a name.
     */
    folderNames: z.array(folderNameRow).max(TRASH_FOLDER_NAMES_MAX).optional(),
    deletedAt: z.number().int().nonnegative(),
    blob: z.object({
      algorithm: z.literal('sha-256'),
      digestHex: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  }
}

/** What the trash records about a document that was deleted. */
export const trashEntrySchema = z.object(trashEntryShape(folderNameRowSchema.strict())).strict()

/**
 * The same row as READ: a key this version does not know is set aside rather
 * than failing the row. The row syncs, so a newer peer's field reaches an
 * older reader, and a strict read would drop the whole row — hiding the
 * document from the listing and its bytes from the file scan that keeps them.
 * Only the read strips; nothing writes a read row back, so the unknown field
 * stays in the record for the peer that understands it.
 */
const trashEntryReadSchema = z.object(trashEntryShape(folderNameRowSchema))

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
    const parsed = trashEntryReadSchema.safeParse(value)
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
