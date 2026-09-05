import {
  constantRatioMeasureText,
  renderSceneToSvg,
  type Scene,
  selectCanvasFragment,
  selectMarkdownSection,
} from '@kamiazya/whiteboard-canvas-render'
import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import {
  readAnnotations,
  readDocumentKind,
  readMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { composeCanvasScene, computeSceneDimensions } from '../render/compose-canvas-scene.js'
import { composeMarkdownScene } from '../render/compose-markdown-scene.js'
import { type EmbedResolution, resolveEmbedTargets } from '../render/resolve-embeds.js'
import { loadFileReferences, toResolvedReference } from '../render/resolve-file-references.js'
import type { ServerDeps } from '../server-deps.js'
import { loadDocument } from './document-io.js'

/**
 * `DocRef`'s document arm carries `workspaceId` (the record a consumer
 * reaches through the ref), but the derived STORAGE key deliberately omits
 * it — see doc-ref-key.ts — so this field never selects different bytes;
 * it is accepted for API symmetry with workspace-scoped tools and as a
 * future authorization-scoping hook.
 */
export const canvasRenderSvgInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    embedReferences: z
      .boolean()
      .default(false)
      .describe(
        "Resolve what this document references against the workspace: a file node's target renders inside the node (a markdown document as its body, a canvas as a miniature), a `![[path]]` embed in any markdown body renders the document or the `#Heading` / `#Group` part it names, and every reference shows its readable name instead of its raw id. Off by default so the render stays a pure function of this document alone; off, an embed renders as its address.",
      ),
    fragment: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Render one PART of the document rather than the whole: a heading's text for a markdown document (that section, through the next heading of the same or a higher level), or a group's label for a canvas (the group, the nodes inside its box, and the edges between them). The same names `[[path#...]]` uses; `^` followed by a node id addresses a node durably. Unknown → an error naming it.",
      ),
  })
  .strict()
export type CanvasRenderSvgInput = z.infer<typeof canvasRenderSvgInputSchema>

export const canvasRenderSvgOutputSchema = z
  .object({ svg: z.string(), width: z.number(), height: z.number() })
  .strict()
export type CanvasRenderSvgOutput = z.infer<typeof canvasRenderSvgOutputSchema>

/** A `fragment` the document does not hold. Named, so the caller can fix the address. */
class FragmentNotFoundError extends Error {
  constructor(documentId: string, fragment: string, kind: 'markdown' | 'spatial') {
    super(
      kind === 'markdown'
        ? `Document ${documentId} has no heading "${fragment}". A fragment names a heading's text; check the body with wb_document_get.`
        : `Document ${documentId} has no group labelled "${fragment}". A fragment names a group's label (or ^ plus a node id); check the canvas with wb_canvas_snapshot.`,
    )
    this.name = 'FragmentNotFoundError'
  }
}

export function createCanvasRenderSvgTool(deps: ServerDeps) {
  return {
    name: 'wb_scene_render' as const,
    description:
      'Render a document as SVG — a canvas as its laid-out scene, a markdown document as a page. A one-way projection: the SVG cannot be parsed back into a document. `embedReferences` draws what it links to (file nodes, `![[path]]` embeds, `#Heading` / `#Group` parts); `fragment` renders one part on its own.',
    inputSchema: canvasRenderSvgInputSchema,
    outputSchema: canvasRenderSvgOutputSchema,
    async execute(input: CanvasRenderSvgInput): Promise<CanvasRenderSvgOutput> {
      const { doc, canvas } = await loadDocument(deps, input.workspaceId, input.documentId)
      const measure = (await deps.measure?.()) ?? constantRatioMeasureText
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

      let scene: Scene
      if (kind === 'markdown') {
        const body = readMarkdownBody(doc)
        const embeds = input.embedReferences
          ? await resolveEmbedTargets(deps, input.workspaceId, [body])
          : undefined
        const whole = resolveReferences(parseMarkdownBody(body), embeds?.resolveAlias)
        const root =
          input.fragment === undefined ? whole : selectMarkdownSection(whole, input.fragment)
        if (root === undefined) {
          throw new FragmentNotFoundError(input.documentId, input.fragment ?? '', 'markdown')
        }
        scene = composeMarkdownScene(root, measure, embeds)
      } else {
        const part =
          input.fragment === undefined ? canvas : selectCanvasFragment(canvas, input.fragment)
        if (part === undefined) {
          throw new FragmentNotFoundError(input.documentId, input.fragment ?? '', 'spatial')
        }
        scene = composeCanvasScene(part, measure, {
          ...(await canvasSceneOptions(deps, input, part)),
          // The export draws what the editor draws: a thread about a passage
          // of a node's text is a highlight behind those words, a node set
          // an outline around them.
          threads: readAnnotations(doc),
        })
      }
      const { width, height } = computeSceneDimensions(scene)
      return { svg: renderSceneToSvg(scene), width, height }
    },
  }
}

/**
 * The opt-in resolution for a canvas: its file references loaded, then the
 * `![[...]]` embeds inside the referenced markdown bodies resolved too, so
 * the bodies parse with an alias resolver that already knows their targets.
 */
async function canvasSceneOptions(
  deps: ServerDeps,
  input: CanvasRenderSvgInput,
  canvas: Parameters<typeof loadFileReferences>[2],
): Promise<Parameters<typeof composeCanvasScene>[2]> {
  if (!input.embedReferences) return {}
  const loaded = await loadFileReferences(deps, input.workspaceId, canvas)
  const bodies = [...loaded.values()].flatMap((source) =>
    source.body === undefined ? [] : [source.body],
  )
  const embeds: EmbedResolution = await resolveEmbedTargets(deps, input.workspaceId, bodies)
  return {
    references: new Map(
      [...loaded].map(([ref, source]) => [ref, toResolvedReference(source, embeds.resolveAlias)]),
    ),
    resolveEmbed: embeds.resolveEmbed,
    resolveTitle: embeds.resolveTitle,
  }
}
