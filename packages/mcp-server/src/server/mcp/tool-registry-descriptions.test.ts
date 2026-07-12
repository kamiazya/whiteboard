// Registry-wide contract: every field in every registered tool's inputSchema
// must carry a non-empty description. The MCP SDK derives tools/list JSON
// Schema straight from the ZodRawShape passed to registerToolWithAnnotations
// (see tool-registration.ts), so an undescribed field here is exactly what an
// MCP client (including the LLM calling the tool) would see as undocumented.
//
// This test mirrors the exact set of `inputSchema:` values passed to
// defineTool() in tool-registration.ts. If a new tool is added there without
// field descriptions, this test fails — it is the last line of defense
// against the annotate_batch groupAs class of doc/schema drift.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { annotateBatchInputShape } from './tools/annotate-batch.js'
import { annotateInputShape } from './tools/annotate.js'
import { canvasAutoLayoutInputShape } from './tools/canvas-auto-layout.js'
import { canvasInspectInputShape } from './tools/canvas-inspect.js'
import {
  canvasCreateInputShape,
  canvasListInputShape,
  canvasOpenInputShape,
  optimizeCanvasesInputShape,
} from './tools/canvas.js'
import {
  alignInputSchema,
  assignToGroupInputShape,
  canvasClearInputShape,
  deleteElementInputShape,
  deleteElementsInputShape,
  deleteGroupInputShape,
  distributeInputSchema,
  listGroupsInputShape,
  moveElementsInputShape,
  reorderElementsInputShape,
  updateElementInputShape,
} from './tools/element-ops-tools.js'
import { exportCanvasInputShape } from './tools/export-canvas.js'
import { exportSvgInputShape } from './tools/export-svg.js'
import {
  createEmbedInputShape,
  createFrameInputShape,
  updateFrameMembersInputShape,
} from './tools/frame-embed.js'
import { libraryCatalogListInputShape } from './tools/library-catalog.js'
import {
  libraryInsertBatchInputShape,
  libraryInsertItemInputShape,
  libraryInstallInputShape,
  libraryListInstalledInputShape,
  libraryListItemsInputShape,
  libraryUninstallInputShape,
  userLibraryListInputShape,
  userLibraryMetadataDeleteInputShape,
  userLibraryMetadataGetInputShape,
  userLibraryMetadataSetInputShape,
  userLibraryRemoveInputShape,
  userLibrarySaveInputShape,
} from './tools/library.js'
import { loadImageInputShape } from './tools/load.js'
import {
  paletteDeleteInputShape,
  paletteGetInputShape,
  paletteSetInputShape,
} from './tools/palette.js'
import { createPairingLinkInputShape } from './tools/pairing-link.js'
import { insertTemplateInputShape, listTemplatesInputShape } from './tools/template.js'
import {
  versionListInputShape,
  versionRestoreInputShape,
  versionSaveInputShape,
} from './tools/version.js'
import { viewportSetInputShape } from './tools/viewport.js'

