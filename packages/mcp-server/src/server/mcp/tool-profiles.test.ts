import { describe, expect, it } from 'vitest'
import { TOOL_PROFILES } from './tool-profiles.js'

// Tools actually registered by registerOpenCanvasTools (opencanvas-tools.ts).
// Every removed Excalidraw-era tool name (canvas_list, export_svg,
// create_frame, etc.) must have no entry here — a stale entry gives a
// client a misleading approval-policy hint for a tool that no longer exists.
const ACTIVE_TOOL_NAMES = [
  'wb_facet_set',
  'wb_node_lock',
  'wb_node_patch',
  'wb_edge_lock',
  'wb_edge_patch',
  'wb_canvas_tidy',
  'wb_body_patch',
  'wb_scene_render',
  'wb_scene_digest',
  'wb_document_set',
  'wb_document_create',
  'wb_document_get',
  'wb_document_list',
  'wb_document_resolve',
  'wb_document_delete',
  'wb_version_save',
  'wb_version_restore',
  'wb_version_list',
]

describe('TOOL_PROFILES', () => {
  it('contains exactly the active OpenCanvas tool set (no dead Excalidraw entries)', () => {
    expect(Object.keys(TOOL_PROFILES).sort()).toEqual([...ACTIVE_TOOL_NAMES].sort())
  })

  it('declares wb_document_set as mutating, not read-only or destructive', () => {
    const profile = TOOL_PROFILES.wb_document_set.profile
    expect(profile.readOnlyHint).not.toBe(true)
    expect(profile.destructiveHint).not.toBe(true)
  })
})
