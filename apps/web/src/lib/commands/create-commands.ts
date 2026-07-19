import { serializeSceneAsExcalidrawJson } from '@kamiazya/whiteboard-canvas-viewer/scene'
import type { z } from 'zod'
import {
  CommandError,
  type ExportJsonInput,
  type ExportJsonResult,
  exportJsonInputSchema,
  exportJsonResultSchema,
  type GetAppContextInput,
  type GetAppContextResult,
  getAppContextInputSchema,
  getAppContextResultSchema,
  type GetSceneSummaryInput,
  type GetSceneSummaryResult,
  getSceneSummaryInputSchema,
  getSceneSummaryResultSchema,
  type WhiteboardCommandDeps,
  type WhiteboardCommands,
} from './types.js'

// Every command validates its input the same way: parse against its Zod
// schema and turn any failure into a typed `invalid-input` CommandError so
// consumers branch on `.code` instead of a raw ZodError. `commandName` only
// shapes the human-readable message.
function assertValidInput(schema: z.ZodTypeAny, input: unknown, commandName: string): void {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new CommandError('invalid-input', `${commandName} received an invalid input payload.`, {
      cause: parsed.error,
    })
  }
}

// Projects the open-canvas identity into the tool-facing shape field-by-field
// (never a spread) so a daemon canvas exposes only workspaceId/slug and a
// browser-local canvas only canvasId — no other ProviderState/canvas field
// can leak through.
function projectCanvasContext(
  canvas: WhiteboardCommandDeps['canvas'],
): GetAppContextResult['canvas'] {
  if (!canvas) return null
  if (canvas.workspaceId !== undefined) {
    return { kind: 'daemon', workspaceId: canvas.workspaceId, slug: canvas.canvasId }
  }
  return { kind: 'browser-local', canvasId: canvas.canvasId }
}

// Exhaustive over every ProviderState.kind rather than a two-way ternary: an
// `invalid-config` provider (a failed/rejected runtime config) has no
// meaningful "browser-local" or "daemon" mode to report, so getAppContext
// must fail loudly instead of guessing. The `default` branch's `never`
// assignment makes a future ProviderState variant a compile error here.
function projectProviderMode(
  provider: WhiteboardCommandDeps['provider'],
): 'daemon' | 'browser-local' {
  switch (provider.kind) {
    case 'local-daemon':
      return 'daemon'
    case 'browser-local':
      return 'browser-local'
    case 'invalid-config': {
      throw new CommandError(
        'invalid-provider-state',
        'Cannot report app context: the runtime provider configuration is invalid.',
      )
    }
    default: {
      const exhaustive: never = provider
      throw new CommandError(
        'invalid-provider-state',
        `Cannot report app context: unrecognized provider state "${String((exhaustive as { kind?: unknown }).kind)}".`,
      )
    }
  }
}

/**
 * createWhiteboardCommands — the framework-free factory behind
 * `WhiteboardCommands`. This is the single entry point a WebMCP tool
 * executor, an in-page assistant, or a manual Tools/debug panel should call
 * into for a UI operation: `commands.<method>(args)`, one line, no business
 * logic duplicated at the call site.
 *
 * `depsRef` carries the runtime dependencies (which canvas is open, which
 * provider is active, a handle to the mounted Excalidraw imperative API) as
 * a mutable ref rather than plain arguments. A command can be long-running
 * (an in-flight fetch, a slow scene read) while the surrounding React tree
 * re-renders, switches canvases, or unmounts; reading `depsRef.current`
 * fresh at the start of every call — and capturing it into a local before
 * doing any async work — means a call in flight keeps running against the
 * identity it started with, while the next call always sees the latest one.
 * Closing over `deps` directly (the classic stale-closure bug) would instead
 * freeze every future call to whatever was current when the commands object
 * was created.
 *
 * exportJson runs entirely in-browser regardless of provider: it reads the
 * live scene straight from the mounted Excalidraw instance the same way the
 * existing header "Export" affordance always has. This is deliberately not
 * the same product surface as the local-daemon's `POST
 * /api/canvas/:workspaceId/:slug/export-json` endpoint, which persists a
 * file server-side and returns a `{filePath, elementCount}` pointer with no
 * scene payload — a different affordance for a different consumer. Nothing
 * here calls that endpoint, and no other command in this layer currently
 * needs the daemon's HTTP client at all.
 *
 * To add the next command:
 * 1. Declare its input/output Zod schemas in types.ts (derive types via
 *    `z.infer`, never a hand-written parallel interface).
 * 2. Add the method here: parse the input, read `depsRef.current` into a
 *    local before any `await`, dispatch to the provider-appropriate code
 *    path, then parse the result against its output schema before
 *    returning it.
 * 3. Add it to the `WhiteboardCommands` interface in types.ts and to the
 *    object returned below.
 */
