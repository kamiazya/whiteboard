import type { z } from 'zod'
import {
  CommandError,
  type GetAppContextInput,
  type GetAppContextResult,
  getAppContextInputSchema,
  getAppContextResultSchema,
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
// browser-local canvas only documentId — no other ProviderState/canvas field
// can leak through.
function projectCanvasContext(
  canvas: WhiteboardCommandDeps['canvas'],
): GetAppContextResult['canvas'] {
  if (!canvas) return null
  if (canvas.workspaceId !== undefined) {
    return { kind: 'daemon', workspaceId: canvas.workspaceId, slug: canvas.documentId }
  }
  return { kind: 'browser-local', documentId: canvas.documentId }
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
 * provider is active) as a mutable ref rather than plain arguments. A
 * command can be long-running (an in-flight fetch, a slow scene read) while
 * the surrounding React tree re-renders, switches canvases, or unmounts;
 * reading `depsRef.current` fresh at the start of every call — and
 * capturing it into a local before doing any async work — means a call in
 * flight keeps running against the identity it started with, while the next
 * call always sees the latest one. Closing over `deps` directly (the
 * classic stale-closure bug) would instead freeze every future call to
 * whatever was current when the commands object was created.
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
    // canvas.kind (from projectCanvasContext, keyed on identity.workspaceId)
    // and provider.mode (from projectProviderMode, keyed on ProviderState.kind)
    // are derived from two independent inputs — assert they agree rather
    // than let a future call site construct a result where they silently
    // disagree. Not part of getAppContextResultSchema itself: see that
    // schema's module comment for why.
    if (canvas !== null && canvas.kind !== provider.mode) {
      throw new CommandError(
        'invalid-provider-state',
        'Cannot report app context: the derived canvas kind does not match the provider mode.',
      )
    }

    return getAppContextResultSchema.parse({ provider, canvas })
  }

  return { getAppContext }
}
