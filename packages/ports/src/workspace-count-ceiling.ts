/**
 * The most workspaces one NAMESPACE may hold on a keeper shared by several
 * people (server mode). Every member of a tenant shares one registry, and the
 * listing reads all of it, so a namespace without a bound is a way for one
 * person to make every other person's requests cost more.
 *
 * Generous on purpose: a person organises a handful to a few dozen, and a
 * switcher listing a thousand is already past what anyone scrolls — so the
 * bound is never met by use, only by a script. Per namespace, not per
 * tenant, so one person reaching it costs nobody else a workspace.
 *
 * The single-person namespace is not held to it: a keeper with one person
 * (the local daemon, stdio) has nobody for its registry to slow down.
 */
export const NAMESPACE_MAX_WORKSPACES = 1000

/** A create refused because its namespace already holds `NAMESPACE_MAX_WORKSPACES`. Nothing was written. */
export class TooManyWorkspacesError extends Error {
  readonly code = 'too_many_workspaces'
  readonly status = 413

  constructor(public readonly namespace: string) {
    super(
      `"${namespace}" already holds ${NAMESPACE_MAX_WORKSPACES} workspaces, the most one person may hold on this server`,
    )
    this.name = 'TooManyWorkspacesError'
  }
}

/** Throws `TooManyWorkspacesError` when a namespace holding `held` workspaces cannot take one more. */
export function refuseNewWorkspace(namespace: string, held: number): void {
  if (held >= NAMESPACE_MAX_WORKSPACES) throw new TooManyWorkspacesError(namespace)
}
