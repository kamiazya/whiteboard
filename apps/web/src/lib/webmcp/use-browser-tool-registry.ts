import { useEffect } from 'react'
import { getAppLogger } from '../app-logger.js'
import type { WhiteboardCommands } from '../commands/index.js'
import { webMcpTools } from './tool-definitions.js'

const log = getAppLogger('use-browser-tool-registry')

/**
 * Ambient shape of Chrome's imperative WebMCP API, confined to this single
 * file so a future CG Draft rename only requires editing here. Per
 * developer.chrome.com/docs/ai/webmcp/imperative-api (checked at
 * implementation time) the surface hangs off `document`, not `navigator`.
 * `registerTool` is async (registration is not synchronous) and takes an
 * `AbortSignal` for cancellation instead of returning an unregister handle.
 */
export interface WebMcpToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations?: { readonly readOnlyHint?: boolean }
  execute(args: unknown): Promise<unknown>
}

export interface ModelContext {
  registerTool(descriptor: WebMcpToolDescriptor, options: { signal: AbortSignal }): Promise<void>
}

// document.modelContext is not yet in lib.dom.d.ts; declared narrowly here
// rather than widened to `unknown` so registerTool's descriptor shape stays
// type-checked at the one call site that uses it.
declare global {
  interface Document {
    modelContext?: ModelContext
  }
}

/**
 * Feature-detects Chrome's WebMCP `document.modelContext` and, when present,
 * registers this app's read-only tools for the lifetime of the given canvas
 * identity — re-registering on identity change and cancelling registration
 * (via AbortController) on unmount. In a browser without `document.modelContext`
 * this hook is a complete no-op: no listeners, no registration attempts, no
 * UI impact.
 *
 * Every tool this app exposes reads canvas state (`no-canvas` is one of
 * every command's documented CommandError codes), so `canvasKey === null`
 * (no canvas open yet, or none selected) also skips registration entirely
 * rather than advertising tools that would deterministically fail if
 * called.
 *
 * `enabled` mirrors the user's persisted `capabilities.webMcpEnabled`
 * setting (see user-settings-store.ts) — defaults to `true` so existing
 * callers that don't pass it keep today's behavior, but an explicit `false`
 * unregisters/skips registration the same way an absent `document.modelContext`
 * does.
 *
 * `commands` must be the same referentially-stable `WhiteboardCommands`
 * instance `useWhiteboardCommands` returns — each tool executor is a
 * one-line call into it (`commands.getAppContext()`, etc.), never
 * duplicated business logic.
 */
export function useBrowserToolRegistry(
  commands: WhiteboardCommands,
  canvasKey: string | null,
  enabled = true,
): void {
  useEffect(() => {
    const modelContext = document.modelContext
    if (!modelContext || !enabled || canvasKey === null) return

    const controller = new AbortController()
    for (const tool of webMcpTools) {
      const descriptor: WebMcpToolDescriptor = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnlyHint },
        execute: (args) => tool.execute(commands, args),
      }
      // A rejected registration (e.g. aborted before the browser finishes
      // registering, a duplicate-name refusal, or a draft-API incompatibility)
      // must not become an unhandled promise rejection — there is no UI
      // surface to report it to. It is still logged (dev-only, via
      // getAppLogger) so a silently-missing tool is at least visible during
      // development instead of only inferable from its absence. The catch
      // runs even after an abort-triggered rejection since `.catch` always
      // attaches regardless of ordering against `controller.abort()` below.
      modelContext.registerTool(descriptor, { signal: controller.signal }).catch((err: unknown) => {
        // An abort is the normal unmount/canvas-switch/StrictMode path, not a
        // failure — logging it would fill the console with false positives on
        // every teardown. Only genuine registration failures are surfaced.
        if (controller.signal.aborted) return
        log.warn(`registerTool(${tool.name}) failed`, err)
      })
    }

    return () => {
      controller.abort()
    }
    // `commands` is included even though useWhiteboardCommands keeps it
    // referentially stable across re-renders: listing it here documents the
    // real dependency instead of relying on that stability contract holding
    // forever.
  }, [commands, canvasKey, enabled])
}
