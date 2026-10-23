import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { UserSettings } from './user-settings-store.js'

/** What the picture entries of ⋮ → Export… are made with. */
export interface PictureExportOptions {
  /** PNG pixels per canvas unit; an SVG is resolution-independent and ignores it. */
  readonly scale: 1 | 2
  /** Fill the picture with the paper colour instead of leaving it transparent. */
  readonly background: boolean
}

/**
 * The paper a saved picture is filled with. A saved file is pinned to the
 * light theme (its bytes never depend on a display preference), so this is
 * that theme's surface: filling with the UI mode's would put dark paper
 * behind ink laid out for light.
 */
export const PAPER_COLOR = SPATIAL_LIGHT_PALETTE.surface

export function pictureExportOptionsOf(settings: UserSettings): PictureExportOptions {
  const stored = settings.pictureExport
  return {
    scale: stored?.doubleResolution === true ? 2 : 1,
    background: stored?.background !== false,
  }
}

/** The `background` render option a picture is made with; none leaves it transparent. */
export function backgroundOf(picture: PictureExportOptions | undefined): {
  readonly background?: string
} {
  return picture?.background === true ? { background: PAPER_COLOR } : {}
}

/** The `scale` save option a picture is made with; none is 1x. */
export function scaleOf(picture: PictureExportOptions | undefined): { readonly scale?: number } {
  return picture === undefined ? {} : { scale: picture.scale }
}
