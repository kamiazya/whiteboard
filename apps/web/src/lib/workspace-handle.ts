/**
 * The two things a UI needs from ADR-0019's three layers: what to ADDRESS a
 * workspace by, and what to SHOW for it.
 *
 * Both are precedence rules over the same record, and both were written
 * inline before this file existed — `PromoteWorkspaceSection` reached for
 * `displayName ?? workspaceId` and skipped the middle layer entirely, so a
 * workspace with a segment and no display name read back as a raw ULID. That
 * is the failure mode a per-site rule has: not disagreement, but one site
 * quietly knowing about fewer layers than there are.
 *
 * `workspaceHandle` is the inverse of ports' `resolveWorkspaceHandle`: that
 * one turns an incoming address into a workspace, this one turns a workspace
 * into the address to emit. They are kept apart because the label half has no
 * business in a contracts package, and splitting the pair to place one of
 * them "correctly" would cost more than it buys — move the handle half beside
 * its inverse when a second package needs it.
 */

/** Just enough of a workspace record to address and name it. */
export interface WorkspaceIdentity {
  readonly workspaceId: string
  readonly segment?: string | undefined
  readonly displayName?: string | undefined
}

/**
 * What an address carries: the segment when the workspace has one, the
 * canonical id when it does not.
 *
 * The id is not a lesser answer here — ADR-0019 keeps it resolvable in the
 * same position precisely so it can be the durable form, and 0019's migration
 * deliberately left a legacy workspace's segment NULL rather than inventing
 * one. A workspace addressed by its id is a workspace nobody has named yet.
 */
export function workspaceHandle(workspace: WorkspaceIdentity): string {
  return workspace.segment ?? workspace.workspaceId
}

/**
 * What a person reads: the free-text name they chose, else the segment they
 * chose, else the id nobody chose.
 *
 * The last step is a fallback and not a design — DESIGN.md's "Raw identifiers
 * are not chrome" is exactly about the canonical id — but a control has to
 * render something, and an empty option is worse than an ugly one.
 */
export function workspaceLabel(workspace: WorkspaceIdentity): string {
  return workspace.displayName ?? workspace.segment ?? workspace.workspaceId
}
