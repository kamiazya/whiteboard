import { describe, expect, it } from 'vitest'
import { TOOL_PROFILES } from './tool-profiles.js'

// Tools actually registered by registerOpenCanvasTools (opencanvas-tools.ts).
// Every removed Excalidraw-era tool name (canvas_list, export_svg,
// create_frame, etc.) must have no entry here — a stale entry gives a
// client a misleading approval-policy hint for a tool that no longer exists.
const ACTIVE_TOOL_NAMES = [
  'facet_set',
  'node_lock',
  'node_patch',
  'edge_lock',
  'edge_patch',
  'tidy_canvas',
  'body_patch',
  'canvas_render_svg',
  'canvas_digest',
  'canvas_import_okf',
  'canvas_export_okf',
  'canvas_export_json_canvas',
  'wb_canvas_create',
  'wb_canvas_list',
  'wb_canvas_get',
  'wb_canvas_delete',
  'version_save',
  'version_restore',
  'version_list',
]

describe('TOOL_PROFILES', () => {
  it('contains exactly the active OpenCanvas tool set (no dead Excalidraw entries)', () => {
    expect(Object.keys(TOOL_PROFILES).sort()).toEqual([...ACTIVE_TOOL_NAMES].sort())
  })

  it('declares canvas_import_okf as mutating, not read-only or destructive', () => {
    const profile = TOOL_PROFILES.canvas_import_okf.profile
    expect(profile.readOnlyHint).not.toBe(true)
    expect(profile.destructiveHint).not.toBe(true)
  })
})
