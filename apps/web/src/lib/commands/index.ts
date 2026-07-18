/**
 * WhiteboardCommands — the provider-aware command layer for apps/web's UI
 * operations.
 *
 * This is the common entry point for every surface that needs to drive the
 * canvas programmatically: a WebMCP tool executor, an in-page assistant, or
 * a manual Tools/debug panel. Each of those consumers should be able to
 * obtain a `WhiteboardCommands` instance (via `useWhiteboardCommands` in a
 * component, or `createWhiteboardCommands` outside React) and call into it
 * with a single line — `commands.exportJson(...)` — with no business logic
 * duplicated at the call site.
 *
 * Today this exposes one command, `exportJson`; see create-commands.ts's
 * doc comment for the extension recipe for the next one.
 */
export { createWhiteboardCommands } from './create-commands.js'
export { createSceneExportHandler } from './create-export-handler.js'
export {
  CommandError,
  type CommandErrorCode,
  type ExcalidrawApiHandle,
  type ExportJsonInput,
  type ExportJsonResult,
  exportJsonInputSchema,
  exportJsonResultSchema,
  type WhiteboardCommandCanvasIdentity,
  type WhiteboardCommandDeps,
  type WhiteboardCommands,
} from './types.js'
export { useWhiteboardCommands } from './use-whiteboard-commands.js'
