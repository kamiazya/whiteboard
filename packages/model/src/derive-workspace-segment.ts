import { workspaceSegmentSchema } from './ids.js'

/**
 * The address a workspace's display name yields, or `undefined` when it
 * yields none.
 *
 * ONE rule, because both keepers mint a workspace and a derivation that
 * differed between them would put the same name at two addresses. It lives in
 * model rather than beside either caller for the reason `workspaceHandle` and
 * `workspaceLabel` were pulled together: a per-site copy does not disagree
 * loudly, it disagrees quietly.
 *
 * Absent is a real answer, not a failure to try. A name written in a script
 * the segment charset cannot spell produces nothing, and ADR-0019 already
 * settled what to do about that — its migration left a legacy segment NULL
 * rather than writing a mangled approximation, and a workspace with no segment
 * is addressed by its canonical id, which is exactly why that layer stays
 * resolvable. An invented `workspace-2` would be a name nobody chose, sitting
 * in the URL for as long as the workspace lives.
 *
 * Uniqueness is NOT decided here and cannot be: what makes a segment
 * unavailable is another row holding it, which only the keeper's registry
 * knows. Callers take this candidate and ask their own registry.
 */
export function deriveWorkspaceSegment(displayName: string): string | undefined {
  const candidate = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return workspaceSegmentSchema.safeParse(candidate).success ? candidate : undefined
}
