/**
 * Tool factories and schemas that tests in other packages drive directly,
 * forwarded from their defining modules. The package root forwards only
 * what shipped code imports, so a name a test alone needs belongs here
 * rather than keeping a root forward alive.
 */
import { createThreadEditTool } from '../tools/thread-edit.js'
import { makeTestDeps } from './make-test-deps.js'

export { canvasSnapshotSchema } from '../tools/canvas-snapshot.js'
export {
  canvasViewInputSchema,
  canvasViewOutputSchema,
  createCanvasViewTool,
} from '../tools/canvas-view.js'
export { createFacetListTool } from '../tools/facet-list.js'
export { createVersionListTool } from '../tools/version-list.js'
export { createVersionRestoreTool, versionRestoreOutputSchema } from '../tools/version-restore.js'
export { createVersionSaveTool } from '../tools/version-save.js'
export { createWorkspaceEditTool } from '../tools/workspace-edit.js'

/** What `wb_thread_edit` registers, read off the tool so the schema stays the module's own. */
export const threadEditInputSchema = createThreadEditTool(makeTestDeps()).inputSchema
