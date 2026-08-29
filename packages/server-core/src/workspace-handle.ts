/**
 * Where an incoming workspace ADDRESS becomes a workspace id.
 *
 * ADR-0019 splits one string into three layers, two of which — the canonical
 * id and the per-keeper `segment` — can both arrive in the same position of a
 * URL, a WS target, or an MCP tool argument. `resolveWorkspaceHandle` in ports
 * fixes which wins; this file is where that decision is APPLIED, once, at the
 * request boundary.
 *
 * Once is the load-bearing word. Everything downstream keys on the resolved
 * id — workspace write locks, document caches, WS and SSE `docKey`s — and two
 * of those resolving independently is how one request ends up holding a lock
 * under one spelling while writing under another.
 */
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'

/**
 * The canonical id for `handle`, or `handle` unchanged when nothing answers
 * to it.
 *
 * Total by design: an unresolvable handle is NOT an error here. Passing it
 * through means the lookup that follows fails exactly as it did before
 * resolution existed — the same 404, the same `isError` text, from the same
 * place. Answering with an error of its own would put a second vocabulary in
 * front of every not-found, and every surface would have to learn it.
 */
export async function resolveWorkspaceId(index: DocumentIndex, handle: string): Promise<string> {
  return (await index.resolveWorkspace(handle))?.workspaceId ?? handle
}

/** The shape every tool in `createServer`'s record shares. */
interface WorkspaceScopedTool {
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
  index: DocumentIndex,
): T {
  const wrapped: Record<string, WorkspaceScopedTool> = {}
  for (const [key, tool] of Object.entries(tools)) {
    wrapped[key] = {
      ...tool,
      async execute(input: never) {
        const scoped = input as { workspaceId?: unknown }
        if (typeof scoped?.workspaceId !== 'string') return tool.execute(input)
        const workspaceId = await resolveWorkspaceId(index, scoped.workspaceId)
        return tool.execute({ ...scoped, workspaceId } as never)
      },
    }
  }
  return wrapped as T
}
