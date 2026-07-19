import { useEffect } from 'react'
import type { WhiteboardCommands } from '../commands/index.js'
import { webMcpTools } from './tool-definitions.js'

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
 * `commands` must be the same referentially-stable `WhiteboardCommands`
 * instance `useWhiteboardCommands` returns — each tool executor is a
 * one-line call into it (`commands.getAppContext()`, etc.), never
 * duplicated business logic.
 */
export function useBrowserToolRegistry(
  commands: WhiteboardCommands,
  canvasKey: string | null,
): void {
  useEffect(() => {
    const modelContext = document.modelContext
    if (!modelContext) return
    // canvasKey is intentionally not read past this point beyond re-running
    // the effect: it exists purely to force re-registration when the open
    // canvas changes, mirroring the pattern useCanvasSync already uses for
    // its own identity-keyed effects.
    void canvasKey

    const controller = new AbortController()
    for (const tool of webMcpTools) {
      const descriptor: WebMcpToolDescriptor = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: () => tool.execute(commands),
      }
      // A rejected registration (e.g. aborted before the browser finishes
      // registering, or the browser refuses a duplicate name) must not
      // become an unhandled promise rejection — there is no UI surface to
      // report it to, so it is swallowed here. The catch runs even after
      // an abort-triggered rejection since `.catch` always attaches
      // regardless of ordering against `controller.abort()` below.
      modelContext.registerTool(descriptor, { signal: controller.signal }).catch(() => {})
    }

    return () => {
      controller.abort()
    }
    // `commands` is included even though useWhiteboardCommands keeps it
    // referentially stable across re-renders: listing it here documents the
    // real dependency instead of relying on that stability contract holding
    // forever.
  }, [commands, canvasKey])
}
