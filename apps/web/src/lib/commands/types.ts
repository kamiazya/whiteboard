import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { z } from 'zod'
import { excalidrawJsonDocSchema } from '@kamiazya/whiteboard-canvas-viewer/scene'
import type { ProviderState } from '../provider.js'

// exportJson takes no options today; parsed anyway so every command in this
// layer goes through the same "schema.parse(input) at the boundary" shape,
// and a future option can be added to this schema without touching the
// factory's call signature.
export const exportJsonInputSchema = z.object({}).strict()
export type ExportJsonInput = z.infer<typeof exportJsonInputSchema>

// The .excalidraw envelope is the single source of truth for this result;
// re-used rather than redeclared so the command layer and the file-export
// format can never drift from each other.
export const exportJsonResultSchema = excalidrawJsonDocSchema
export type ExportJsonResult = z.infer<typeof exportJsonResultSchema>

// The narrow slice of ExcalidrawImperativeAPI the command layer actually
// calls. Kept as a Pick of the real type (not a hand-rolled shape) so a
// future Excalidraw upgrade that changes these method signatures fails
// typecheck here instead of silently drifting.
export type ExcalidrawApiHandle = Pick<
  ExcalidrawImperativeAPI,
  'getSceneElements' | 'getAppState' | 'getFiles'
>

export interface WhiteboardCommandCanvasIdentity {
  workspaceId?: string
  canvasId: string
  name: string
}

// Runtime dependencies a command needs at call time. Never captured by
// closure — see create-commands.ts's module doc for why this travels as a
// ref instead.
export interface WhiteboardCommandDeps {
  getExcalidrawApi: () => ExcalidrawApiHandle | null
  provider: ProviderState
  canvas: WhiteboardCommandCanvasIdentity | null
}

export type CommandErrorCode =
  | 'no-api'
  | 'no-canvas'
  | 'invalid-input'
  | 'export-failed'
  | 'summary-failed'
  | 'invalid-provider-state'

// Every command failure surfaces as this typed error rather than a raw
// TypeError from an undefined access (e.g. a null Excalidraw API), so every
// consumer (WebMCP adapter, debug panel) can branch on `.code` instead of
// parsing a message string.
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

// getSceneSummary takes no options today; parsed anyway so it matches the
// same "schema.parse(input) at the boundary" shape as every other command.
export const getSceneSummaryInputSchema = z.object({}).strict()
export type GetSceneSummaryInput = z.infer<typeof getSceneSummaryInputSchema>

// Deliberately NOT the full scene: this is the exfiltration-surface boundary
// for a WebMCP tool result — counts and viewport only, never element
// geometry, text content, or file/image data. isDeleted elements are
// excluded from both elementCount and typeCounts so a tombstoned element a
// user thinks is gone never shows up in a tool-facing summary.
export const getSceneSummaryResultSchema = z
  .object({
    elementCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    typeCounts: z.record(z.string(), z.number().int().nonnegative()),
    viewport: z
      .object({
        scrollX: z.number().finite(),
        scrollY: z.number().finite(),
        zoom: z.number().finite(),
      })
      .strict(),
  })
  .strict()
export type GetSceneSummaryResult = z.infer<typeof getSceneSummaryResultSchema>

// getAppContext takes no options today; parsed anyway for the same reason
// as the other command input schemas.
export const getAppContextInputSchema = z.object({}).strict()
export type GetAppContextInput = z.infer<typeof getAppContextInputSchema>

// The provider projection is built field-by-field in create-commands.ts
// (never a spread of the real ProviderState) so this schema is the
// contract that keeps daemonBaseUrl — and any future connection-ish field
// added to ProviderState — out of a WebMCP tool result. "local-daemon" is
// renamed to "daemon" here because this is a tool-facing vocabulary, not a
// re-export of the internal ProviderState.kind literal.
export const getAppContextResultSchema = z
  .object({
    provider: z
      .object({
        mode: z.enum(['daemon', 'browser-local']),
      })
      .strict(),
    canvas: z
      .union([
        z
          .object({
            kind: z.literal('daemon'),
            workspaceId: z.string(),
            slug: z.string(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('browser-local'),
            canvasId: z.string(),
          })
          .strict(),
      ])
      .nullable(),
  })
  .strict()
export type GetAppContextResult = z.infer<typeof getAppContextResultSchema>

export interface WhiteboardCommands {
  exportJson(input?: ExportJsonInput): Promise<ExportJsonResult>
  getSceneSummary(input?: GetSceneSummaryInput): Promise<GetSceneSummaryResult>
  getAppContext(input?: GetAppContextInput): Promise<GetAppContextResult>
}
