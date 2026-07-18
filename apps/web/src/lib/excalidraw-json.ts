import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'
import { z } from 'zod'

// Producing the .excalidraw payload by hand rather than via excalidraw's own
// serializeAsJSON: that helper is a top-level export ONLY in the package's
// production build. Vitest browser mode resolves the `development` export
// condition, whose build does not re-export it, so importing it breaks every
// browser test that loads a canvas page. This wrapper depends only on plain
// scene data, matching the daemon's canvas_export_json shape
// ({type:'excalidraw', version:2, ...}) so both surfaces round-trip with
// Excalidraw desktop / excalidraw.com.
const EXCALIDRAW_FILE_SOURCE = '@kamiazya/whiteboard'

// Deliberately loose on elements/files: validating their internal shape is
// Excalidraw's own job (its scene reducer already does it). This schema only
// guards the envelope (type/version/source/appState) that this repo's own
// serializer and consumers depend on.
export const excalidrawJsonDocSchema = z.object({
  type: z.literal('excalidraw'),
  version: z.literal(2),
  source: z.string(),
  elements: z.array(z.custom<ExcalidrawElement>()).readonly(),
  appState: z.object({
    gridSize: z.number().nullable(),
    viewBackgroundColor: z.string(),
  }),
  files: z.custom<BinaryFiles>(),
})

export type ExcalidrawJsonDoc = z.infer<typeof excalidrawJsonDocSchema>

// gridSize/viewBackgroundColor are the only appState fields the .excalidraw
// format persists; both are read defensively since a caller may hand a
// partial appState (e.g. the export path passes the live AppState).
type SerializableAppState = {
  gridSize?: AppState['gridSize'] | null
  viewBackgroundColor?: string
}

export function serializeSceneAsExcalidrawJson(
  elements: readonly ExcalidrawElement[],
  appState: SerializableAppState,
  files: BinaryFiles,
): ExcalidrawJsonDoc {
  // Deleted elements linger in the live array with isDeleted:true; the file
  // format only carries live ones.
  const liveElements = elements.filter((el) => !(el as { isDeleted?: boolean }).isDeleted)
  return {
    type: 'excalidraw',
    version: 2,
    source: EXCALIDRAW_FILE_SOURCE,
    elements: liveElements,
    appState: {
      gridSize: appState.gridSize ?? null,
      viewBackgroundColor: appState.viewBackgroundColor ?? '#ffffff',
    },
    files,
  }
}
