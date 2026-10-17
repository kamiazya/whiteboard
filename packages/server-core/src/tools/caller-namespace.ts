import { SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '../server-deps.js'

/** Whose namespace a bare segment means for this call: the deps' answer, else `me`. */
export async function callerNamespaceOf(
  deps: Pick<ServerDeps, 'callerNamespace'>,
  request?: Request,
): Promise<string> {
  return (await deps.callerNamespace?.(request)) ?? SINGLE_PERSON_NAMESPACE
}

/**
 * The workspace `handle` names for the caller (ADR-0053), or null. Every
 * resolution in this package goes through here, so none of them can read a
 * bare segment in a namespace other than the one the keeper's gate used.
 */
export async function resolveWorkspaceFor(
  deps: Pick<ServerDeps, 'documentIndex' | 'callerNamespace'>,
  handle: string,
  request?: Request,
): Promise<WorkspaceEntry | null> {
  return deps.documentIndex.resolveWorkspace(handle, await callerNamespaceOf(deps, request))
}
