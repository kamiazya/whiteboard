import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { z } from 'zod'
import { excalidrawJsonDocSchema } from '@kamiazya/whiteboard-canvas-viewer'
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

export type CommandErrorCode = 'no-api' | 'no-canvas' | 'invalid-input' | 'export-failed'

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

export interface WhiteboardCommands {
  exportJson(input?: ExportJsonInput): Promise<ExportJsonResult>
}