export function createWhiteboardCommands(depsRef: {
  current: WhiteboardCommandDeps
}): WhiteboardCommands {
  async function exportJson(input: ExportJsonInput = {}): Promise<ExportJsonResult> {
    assertValidInput(exportJsonInputSchema, input, 'exportJson')

    // Captured before any await so a concurrent depsRef swap (unmount,
    // canvas switch, provider change) can never mutate the identity this
    // in-flight call already committed to.
    const deps = depsRef.current
    if (!deps.canvas) {
      throw new CommandError('no-canvas', 'No canvas is selected to export from.')
    }
    const api = deps.getExcalidrawApi()
    if (!api) {
      throw new CommandError('no-api', 'No Excalidraw canvas is mounted to export from.')
    }

    try {
      // `await`ing a plain value still yields one microtask — proving that the
      // `api` captured above stays the one this call uses even if depsRef is
      // swapped in that window.
      const elements = await Promise.resolve(api.getSceneElements())
      const appState = api.getAppState()
      const files = api.getFiles()
      const doc = serializeSceneAsExcalidrawJson(elements, appState, files)
      return exportJsonResultSchema.parse(doc)
    } catch (err) {
      // Every documented failure mode of this command is a CommandError so
      // consumers (WebMCP adapter, debug panel) can branch on `.code` instead
      // of parsing an arbitrary thrown error/message.
      throw new CommandError('export-failed', 'Failed to read or serialize the live scene.', {
        cause: err,
      })
    }
  }

  async function getSceneSummary(input: GetSceneSummaryInput = {}): Promise<GetSceneSummaryResult> {
    assertValidInput(getSceneSummaryInputSchema, input, 'getSceneSummary')

    const deps = depsRef.current
    if (!deps.canvas) {
      throw new CommandError('no-canvas', 'No canvas is selected to summarize.')
    }
    const api = deps.getExcalidrawApi()
    if (!api) {
      throw new CommandError('no-api', 'No Excalidraw canvas is mounted to summarize.')
    }

    const elements = api.getSceneElements()
    const appState = api.getAppState()
    // Deleted elements are tombstones, not live content — excluded from
    // every count so a tool-facing summary never reports elements the user
    // believes they removed.
    const liveElements = elements.filter((element) => !element.isDeleted)
    const typeCounts: Record<string, number> = {}
    for (const element of liveElements) {
      typeCounts[element.type] = (typeCounts[element.type] ?? 0) + 1
    }

    return getSceneSummaryResultSchema.parse({
      elementCount: liveElements.length,
      selectedCount: Object.keys(appState.selectedElementIds).length,
      typeCounts,
      viewport: {
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: appState.zoom.value,
      },
    })
  }

  async function getAppContext(input: GetAppContextInput = {}): Promise<GetAppContextResult> {
    assertValidInput(getAppContextInputSchema, input, 'getAppContext')

    const deps = depsRef.current
    // Field-by-field, never a spread of `deps.provider` — this is the
    // boundary that keeps daemonBaseUrl (and any future connection-ish
    // field ProviderState grows) out of a WebMCP tool result. The switch is
    // exhaustive over every ProviderState.kind (checked by the `never`
    // assignment in default) so a future ProviderState variant fails
    // typecheck here instead of silently falling through to the wrong mode.
    const provider: GetAppContextResult['provider'] = { mode: projectProviderMode(deps.provider) }
    const canvas = projectCanvasContext(deps.canvas)

    return getAppContextResultSchema.parse({ provider, canvas })
  }

  return { exportJson, getSceneSummary, getAppContext }
}
