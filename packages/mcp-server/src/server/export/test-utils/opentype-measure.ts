import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { createExportTextMeasurer } from '../measure-text.js'
import { NO_INSTALLED_FONTS } from './no-installed-fonts.js'

/**
 * The measurement half of the export measurer alone, for a test with no
 * family question to ask. Production seams take `createExportTextMeasurer`
 * whole, so that a family is declared exactly where it is measured.
 */
export async function opentypeMeasureText(
  options: Partial<Parameters<typeof createExportTextMeasurer>[0]> = {},
): Promise<MeasureText> {
  return (await createExportTextMeasurer({ fontsDir: NO_INSTALLED_FONTS, ...options })).measure
}
