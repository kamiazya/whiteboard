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
 * `workspaceHandle` is the inverse of `resolveWorkspaceAddress`: that one
 * turns an incoming address into a workspace, this one turns a workspace into
 * the address to emit. The label half has no business in a contracts
 * package, so the pair lives here rather than beside ports'
 * `resolveWorkspaceHandle`.
 */
import {
  formatWorkspaceAddress,
  parseWorkspaceAddress,
  SINGLE_PERSON_NAMESPACE,
} from '@kamiazya/whiteboard-model'
import { resolveWorkspaceHandle } from '@kamiazya/whiteboard-ports'
import { workspacePath } from './app-routes.js'

/** Just enough of a workspace record to address and name it. */
export interface WorkspaceIdentity {
  readonly workspaceId: string
  /** The namespace holding `segment`; absent is a single-person keeper's `me`. */
  readonly namespace?: string | undefined
  readonly segment?: string | undefined
  readonly displayName?: string | undefined
}

/**
 * What an in-app address carries (ADR-0053): `<namespace>/<segment>` when the
 * workspace has a segment, the canonical id when it does not.
 *
 * Never the segment alone: a segment is unique only inside its namespace, so
 * on a keeper with many people a bare one would name a different workspace
 * for each person who opened it.
 *
 * The id is not a lesser answer here — ADR-0019 keeps it resolvable in the
 * same position precisely so it can be the durable form, and 0019's migration
 * deliberately left a legacy workspace's segment NULL rather than inventing
 * one. A workspace addressed by its id is a workspace nobody has named yet.
 */
export function workspaceHandle(workspace: WorkspaceIdentity): string {
  if (workspace.segment === undefined) return workspace.workspaceId
  return formatWorkspaceAddress({
    form: 'qualified',
    namespace: workspace.namespace ?? SINGLE_PERSON_NAMESPACE,
    segment: workspace.segment,
  })
}

/**
 * The workspace an address names among `entries`, or null.
 *
 * Ports' `resolveWorkspaceHandle` reads a one-component address as a segment
 * in the caller's namespace first — right for an MCP argument, wrong for a
 * URL: a one-component URL is the id form ONLY (ADR-0053 decision 2), so an
 * old `/w/<segment>` link names nothing rather than being quietly redirected.
 * A legacy non-ULID id still matches itself exactly.
 */
export function resolveWorkspaceAddress<W extends WorkspaceIdentity>(
  entries: readonly W[],
  address: string,
): W | null {
  const parsed = parseWorkspaceAddress(address)
  if (parsed === null) return null
  if (parsed.form === 'bare') return entries.find((w) => w.workspaceId === address) ?? null
  const resolved = resolveWorkspaceHandle(entries, address)
  return resolved === null
    ? null
    : (entries.find((w) => w.workspaceId === resolved.workspaceId) ?? null)
}

/**
 * The link to hand to somebody else: the opaque `/w/<workspaceId>`, never
 * the in-app address (ADR-0053 decision 1). A link may reach a person who is
 * not a member, and the readable form would tell them the holder's handle
 * and what the workspace is called. The app moves a member who opens it onto
 * the readable form once access is known.
 */
export function workspaceLink(origin: string, workspace: WorkspaceIdentity): string {
  return `${origin}${workspacePath(workspace.workspaceId)}`
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

/**
 * The same address for a workspace that may not have resolved yet.
 *
 * Its one caller subscribes to an identity that is `null` until the browser's
 * own record settles (`boot.ts` bounds that resolve at 3s and renders
 * degraded past it), and a URL builder that cannot name its workspace
 * declines to navigate rather than sending the session somewhere wrong.
 */
export function workspaceHandleOrNull(workspace: WorkspaceIdentity | null): string | null {
  return workspace === null ? null : workspaceHandle(workspace)
}
