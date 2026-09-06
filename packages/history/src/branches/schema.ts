/**
 * What a branch IS, as the one schema both keepers and the wire share.
 *
 * A branch — a variation, in ADR-0022's vocabulary — is a name and a
 * frontier of the workspace record: not a fork, not a second document. The
 * daemon keeps one as a row and the browser will keep one in the record's
 * own node meta; the daemon's `/branches` routes carry exactly this shape,
 * which is why `daemon-client`'s contract re-exports these rather than
 * declaring a second copy (Zod is the single source of truth).
 *
 * `main` is the default variation: the head a document has before anybody
 * makes a branch, and the one name every keeper has to know.
 */
import { z } from 'zod'

export const branchMetaSchema = z.object({
  name: z.string(),
  /** Base64 frontiers of the workspace record; empty until the branch first records a tip. */
  tipFrontiers: z.string(),
  baseBranch: z.string().optional(),
  baseVersionId: z.string().optional(),
  color: z.string(),
  createdAt: z.string(),
})

export const documentBranchesStateSchema = z.object({
  branches: z.array(branchMetaSchema),
  head: z.string(),
})

export type BranchMeta = z.infer<typeof branchMetaSchema>
export type DocumentBranchesState = z.infer<typeof documentBranchesStateSchema>

export const MAIN_BRANCH = 'main'
export const DEFAULT_MAIN_COLOR = '#1971c2'

/** The state a document has before any branch was made. */
export function defaultMain(now: Date = new Date()): BranchMeta {
  return {
    name: MAIN_BRANCH,
    tipFrontiers: '',
    color: DEFAULT_MAIN_COLOR,
    createdAt: now.toISOString(),
  }
}

/**
 * The head a keeper's stored pointer resolves to over the branches it holds.
 * A pointer naming a branch that is gone falls back to `main`, and to the
 * first branch when even `main` is gone — never to a name nothing answers.
 */
export function resolveHead(
  branches: readonly BranchMeta[],
  persistedHead: string | undefined,
): string {
  const wanted = persistedHead ?? MAIN_BRANCH
  if (branches.some((b) => b.name === wanted)) return wanted
  if (branches.some((b) => b.name === MAIN_BRANCH)) return MAIN_BRANCH
  return branches[0]?.name ?? MAIN_BRANCH
}
