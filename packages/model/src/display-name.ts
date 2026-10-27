import { z } from 'zod'
import { DOCUMENT_NAME_MAX_LENGTH } from './ids.js'

/**
 * Why `name` cannot be a folder's display name, or `null` when it can.
 *
 * One function for every writer — the web's dialog, the keeper's index, the
 * daemon's route, the MCP tool and the sync judge — because a refusal one
 * of them applies and another does not is a name the second one stores and
 * the first one can never write back. Here rather than in `ports` because the
 * sync judge and the web dialog both need it and neither reads ports for it.
 *
 * Blank is refused rather than read as "clear": clearing is an absent name,
 * which every contract spells as an absent field. A `/` is refused because
 * wherever a person types a folder, `/` already means "inside" — a name
 * holding one would read as a path it is not. The bound is the one every
 * display name holds, counted in UTF-16 units like the others.
 */
export function folderNameRefusal(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'A folder name cannot be blank.'
  if (trimmed.includes('/')) {
    return 'A folder name cannot contain "/", which separates folders in a path.'
  }
  if (trimmed.length > DOCUMENT_NAME_MAX_LENGTH) {
    return `A folder name is at most ${DOCUMENT_NAME_MAX_LENGTH} characters.`
  }
  return null
}

/**
 * A folder display name as a WRITE carries it, refused for what
 * `folderNameRefusal` refuses. A refinement and never a transform, so a tool
 * schema holding it still emits as JSON Schema; writers trim what they store.
 */
export const folderNameSchema = z.string().superRefine((name, ctx) => {
  const refusal = folderNameRefusal(name)
  if (refusal !== null) ctx.addIssue({ code: 'custom', message: refusal })
})

/**
 * What two display names are compared as: trimmed, NFC-normalised and
 * case-folded, so the names a person reads as one name are one key — `Week 6`
 * and ` week 6 `, a composed and a decomposed `é`.
 */
export function displayNameKey(name: string): string {
  return name.trim().normalize('NFC').toLowerCase()
}

/**
 * Whether `name` is already the display name of one of `siblings` — the
 * names the other folders, or the other documents, under the same parent
 * show. A writer refuses a duplicate it can SEE; one that arrives by merging
 * two replicas' edits is kept, since nothing could have refused it and a
 * rename nobody made would be worse than two equal names.
 */
function isDisplayNameTaken(name: string, siblings: Iterable<string>): boolean {
  const key = displayNameKey(name)
  for (const sibling of siblings) if (displayNameKey(sibling) === key) return true
  return false
}

/**
 * Whether `target.name` duplicates what a sibling of `target.path` shows —
 * the siblings being the entries of `others` directly under the same parent,
 * each showing its name or, unnamed, its own segment. `others` is one KIND of
 * entry (folders, or documents: the two are compared separately) and leaves
 * the target itself out, which only the caller can identify.
 */
export function isSiblingDisplayNameTaken(
  others: Iterable<{ readonly path: string; readonly name?: string | undefined }>,
  target: { readonly path: string; readonly name: string },
): boolean {
  const parent = parentOf(target.path)
  const shown: string[] = []
  for (const other of others) {
    if (parentOf(other.path) !== parent) continue
    shown.push(other.name ?? other.path.slice(other.path.lastIndexOf('/') + 1))
  }
  return isDisplayNameTaken(target.name, shown)
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}
