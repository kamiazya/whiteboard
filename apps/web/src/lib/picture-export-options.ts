import type { PictureExportOptions } from './spatial/picture-options.js'
import type { UserSettings } from './user-settings-store.js'

/** The options the remembered choices make; the defaults are 1x with the paper behind. */
export function pictureExportOptionsOf(settings: UserSettings): PictureExportOptions {
  const stored = settings.pictureExport
  return {
    scale: stored?.doubleResolution === true ? 2 : 1,
    background: stored?.background !== false,
  }
}
