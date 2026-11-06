import { z } from 'zod'
import type { FolderNames } from '../../lib/folder-names.js'

const KEY_PREFIX = 'wb.pending-folder-names:'

const storedPendingSchema = z.array(z.tuple([z.string(), z.string()]))

/**
 * The names given to folders no document is in yet, kept for this TAB.
 *
 * A folder exists only while a document is in it, so its name is not the
 * keeper's to store until one lands. Held only in memory, though, it was lost
 * on a reload while the folder's address stayed in the URL, and the folder —
 * and every subfolder made under it afterwards — came back under its bare
 * address. Session storage is the scope that matches "kept until you leave":
 * a reload or a return in this tab keeps it, a new session does not.
 * Keyed by the workspace's memory scope, so one workspace's names never
 * reach another's.
 */
export function readPendingFolderNames(scope: string | undefined): FolderNames {
  if (scope === undefined) return new Map()
  try {
    const raw = sessionStorage.getItem(`${KEY_PREFIX}${scope}`)
    if (raw === null) return new Map()
    const parsed = storedPendingSchema.safeParse(JSON.parse(raw))
    return parsed.success ? new Map(parsed.data) : new Map()
  } catch {
    // Unavailable storage or a damaged entry: the names given this visit still hold.
    return new Map()
  }
}

export function writePendingFolderNames(scope: string | undefined, names: FolderNames): void {
  if (scope === undefined) return
  try {
    const key = `${KEY_PREFIX}${scope}`
    if (names.size === 0) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify([...names]))
  } catch {
    // Losing a pending name across a reload is survivable; failing the create is not.
  }
}
