/**
 * Creating a workspace the browser keeps.
 *
 * The daemon's create surface mints server-side — the server decides the
 * canonical id and the caller's string becomes the segment. The browser has
 * no server in that loop, so the id is minted right here. It is still a
 * canonical ULID, because that is what every store keys on and what the
 * address falls back to.
 *
 * What a person supplies is a DISPLAY NAME. The segment is derived from it,
 * and the two layers keep their own rules: a display name may repeat as often
 * as its owner likes (ADR-0019 gives it no uniqueness duty), while the
 * address it derives has to be unique — within this browser, since the
 * registry is IndexedDB and cannot collide with anyone else's.
 */
import {
  deriveWorkspaceSegment,
  generateDocumentId,
  workspaceSegmentSchema,
} from '@kamiazya/whiteboard-model'
import type { DocumentIndex, WorkspaceEntry } from '@kamiazya/whiteboard-ports'

export interface CreateBrowserWorkspaceInput {
  readonly displayName: string
}

/**
 * Creates the workspace and answers the identity it was given.
 *
 * The suffix loop reads the registry rather than counting from a stored
 * number: what makes a segment unavailable is another row holding it, and
 * asking the registry is the only thing that stays true after a delete or a
 * rename.
 */
export async function createBrowserWorkspace(
  index: DocumentIndex,
  { displayName }: CreateBrowserWorkspaceInput,
): Promise<WorkspaceEntry> {
  // Trimmed, because surrounding whitespace in a typed name is an accident
  // every time and would render as a name with a hole beside it. Trimming to
  // NOTHING is a different thing and not this function's to paper over: a
  // workspace with no name has nothing to show in a switcher, and the form
  // that collected the name is where a person can still fix it.
  const name = displayName.trim()
  if (name === '') throw new Error('a workspace needs a name')

  const workspaceId = generateDocumentId()
  const base = deriveWorkspaceSegment(name)
  const segment = base === undefined ? undefined : await firstFreeSegment(index, base)

  const entry: WorkspaceEntry = {
    workspaceId,
    ...(segment === undefined ? {} : { segment }),
    displayName: name,
  }
  await index.createWorkspace(entry)
  return entry
}

async function firstFreeSegment(index: DocumentIndex, base: string): Promise<string | undefined> {
  if ((await index.resolveWorkspace(base)) === null) return base
  // Starts at 2 because the unsuffixed segment IS the first one. A `-1` would
  // read as the first of a series whose first member is spelled differently.
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    // Re-checked against the schema: a base near the length ceiling can grow
    // out of it, and a suffixed segment nothing validates is a segment the
    // address layer will refuse later, somewhere less obvious.
    if (!workspaceSegmentSchema.safeParse(candidate).success) return undefined
    if ((await index.resolveWorkspace(candidate)) === null) return candidate
  }
  // A thousand workspaces sharing one display name is not a case to invent
  // machinery for; the canonical id addresses this one.
  return undefined
}
