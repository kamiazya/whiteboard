/**
 * Where an incoming workspace ADDRESS becomes a workspace id.
 *
 * ADR-0019 splits one string into three layers, two of which — the canonical
 * id and the per-keeper `segment` — can both arrive in the same position of a
 * URL, a sync-stream target, or an MCP tool argument. `resolveWorkspaceHandle` in ports
 * fixes which wins; this file is where that decision is APPLIED, once, at the
 * request boundary.
 *
 * Once is the load-bearing word. Everything downstream keys on the resolved
 * id — workspace write locks, document caches, sync-stream `docKey`s — and two
 * of those resolving independently is how one request ends up holding a lock
 * under one spelling while writing under another.
 */
import type { ServerDeps } from './server-deps.js'
import { resolveWorkspaceFor } from './tools/caller-namespace.js'
import {
  inTheCallersWords,
  ownsWorkspaceRefusal,
  unknownWorkspaceRefusal,
} from './tools/caller-refusals.js'

/** The shape every tool in `createServer`'s record shares. */
interface WorkspaceScopedTool {
  inputSchema?: unknown
  execute(input: never): Promise<unknown>
}

/**
 * Wraps a record of tools so each one resolves `input.workspaceId` before its
 * own `execute` sees it.
 *
 * A wrapper over the RECORD rather than an edit in each of the fourteen tools:
 * a per-tool step is a step the fifteenth tool will not have, and its absence
 * looks exactly like a tool nobody addresses by segment yet.
 *
 * The tool object is spread rather than rebuilt, so `inputSchema` and
 * `outputSchema` keep their identities — `registerToolWithAnnotations` is
 * generic over the output schema, and a copy would break that binding.
 */
export function withResolvedWorkspaceHandles<T extends Record<string, WorkspaceScopedTool>>(
  tools: T,
  deps: Pick<ServerDeps, 'documentIndex' | 'callerNamespace' | 'knownWorkspaceHandles'>,
): T {
  const wrapped: Record<string, WorkspaceScopedTool> = {}
  for (const [key, tool] of Object.entries(tools)) {
    wrapped[key] = {
      ...tool,
      async execute(input: never) {
        const scoped = input as { workspaceId?: unknown; documentId?: unknown }
        if (typeof scoped?.workspaceId !== 'string') return tool.execute(input)
        const handle = scoped.workspaceId
        const resolved = await resolveWorkspaceFor(deps, handle)
        if (resolved === null && !ownsWorkspaceRefusal(tool)) {
          throw await unknownWorkspaceRefusal(handle, deps.knownWorkspaceHandles)
        }
        const workspaceId = resolved?.workspaceId ?? handle
        try {
          return await tool.execute({ ...scoped, workspaceId } as never)
        } catch (err) {
          throw await inTheCallersWords(err, {
            index: deps.documentIndex,
            handle,
            workspaceId,
            documentId: scoped.documentId,
          })
        }
      },
    }
  }
  return wrapped as T
}
