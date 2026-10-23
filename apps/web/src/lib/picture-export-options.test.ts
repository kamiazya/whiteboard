import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it } from 'vitest'
import { pictureExportOptionsOf } from './picture-export-options.js'
import { backgroundOf } from './spatial/picture-options.js'
import { defaultUserSettings } from './user-settings-store.js'

describe('pictureExportOptionsOf', () => {
  it('defaults to 1x with the paper background', () => {
    expect(pictureExportOptionsOf(defaultUserSettings())).toEqual({ scale: 1, background: true })
  })

  it('reads each remembered choice on its own', () => {
    const base = defaultUserSettings()
    expect(pictureExportOptionsOf({ ...base, pictureExport: { doubleResolution: true } })).toEqual({
      scale: 2,
      background: true,
    })
    expect(pictureExportOptionsOf({ ...base, pictureExport: { background: false } })).toEqual({
      scale: 1,
      background: false,
    })
  })

  it('paints the paper in the light theme a saved file is pinned to', () => {
    expect(backgroundOf({ scale: 1, background: true })).toBe(SPATIAL_LIGHT_PALETTE.surface)
  })

  it('asks for the paper only when the background is on', () => {
    expect(backgroundOf({ scale: 1, background: true })).toBe(SPATIAL_LIGHT_PALETTE.surface)
    expect(backgroundOf({ scale: 1, background: false })).toBeUndefined()
    expect(backgroundOf(undefined)).toBeUndefined()
  })
})
