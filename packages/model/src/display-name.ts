import { z } from 'zod'
import { leafOfPath, parentOfPath } from './document-path.js'
import { DOCUMENT_NAME_MAX_LENGTH, documentPathSchema } from './ids.js'
import { isGeneratedDocumentPath, UNTITLED_DOCUMENT_WORD } from './unnamed-document.js'

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
 * Which of `siblings` — the names the other folders, or the other documents,
 * under the same parent show — `name` duplicates, as that sibling shows it;
 * `undefined` when none. A writer refuses a duplicate it can SEE; one that
 * arrives by merging two replicas' edits is kept, since nothing could have
 * refused it and a rename nobody made would be worse than two equal names.
 */
function siblingShowing(name: string, siblings: Iterable<string>): string | undefined {
  const key = displayNameKey(name)
  for (const sibling of siblings) if (displayNameKey(sibling) === key) return sibling
  return undefined
}

/**
 * The two kinds of entry a workspace names. They are compared apart: a
 * folder and a document may show one name side by side.
 */
type NamedEntryKind = 'document' | 'folder'

/**
 * What an entry shows where a person reads it in its folder: the name
 * somebody gave it, trimmed, or — unnamed — its own last segment, except that
 * an unnamed DOCUMENT at an address the new-document flow generated shows
 * `Untitled`, numbered as the address is (`untitled-3` shows `Untitled 3`).
 *
 * A BLANK name counts as none, because it shows nothing a person could read;
 * comparing the blank instead would let a sibling take the very label the
 * blank-named entry is showing. A generated address is no word anybody chose,
 * so it reads as the title box's word for an unnamed document — numbered,
 * since two of them can sit in one folder and must not read as one. A folder
 * has no generated address, so its segment is what it shows.
 *
 * One answer for every reader of "what does this entry show" — the keepers'
 * sibling rule, the heading seeder, a duplicate's name and the web's labels —
 * so none of them can drift from another.
 */
export function shownName(
  kind: NamedEntryKind,
  entry: { readonly path: string; readonly name?: string | null | undefined },
): string {
  const name = entry.name?.trim()
  if (name !== undefined && name !== '') return name
  const leaf = leafOfPath(entry.path)
  if (kind === 'folder' || !isGeneratedDocumentPath(leaf)) return leaf
  return `${UNTITLED_DOCUMENT_WORD}${leaf.slice('untitled'.length).replace('-', ' ')}`
}

/**
 * The name a sibling of `target.path` already shows that `target.name`
 * duplicates — the siblings being the entries of `others`, all of `kind`,
 * directly under the same parent, each showing its `shownName` — or
 * `undefined` when `target.name` is free. `others` leaves the target itself
 * out, which only the caller can identify.
 *
 * The SIBLING's name is what a refusal quotes, never the one typed: "plan"
 * beside a document called "Plan" would read as a claim that something is
 * called "plan".
 */
export function siblingDisplayNameTaken(
  kind: NamedEntryKind,
  others: Iterable<{ readonly path: string; readonly name?: string | null | undefined }>,
  target: { readonly path: string; readonly name: string },
): string | undefined {
  const parent = parentOfPath(target.path)
  const shown: string[] = []
  for (const other of others) {
    if (parentOfPath(other.path) !== parent) continue
    shown.push(shownName(kind, other))
  }
  return siblingShowing(target.name, shown)
}

/**
 * The name a sibling already shows that moving the entry at `from` to `to`
 * would make it show too, or `undefined` when the move makes no duplicate.
 * `staying` is every entry of the same KIND that is not part of the moving
 * subtree; `name` is the moving entry's own display name. An entry that keeps
 * the label it already showed under the same parent (an unnamed one renamed
 * in place changes its label; a named one does not) is no new duplicate, so
 * re-saving a form over one that merged in is not refused.
 */
export function movedDisplayNameTaken(
  kind: NamedEntryKind,
  staying: Iterable<{ readonly path: string; readonly name?: string | null | undefined }>,
  move: { readonly from: string; readonly to: string; readonly name?: string | undefined },
): string | undefined {
  const shown = shownName(kind, { path: move.to, name: move.name })
  const wasShown = shownName(kind, { path: move.from, name: move.name })
  if (
    parentOfPath(move.from) === parentOfPath(move.to) &&
    displayNameKey(shown) === displayNameKey(wasShown)
  ) {
    return undefined
  }
  return siblingDisplayNameTaken(kind, staying, { path: move.to, name: shown })
}

/**
 * The address an UNNAMED document takes so that it does not read like a
 * sibling. Nobody chose a label for it, so a label that duplicates a sibling's
 * name is not a mistake to refuse: it moves to the first `-2`, `-3`, ...
 * address that is free and shows a label no sibling does — for a generated
 * address, the next generated one (`untitled-3`, never `untitled-2-2`). `path` itself when
 * it already reads distinctly; `null` when no suffix in range is free or
 * valid.
 */
export function firstDistinctUnnamedPath(
  path: string,
  siblings: Iterable<{ readonly path: string; readonly name?: string | null | undefined }>,
  isOccupied: (candidate: string) => boolean,
): string | null {
  const others = [...siblings]
  const reads = (candidate: string): boolean =>
    siblingDisplayNameTaken('document', others, {
      path: candidate,
      name: shownName('document', { path: candidate }),
    }) !== undefined
  if (!reads(path)) return path
  // A generated address steps to the next generated one, so it still reads
  // as "Untitled N" rather than as a raw `untitled-2-2`.
  const parent = parentOfPath(path)
  const stem = isGeneratedDocumentPath(path) ? `${parent === '' ? '' : `${parent}/`}untitled` : path
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}`
    if (!documentPathSchema.safeParse(candidate).success) return null
    if (!isOccupied(candidate) && !reads(candidate)) return candidate
  }
  return null
}