// name -> the same value passed as `inputSchema:` in tool-registration.ts's
// defineTool() calls (either a ZodRawShape or, for align/distribute, the
// `.shape` of an already-built ZodObject).
const REGISTERED_INPUT_SHAPES: Record<string, z.ZodRawShape> = {
  canvas_create: canvasCreateInputShape,
  canvas_list: canvasListInputShape,
  canvas_open: canvasOpenInputShape,
  optimize_canvases: optimizeCanvasesInputShape,
  load_image: loadImageInputShape,
  annotate: annotateInputShape,
  annotate_batch: annotateBatchInputShape,
  palette_get: paletteGetInputShape,
  palette_set: paletteSetInputShape,
  palette_delete: paletteDeleteInputShape,
  export_svg: exportSvgInputShape,
  export_canvas: exportCanvasInputShape,
  viewport_set: viewportSetInputShape,
  canvas_auto_layout: canvasAutoLayoutInputShape,
  library_list_items: libraryListItemsInputShape,
  library_insert_item: libraryInsertItemInputShape,
  library_insert_batch: libraryInsertBatchInputShape,
  library_install: libraryInstallInputShape,
  library_uninstall: libraryUninstallInputShape,
  library_list_installed: libraryListInstalledInputShape,
  library_catalog_list: libraryCatalogListInputShape,
  user_library_save: userLibrarySaveInputShape,
  user_library_list: userLibraryListInputShape,
  user_library_remove: userLibraryRemoveInputShape,
  user_library_metadata_get: userLibraryMetadataGetInputShape,
  user_library_metadata_set: userLibraryMetadataSetInputShape,
  user_library_metadata_delete: userLibraryMetadataDeleteInputShape,
  canvas_inspect: canvasInspectInputShape,
  template_list: listTemplatesInputShape,
  template_insert: insertTemplateInputShape,
  update_element: updateElementInputShape,
  delete_element: deleteElementInputShape,
  delete_elements: deleteElementsInputShape,
  assign_to_group: assignToGroupInputShape,
  delete_group: deleteGroupInputShape,
  list_groups: listGroupsInputShape,
  move_elements: moveElementsInputShape,
  align_elements: alignInputSchema.shape,
  distribute_elements: distributeInputSchema.shape,
  reorder_elements: reorderElementsInputShape,
  canvas_clear: canvasClearInputShape,
  version_save: versionSaveInputShape,
  version_restore: versionRestoreInputShape,
  version_list: versionListInputShape,
  create_frame: createFrameInputShape,
  update_frame_members: updateFrameMembersInputShape,
  create_embed: createEmbedInputShape,
  create_pairing_link: createPairingLinkInputShape,
}

interface JsonSchemaNode {
  type?: string
  description?: unknown
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
}

// Bare `x` / `y` coordinate leaves are exempt: the codebase's established
// convention (annotate.ts's `target` / `endTarget`, predating this guard)
// describes the coordinate PAIR at the parent field ("Top-left position...")
// and leaves the numeric x/y leaves themselves undescribed as self-evident.
// Enforcing descriptions on x/y everywhere would fight that precedent across
// every tool that accepts a point, for no documentation gain.
const SELF_EVIDENT_LEAF_KEYS = new Set(['x', 'y'])

// Recursively walk properties (and array item shapes) and collect every
// field path that is missing a non-empty description. Top-level shapes
// with zero fields (e.g. template_list) trivially pass.
function collectUndescribedFields(node: JsonSchemaNode, path: string, out: string[]): void {
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      const childPath = path ? `${path}.${key}` : key
      if (!SELF_EVIDENT_LEAF_KEYS.has(key)) {
        const description = child.description
        if (typeof description !== 'string' || description.trim().length === 0) {
          out.push(childPath)
        }
      }
      collectUndescribedFields(child, childPath, out)
      if (child.items) {
        collectUndescribedFields(child.items, `${childPath}[]`, out)
      }
    }
  }
}

describe('registered tool inputSchema descriptions', () => {
  for (const [toolName, shape] of Object.entries(REGISTERED_INPUT_SHAPES)) {
    it(`${toolName}: every inputSchema field (including nested) has a description`, () => {
      const jsonSchema = z.toJSONSchema(z.object(shape)) as JsonSchemaNode
      const undescribed: string[] = []
      collectUndescribedFields(jsonSchema, '', undescribed)
      expect(undescribed, `${toolName} has undescribed fields: ${undescribed.join(', ')}`).toEqual(
        [],
      )
    })
  }

  it('covers every tool registered in tool-registration.ts (guards against a silently-skipped new tool)', () => {
    // Kept in sync manually with the `inputSchema:` count in tool-registration.ts.
    // A mismatch here means a new tool was registered without adding it above.
    expect(Object.keys(REGISTERED_INPUT_SHAPES)).toHaveLength(48)
  })
})
