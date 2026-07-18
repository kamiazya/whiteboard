import type { WhiteboardCommands } from './types.js'

/**
 * Bridges the shared commands layer into a page's existing `onExport`
 * contract (`format => Promise<Blob | null>`): the `json` format delegates
 * scene serialization to `commands.exportJson`, while every other format
 * passes straight through to the page's own `exportScene`. A failed
 * `exportJson` resolves to `null`, matching what `exportScene` already
 * returns on failure so the caller's branch stays uniform.
 *
 * Generic over the format union so it is inferred from the supplied
 * `exportScene` rather than restated here — a new export format added to
 * `exportScene` flows through without editing this helper.
 */
export function createSceneExportHandler<Format extends string>(
  commands: WhiteboardCommands,
  exportScene: (format: Format) => Promise<Blob | null>,
): (format: Format) => Promise<Blob | null> {
  return async (format) => {
    if (format !== 'json') return exportScene(format)
    try {
      const doc = await commands.exportJson()
      return new Blob([JSON.stringify(doc)], { type: 'application/json' })
    } catch {
      return null
    }
  }
}
