import { serializeSceneAsExcalidrawJson } from '../excalidraw-json.js'
import {
  CommandError,
  type ExportJsonInput,
  type ExportJsonResult,
  exportJsonInputSchema,
  exportJsonResultSchema,
  type WhiteboardCommandDeps,
  type WhiteboardCommands,
} from './types.js'

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
    const parsedInput = exportJsonInputSchema.safeParse(input)
    if (!parsedInput.success) {
      throw new CommandError('invalid-input', 'exportJson received an invalid input payload.', {
        cause: parsedInput.error,
      })
    }

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

  return { exportJson }
}
