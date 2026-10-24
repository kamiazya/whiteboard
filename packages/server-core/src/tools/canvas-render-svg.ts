import type { MeasureText, ReferenceGraph } from '@kamiazya/whiteboard-canvas-render'
import {
  renderSceneToSvg,
  type Scene,
  selectCanvasFragment,
  selectMarkdownSection,
  spatialRenderStyleSchema,
} from '@kamiazya/whiteboard-canvas-render'
import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import {
  readAnnotations,
  readDocumentKind,
  readMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { documentIdSchema, LABEL_MAX_CHARS, utf16Max } from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import { loadDocument } from '../document-io.js'
import { composeCanvasScene, sceneEnvelope } from '../render/compose-canvas-scene.js'
import { composeMarkdownScene } from '../render/compose-markdown-scene.js'
import { loadReferenceGraph } from '../render/reference-graph.js'
import { fontAvailableOf, resolveTextMeasurer } from '../render/text-measurer.js'
import { unknownStyleRefusal } from '../render/unknown-style.js'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { taggedDrawingLibrary } from './tag-library.js'
import { workspaceAddressArgSchema } from './workspace-address-arg.js'

/**
 * `DocRef`'s document arm carries `workspaceId` (the record a consumer
 * reaches through the ref), but the derived STORAGE key deliberately omits
 * it — see doc-ref-key.ts — so this field never selects different bytes;
 * it is accepted for API symmetry with workspace-scoped tools and as a
 * future authorization-scoping hook.
 */
export const canvasRenderSvgInputSchema = z
  .object({
    workspaceId: workspaceAddressArgSchema,
    documentId: documentIdSchema,
    embedReferences: z
      .boolean()
      .default(false)
      .describe(
        "Resolve what this document references against the workspace: a file node's target renders inside the node (a markdown document as its body, a canvas as a miniature), a `![[path]]` embed in any markdown body renders the document or the `#Heading` / `#Group` part it names, and every reference shows its readable name instead of its raw id. Off by default so the render stays a pure function of this document alone; off, an embed renders as its address.",
      ),
    // A group label is written under this bound, and a heading is one line.
    fragment: utf16Max(
      z.string().min(1),
      LABEL_MAX_CHARS,
      `a fragment is longer than the ${LABEL_MAX_CHARS}-character limit`,
    )
      .optional()
      .describe(
        "Render one PART of the document rather than the whole: a heading's text for a markdown document (that section, through the next heading of the same or a higher level), or a group's label for a canvas (the group, the nodes inside its box, and the edges between them). The same names `[[path#...]]` uses; `^` followed by a node id addresses a node durably. Unknown → an error naming it.",
      ),
    comments: z
      .boolean()
      .default(false)
      .describe(
        "Draw the review conversation into a canvas: comment pins and cards, region outlines, and the highlight behind a quoted passage. Off by default — a picture handed to someone else carries the board, not the authors' discussion of it. A markdown document has no such layer in its picture.",
      ),
    style: spatialRenderStyleSchema
      .default('clean')
      .describe(
        "Which look a canvas is drawn in. 'clean' (the default) is the bundled look whatever the document says, so an agent reading the SVG never pays for a theme's jittered geometry or glow unasked. 'document' draws the theme the canvas names in its visual.theme/v0 facet. A theme id such as 'visual.sketch' draws that theme without the document naming it — a preview. On a markdown document it draws the canvases the body embeds.",
      ),
  })
  .strict()
export type CanvasRenderSvgInput = z.infer<typeof canvasRenderSvgInputSchema>

const canvasRenderSvgOutputSchema = z
  .object({ svg: z.string(), width: z.number(), height: z.number() })
  .strict()
export type CanvasRenderSvgOutput = z.infer<typeof canvasRenderSvgOutputSchema>

/** A `style` no registered theme draws. Named, so the caller reads which ones are. */
class UnknownRenderStyleError extends Error {
  constructor(refusal: string) {
    super(refusal)
    this.name = 'UnknownRenderStyleError'
  }
}

/** A `fragment` the document does not hold. Named, so the caller can fix the address. */
class FragmentNotFoundError extends Error {
  constructor(documentId: string, fragment: string, kind: DocumentKind) {
    super(
      kind === 'markdown'
        ? `Document ${documentId} has no heading "${fragment}". A fragment names a heading's text; check the body with wb_document_get.`
        : `Document ${documentId} has no group labelled "${fragment}". A fragment names a group's label (or ^ plus a node id); check the canvas with wb_canvas_snapshot.`,
    )
    this.name = 'FragmentNotFoundError'
  }
}

/**
 * The scene a MARKDOWN document renders as, from its body.
 *
 * One function per kind, dispatched on the kind alone: the two differ in what
 * they read (a body against a canvas), what a fragment SELECTS (a section
 * against a region) and which composer they call, and nothing else. Written as
 * two arms of one `if`, those three differences were interleaved with the
 * setup shared around them.
 */
async function markdownScene(
  deps: ServerDeps,
  input: CanvasRenderSvgInput,
  doc: LoroDoc,
  measure: MeasureText,
  fontAvailable: ReturnType<typeof fontAvailableOf>,
): Promise<Scene> {
  const body = readMarkdownBody(doc)
  const loaded = input.embedReferences
    ? await loadReferenceGraph(deps, input.workspaceId, { bodies: [body] })
    : undefined
  const references = loaded?.seams
  const whole = resolveReferences(parseMarkdownBody(body), references?.resolveAlias)
  const root = input.fragment === undefined ? whole : selectMarkdownSection(whole, input.fragment)
  if (root === undefined) {
    throw new FragmentNotFoundError(input.documentId, input.fragment ?? '', 'markdown')
  }
  const scene = composeMarkdownScene(root, measure, {
    references,
    style: input.style,
    fontAvailable,
    ...(await drawnTagLibrary(deps, input.workspaceId, [], loaded?.graph)),
  })
  return scene
}

/** The scene a SPATIAL document renders as, from its canvas. */
async function canvasScene(
  deps: ServerDeps,
  input: CanvasRenderSvgInput,
  doc: LoroDoc,
  canvas: SpatialCanvas,
  measure: MeasureText,
  fontAvailable: ReturnType<typeof fontAvailableOf>,
): Promise<Scene> {
  const part = input.fragment === undefined ? canvas : selectCanvasFragment(canvas, input.fragment)
  if (part === undefined) {
    throw new FragmentNotFoundError(input.documentId, input.fragment ?? '', 'spatial')
  }
  const loaded = input.embedReferences
    ? await loadReferenceGraph(deps, input.workspaceId, { canvases: [part] })
    : undefined
  const scene = composeCanvasScene(part, measure, {
    references: loaded?.seams,
    style: input.style,
    fontAvailable,
    // Colour by intent (ADR-0040 decision 5).
    ...(await drawnTagLibrary(deps, input.workspaceId, [part], loaded?.graph)),
    // With comments asked for, the export draws what the editor draws: a
    // thread about a passage of a node's text is a highlight behind those
    // words, a node set an outline around them.
    ...(input.comments ? { threads: readAnnotations(doc) } : { commentLayer: false }),
  })
  return scene
}

export function createCanvasRenderSvgTool(deps: ServerDeps) {
  return {
    name: 'wb_scene_render' as const,
    description:
      'Render a document as SVG — a canvas as its laid-out scene, a markdown document as a page. A one-way projection: the SVG cannot be parsed back into a document. `embedReferences` draws what it links to (file nodes, `![[path]]` embeds, `#Heading` / `#Group` parts); `fragment` renders one part on its own. Comments are left out unless `comments` is true.',
    inputSchema: canvasRenderSvgInputSchema,
    outputSchema: canvasRenderSvgOutputSchema,
    async execute(input: CanvasRenderSvgInput): Promise<CanvasRenderSvgOutput> {
      const refusal = unknownStyleRefusal(input.style)
      if (refusal !== undefined) throw new UnknownRenderStyleError(refusal)
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const { doc, canvas } = await loadDocument(deps, input.workspaceId, input.documentId)
      const measurer = await resolveTextMeasurer(deps)
      const { measure } = measurer
      const fontAvailable = fontAvailableOf(measurer)
      // The doc's own recorded kind wins; the index row is the fallback for
      // a document that predates kinds (wb_document_get's read path). Neither
      // known reads as spatial, the kind every pre-kind document was.
      const kind =
        readDocumentKind(doc) ??
        (
          await deps.documentIndex.resolveDocumentById({
            workspaceId: input.workspaceId,
            documentId: input.documentId,
          })
        )?.kind

      const scene =
        kind === 'markdown'
          ? await markdownScene(deps, input, doc, measure, fontAvailable)
          : await canvasScene(deps, input, doc, canvas, measure, fontAvailable)

      const envelope = sceneEnvelope(scene)
      return {
        svg: renderSceneToSvg(scene, { viewBox: envelope }),
        width: envelope.w,
        height: envelope.h,
      }
    },
  }
}

/** The tag library as a spread for the scene options: present only when `drawsATag` says one is read. */
async function drawnTagLibrary(
  deps: ServerDeps,
  workspaceId: string,
  own: readonly SpatialCanvas[],
  graph: ReferenceGraph | undefined,
): Promise<{ tagLibrary?: TagLibrary }> {
  const tagLibrary = await taggedDrawingLibrary(deps, workspaceId, own, graph)
  return tagLibrary === undefined ? {} : { tagLibrary }
}
