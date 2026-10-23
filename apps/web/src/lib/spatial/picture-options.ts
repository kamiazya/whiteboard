import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'

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
const PAPER_COLOR = SPATIAL_LIGHT_PALETTE.surface

/** The fill a picture is drawn first with; none leaves it transparent. */
export function backgroundOf(picture: PictureExportOptions | undefined): string | undefined {
  return picture?.background === true ? PAPER_COLOR : undefined
}
