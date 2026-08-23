import { z } from 'zod'
import type { ProviderState } from '../provider.js'

export interface WhiteboardCommandDocumentIdentity {
  workspaceId?: string
  documentId: string
  name: string
}

// Runtime dependencies a command needs at call time. Never captured by
// closure — see create-commands.ts's module doc for why this travels as a
// ref instead.
export interface WhiteboardCommandDeps {
  provider: ProviderState
  canvas: WhiteboardCommandDocumentIdentity | null
}

export type CommandErrorCode = 'invalid-input' | 'invalid-provider-state'

// Every command failure surfaces as this typed error rather than a raw
// TypeError from an undefined access, so every consumer (WebMCP adapter,
// debug panel) can branch on `.code` instead of parsing a message string.
export class CommandError extends Error {
  readonly code: CommandErrorCode
  // Declared explicitly: this repo's apps/web tsconfig targets ES2020, whose
  // lib.es2020.d.ts predates the ES2022 Error `cause` option/property.
  readonly cause?: unknown

  constructor(code: CommandErrorCode, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'CommandError'
    this.code = code
    this.cause = options?.cause
  }
}

// getAppContext takes no options today; parsed anyway for the same reason
// as the other command input schemas.
export const getAppContextInputSchema = z.object({}).strict()
export type GetAppContextInput = z.infer<typeof getAppContextInputSchema>

// The provider projection is built field-by-field in create-commands.ts
// (never a spread of the real ProviderState) so this schema is the
// contract that keeps daemonBaseUrl — and any future connection-ish field
// added to ProviderState — out of a WebMCP tool result. The values are
// spelled out here rather than re-exported from ProviderState.kind: this is
// a tool-facing vocabulary that agents read, so it changes on its own terms.
//
// Deliberately structural-only: this schema mirrors the static
// get-app-context.schema.json literal field-for-field (see
// tool-definitions.test.ts's fuzzed agreement check), and plain JSON Schema
// cannot express "canvas.kind must equal provider.mode". That invariant is
// enforced separately in create-commands.ts's getAppContext, immediately
// after projecting the result and before this schema parses it — do not
// re-add it here as a `.refine`, or the JSON-Schema/Zod agreement property
// test will start failing on canvas/provider combinations the literal
// cannot reject.
export const getAppContextResultSchema = z
  .object({
    provider: z
      .object({
        mode: z.enum(['daemon', 'browser']),
      })
      .strict(),
    canvas: z
      .union([
        z
          .object({
            kind: z.literal('daemon'),
            workspaceId: z.string(),
            path: z.string(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('browser'),
            documentId: z.string(),
          })
          .strict(),
      ])
      .nullable(),
  })
  .strict()
export type GetAppContextResult = z.infer<typeof getAppContextResultSchema>

export interface WhiteboardCommands {
  getAppContext(input?: GetAppContextInput): Promise<GetAppContextResult>
}
