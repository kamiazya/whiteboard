import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { createExportTextMeasurer } from '../measure-text.js'

/**
 * The measurement half of the export measurer alone, for a test with no
 * family question to ask. Production seams take `createExportTextMeasurer`
 * whole, so that a family is declared exactly where it is measured.
 */
export async function opentypeMeasureText(
  options: Parameters<typeof createExportTextMeasurer>[0] = {},
): Promise<MeasureText> {
  return (await createExportTextMeasurer(options)).measure
}
