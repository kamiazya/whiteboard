import { describe, expect, it } from 'vitest'
import { TOOL_PROFILES } from './tool-profiles.js'

// The set of tools actually registered by registerOpenCanvasTools
// (opencanvas-tools.ts) plus 'reindex', which is defined in server-core's
// tools map but not yet wired as a standalone MCP tool. Every removed
// Excalidraw-era tool name (canvas_list, export_svg, create_frame, etc.)
// must have no entry here — a stale entry gives a client a misleading
// approval-policy hint for a tool that no longer exists.
const ACTIVE_TOOL_NAMES = [
  'facet_set',
  'node_patch',
  'edge_patch',
  'body_patch',
  'canvas_render_svg',
  'canvas_digest',
  'canvas_export_okf',
  'canvas_export_json_canvas',
  'wb_canvas_create',
  'wb_canvas_list',
  'wb_canvas_get',
  'wb_canvas_delete',
  'version_save',
  'version_restore',
  'version_list',
  'reindex',
]

describe('TOOL_PROFILES', () => {
  it('contains exactly the active OpenCanvas tool set (no dead Excalidraw entries)', () => {
    expect(Object.keys(TOOL_PROFILES).sort()).toEqual([...ACTIVE_TOOL_NAMES].sort())
  })

  it('marks reindex as read-only with a descriptive title', () => {
    expect(TOOL_PROFILES.reindex).toEqual({
      profile: { readOnlyHint: true, openWorldHint: false },
      title: 'Rebuild workspace index',
    })
  })
})
