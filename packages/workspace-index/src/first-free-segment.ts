import { workspaceSegmentSchema } from '@kamiazya/whiteboard-model'

/**
 * The first segment of a series nobody holds, starting from the candidate a
 * display name derived (`deriveWorkspaceSegment`).
 *
 * ONE rule, because both keepers mint a workspace and a suffix scheme that
 * differed between them would put the same name at two addresses depending on
 * where it was created. What differs is only how "held" is asked — the
 * browser resolves per candidate against IndexedDB, the daemon lists its
 * registry once — so that is the parameter.
 *
 * Asking is the only thing that stays true after a delete or a rename, which
 * is why this reads a registry rather than counting from a stored number. It
 * is advisory, not authoritative: two creates can both find a candidate free,
 * and the registry's own uniqueness is what decides.
 *
 * Starts at 2 because the unsuffixed segment IS the first one; a `-1` would
 * read as the first of a series whose first member is spelled differently.
 *
 * Every suffixed candidate is re-validated, because a suffix can push a long
 * base out of the segment grammar, and a segment nothing validated is one the
 * address layer refuses later, somewhere less obvious. The series is bounded:
 * a thousand workspaces sharing one display name is not a case to invent
 * machinery for, and past the bound the workspace is addressed by its
 * canonical id, which is what that layer is for. `undefined` is that answer.
 */
export async function firstFreeSegment(
  base: string,
  isTaken: (segment: string) => boolean | Promise<boolean>,
): Promise<string | undefined> {
  if (!(await isTaken(base))) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!workspaceSegmentSchema.safeParse(candidate).success) return undefined
    if (!(await isTaken(candidate))) return candidate
  }
  return undefined
}
