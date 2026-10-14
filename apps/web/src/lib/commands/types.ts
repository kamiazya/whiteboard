import { z } from 'zod'
import type { ProviderState } from '../provider.js'

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
// The open document is named the same way whichever keeper holds it: since
// workspace identity is keeper-independent (ADR-0019), its id, document id
// and path mean the same on both, and the keeper is `provider.mode` alone.
// The document id is the one a daemon tool addresses a document by.
const documentIdentitySchema = z
  .object({
    workspaceId: z.string(),
    documentId: z.string(),
    path: z.string(),
  })
  .strict()
type WhiteboardCommandDocumentIdentity = z.infer<typeof documentIdentitySchema>

export const getAppContextResultSchema = z
  .object({
    provider: z
      .object({
        mode: z.enum(['daemon', 'browser']),
      })
      .strict(),
    canvas: documentIdentitySchema.nullable(),
  })
  .strict()
export type GetAppContextResult = z.infer<typeof getAppContextResultSchema>

export interface WhiteboardCommands {
  getAppContext(input?: GetAppContextInput): Promise<GetAppContextResult>
}
