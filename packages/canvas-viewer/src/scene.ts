import { z } from 'zod'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'

// Producing the .excalidraw payload by hand rather than via excalidraw's own
// serializeAsJSON: that helper is a top-level export ONLY in the package's
// production build. Vitest browser mode resolves the `development` export
// condition, whose build does not re-export it, so importing it breaks every
// browser test that loads a canvas page. This wrapper depends only on plain
// scene data, matching the daemon's canvas_export_json shape
// ({type:'excalidraw', version:2, ...}) so both surfaces round-trip with
// Excalidraw desktop / excalidraw.com.
const EXCALIDRAW_FILE_SOURCE = '@kamiazya/whiteboard'

// Excalidraw element internals are not this repo's contract — the app never
// interprets individual element fields, only passes them through to the
// Excalidraw component. A loose record avoids re-deriving Excalidraw's own
// (large, version-coupled) element schema here.
const looseElementSchema = z.record(z.string(), z.unknown())

// Matches Excalidraw's own `cleanAppStateForExport` return shape (the
// subset of AppState a real .excalidraw file persists): every field is
// optional there too, so a standard on-disk document with grid settings
// omitted (or gridStep/gridModeEnabled present) must still parse.
// .catchall keeps unrecognized appState keys instead of stripping them —
// same opaque pass-through stance as elements/files: whatever a document
// carries (theme, viewport state, future Excalidraw fields) is threaded
// back to Excalidraw untouched; only the fields this package reads are
// validated.
const appStateShape = z
  .object({
    gridSize: z.number().nullable().optional(),
    viewBackgroundColor: z.string().optional(),
    gridStep: z.number().optional(),
    gridModeEnabled: z.boolean().optional(),
  })
  .catchall(z.unknown())

// Parse-side authority for the on-disk / exported .excalidraw envelope.
export const excalidrawJsonDocSchema = z.object({
  type: z.literal('excalidraw'),
  version: z.literal(2),
  source: z.string(),
  // .readonly() so z.input matches the serializer's `readonly
  // ExcalidrawElement[]` — otherwise the compile-time contract test below
  // fails on array mutability alone, not on actual shape drift.
  elements: z.array(looseElementSchema).readonly(),
  appState: appStateShape,
  // Excalidraw's own ExportedDataState types this `BinaryFiles |
  // undefined` — a document with no embedded images legitimately omits it.
  // Embedded binary-file blobs are opaque pass-through data for the same
  // reason as looseElementSchema above: this package never reads into a
  // file's fields, only threads the whole blob back to Excalidraw.
  files: z.record(z.string(), z.unknown()).optional(),
})

// structuredContent-shaped payload (e.g. an MCP tool result): no envelope
// markers. `.strict()` rejects type/version/source so a mangled .excalidraw
// doc cannot silently be accepted by the looser branch.
export const viewerSceneSchema = z
  .object({
    elements: z.array(looseElementSchema).readonly(),
    appState: appStateShape.optional(),
    // Opaque pass-through, same rationale as excalidrawJsonDocSchema.files.
    files: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const normalizedSceneSchema = z.object({
  elements: z.array(looseElementSchema).readonly(),
  appState: appStateShape,
  // Opaque pass-through, same rationale as excalidrawJsonDocSchema.files.
  files: z.record(z.string(), z.unknown()),
})

export type ViewerScene = z.infer<typeof normalizedSceneSchema>

function hasTypeKey(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && 'type' in input
}

// Routes on envelope presence: any object carrying a `type` key must satisfy
// the strict .excalidraw envelope and its ZodError surfaces as-is — no
// fall-through to the looser structuredContent branch, which would let a
// mangled .excalidraw doc silently pass validation.
export function parseViewerScene(input: unknown): ViewerScene {
  if (hasTypeKey(input)) {
    const doc = excalidrawJsonDocSchema.parse(input)
    return { elements: doc.elements, appState: doc.appState, files: doc.files ?? {} }
  }
  const scene = viewerSceneSchema.parse(input)
  return { elements: scene.elements, appState: scene.appState ?? {}, files: scene.files ?? {} }
}

export interface ExcalidrawJsonDoc {
  type: 'excalidraw'
  version: 2
  source: string
  elements: readonly ExcalidrawElement[]
  appState: { gridSize: number | null; viewBackgroundColor: string }
  files: BinaryFiles
}

// Compile-time contract: ExcalidrawJsonDoc (the serializer's hand-written
// return type) must stay assignable to the schema's input shape, so a
// drift between the two fails `pnpm -r typecheck` instead of only showing up
// at runtime.
type _AssertSerializerMatchesSchema =
  ExcalidrawJsonDoc extends z.input<typeof excalidrawJsonDocSchema> ? true : never
const _serializerMatchesSchema: _AssertSerializerMatchesSchema = true
void _serializerMatchesSchema

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
