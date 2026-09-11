import {
  referenceTargets,
  resolveCanvasThemeFontFamily,
  spatialRenderStyleSchema,
} from '@kamiazya/whiteboard-canvas-render'
import { jsonCanvasDocumentSchema, toJsonCanvas } from '@kamiazya/whiteboard-codec'
import { readAnnotations } from '@kamiazya/whiteboard-loro-adapter'
import {
  commentThreadSchema,
  documentIdSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { assertSpatialDocument } from '../render/assert-spatial-document.js'
import { loadReferenceGraph } from '../render/reference-graph.js'
import type { ServerDeps } from '../server-deps.js'
import { themeFontSchema } from '../theme-font.js'
import { loadDocument } from './document-io.js'

/**
 * What one file reference resolved to, as the widget receives it.
 *
 * Schematized rather than passed as `unknown` because this payload crosses
 * TWO process boundaries — server to MCP host, host to the widget document —
 * and the widget re-validates on arrival. A hand-written type on the widget
 * side paired with an unschematized payload here is exactly the drift
 * zod-schema-discipline exists to prevent.
 */
/**
 * One referenced document as the widget receives it — canvas-render's
 * `LoadedReference` on the wire, so the widget builds its seams with the
 * same `referenceSeams` every other surface uses and this schema never has
 * to know what a body or a canvas is FOR. Raw body, not parsed: parsing is
 * the seams' job, once, on whichever side lays out.
 */
export const canvasViewReferenceSchema = z
  .object({
    /** The canonical id, so the seams answer by id when the node wrote a path. */
    documentId: documentIdSchema.optional(),
    /** The document's display name, so the node's label is not a raw id. */
    name: z.string().optional(),
    /** Present only for a markdown document: its raw body. */
    body: z.string().optional(),
    /** Present only for a spatial document: its canvas. */
    canvas: jsonCanvasDocumentSchema.optional(),
  })
  .strict()

export const canvasViewInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    /**
     * Which look the widget draws (ADR-0030 decision 6). Echoed, never
     * applied here — this tool hands the widget a document to lay out, not
     * a picture. Absent leaves the widget's own default, the bundled look.
     */
    style: spatialRenderStyleSchema.optional(),
  })
  .strict()
export type CanvasViewInput = z.infer<typeof canvasViewInputSchema>

export const canvasViewOutputSchema = z
  .object({
    /**
     * Both ids echo so the widget's follow-up calls (Refresh re-invoking
     * this tool, the sticky-note append calling wb_canvas_edit) can
     * construct a valid strict-schema call without the host having to
     * remember what it asked for.
     */
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    /** The document itself: the widget lays it out, it is not pre-rendered. */
    scene: jsonCanvasDocumentSchema,
    /**
     * The document's conversations, for what the scene's flat projection
     * cannot carry: a passage's words, a node set's outline. The pins still
     * come from the projection inside `scene`, as the web canvas draws them.
     */
    threads: z.array(commentThreadSchema),
    /**
     * File reference -> what it resolves to. Keyed by the raw `file` value
     * on the node, which is what the widget's seam is called with.
     */
    references: z.record(z.string(), canvasViewReferenceSchema),
    /** The caller's `style`, echoed so the widget draws the look that was asked for. */
    style: spatialRenderStyleSchema.optional(),
    /**
     * The family the resolved theme names, and where the catalogue keeps it.
     * Present only when the style resolves to a theme that names a family
     * AND this server was wired with a catalogue that knows it — so a widget
     * receiving nothing here keeps the bundled family, which is what it did
     * before this field existed.
     *
     * The widget is the only consumer, and it re-checks the URL's origin
     * against its own pinned constant before requesting anything: a payload
     * field is not authority to fetch.
     */
    themeFont: themeFontSchema.optional(),
  })
  .strict()
export type CanvasViewOutput = z.infer<typeof canvasViewOutputSchema>

/**
 * The MCP Apps (SEP-1865) inline canvas view. Its result is linked to the
 * `ui://whiteboard/canvas-view` widget resource by the registration's
 * `_meta.ui.resourceUri`, so a host that supports the extension renders it
 * rather than showing JSON.
 *
 * References are resolved UNCONDITIONALLY here, unlike `wb_scene_render`'s
 * opt-in `embedReferences`. That flag exists because the render tool shares
 * its scene builder with `wb_canvas_snapshot`'s layout analysis, whose
 * usefulness depends on a
 * canvas's digest not moving when a different document is edited. This tool
 * has no such sibling: its one consumer is a viewer for a human, which
 * always wants the reference resolved, and it has no store of its own to
 * resolve them with.
 */
export function createCanvasViewTool(deps: ServerDeps) {
  return {
    name: 'canvas_view' as const,
    description:
      'Show a canvas inline in the chat as an interactive read-only view. Returns the scene plus its resolved file references, so a node referencing a markdown document shows that document. Read-only: it renders what is stored and changes nothing.',
    inputSchema: canvasViewInputSchema,
    outputSchema: canvasViewOutputSchema,
    async execute(input: CanvasViewInput): Promise<CanvasViewOutput> {
      const { doc, canvas } = await loadDocument(deps, input.workspaceId, input.documentId)
      await assertSpatialDocument(deps, input.workspaceId, input.documentId, doc, 'canvas_view')
      const { graph } = await loadReferenceGraph(deps, input.workspaceId, { canvases: [canvas] })
      // Resolved from the style the CALLER asked for, not from the document's
      // facet alone: a canvas naming a theme drawn under the bundled look
      // has nothing to fetch, and a `style` naming a theme the document does
      // not carry does.
      const family = resolveCanvasThemeFontFamily(canvas, { style: input.style })
      const themeFont = family === undefined ? undefined : deps.themeFontSource?.(family)
      return {
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        // Projected, because the tool's published output schema is the WIRE
        // shape and a client reading it may be another tool entirely. Before
        // ADR-0035 this was the same object; now the model carries `comments`,
        // `facets` and `embed` as its own fields and the format carries them
        // under its extension key.
        scene: toJsonCanvas(canvas),
        threads: readAnnotations(doc),
        ...(input.style === undefined ? {} : { style: input.style }),
        ...(themeFont === undefined ? {} : { themeFont }),
        // Everything THIS canvas names, through the one definition of a
        // reference rather than a node-kind filter: its file nodes AND what
        // its text nodes embed or link. Seeded without `loaded`, so it stops
        // at what the canvas itself says — not the transitive closure the
        // graph also holds, since the widget lays out one canvas and what a
        // REFERENCED body goes on to name is resolved by whoever reads that
        // body. Filtering by node kind instead is what left a text node's
        // `![[note]]` a bracket literal here while the same canvas resolved
        // it through `wb_scene_render`, which passes the whole bundle.
        references: Object.fromEntries(
          referenceTargets({ canvases: [canvas] }).flatMap((target) => {
            const loaded = graph.get(target)
            if (loaded === undefined || loaded === null) return []
            return [
              [
                target,
                {
                  ...(loaded.documentId !== undefined ? { documentId: loaded.documentId } : {}),
                  ...(loaded.name !== undefined ? { name: loaded.name } : {}),
                  ...(loaded.body !== undefined ? { body: loaded.body } : {}),
                  ...(loaded.canvas !== undefined ? { canvas: toJsonCanvas(loaded.canvas) } : {}),
                },
              ],
            ]
          }),
        ),
      }
    },
  }
}
