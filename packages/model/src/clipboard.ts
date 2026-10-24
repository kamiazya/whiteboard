import { z } from 'zod'
import { isImageRef } from './asset-ref.js'
import { NODE_LOCATION_MAX_CHARS } from './node-resource.js'
import { canvasEdgeSchema, canvasLineSchema, endNode, spatialNodeSchema } from './spatial.js'
import { utf16Max } from './utf16-max.js'

/**
 * The most picture bytes one fragment carries inline, summed over its files.
 *
 * Equal to the largest image any keeper accepts (the daemon's upload
 * contract, which the editor applies to the browser keeper too), so any one
 * picture a canvas can hold still travels on its own. Past it a fragment is
 * tens of megabytes of clipboard text, and the copy carries the remaining
 * pictures by reference only; the paste says which did not come along.
 */
export const CLIPBOARD_FILES_MAX_BYTES = 16 * 1024 * 1024

/** The most pictures one fragment carries inline: one upload each, on paste. */
export const CLIPBOARD_FILES_MAX_COUNT = 256

/** Base64 spends four characters on every three bytes, padding the last group. */
const CLIPBOARD_FILES_MAX_BASE64 = 4 * Math.ceil(CLIPBOARD_FILES_MAX_BYTES / 3)

/** The bytes a base64 string decodes to, padded or not, without decoding it. */
function base64ByteLength(data: string): number {
  let padding = 0
  if (data.endsWith('==')) padding = 2
  else if (data.endsWith('=')) padding = 1
  return Math.floor((data.length * 3) / 4) - padding
}

/**
 * The typed clipboard envelope for copy/paste of canvas fragments: a FULL
 * spatialCanvasSchema-shaped subset plus inline file assets, so a paste into
 * a keeper that does not hold the source's pictures can store them again
 * instead of carrying dangling references (Excalidraw's elements+files
 * precedent). The discriminant `type` keeps foreign JSON from parsing as
 * ours, and `version` is a literal so a future breaking change is a new
 * literal union member, not a silent drift.
 */
const clipboardFileAssetSchema = z
  .object({
    mimeType: z.string().min(1),
    dataBase64: utf16Max(z.string(), CLIPBOARD_FILES_MAX_BASE64),
  })
  .strict()

/**
 * Where the fragment's stored pictures live. Pictures are not global: the
 * daemon keeps them per workspace, and the browser per origin. Two keepers
 * answering the same `fileScope` hold the same bytes, so a paste between
 * them carries the references as they are; any other paste stores the
 * carried bytes in the target and remints the references.
 */
const clipboardSourceSchema = z
  .object({
    fileScope: utf16Max(z.string().min(1), NODE_LOCATION_MAX_CHARS),
    /**
     * Minted per copy, so a paste that received this fragment as clipboard
     * TEXT can still find the bytes the same tab read after the copy event.
     */
    copyId: utf16Max(z.string().min(1), 128),
  })
  .strict()

/** Why the carried pictures break the bound, as one message per breach. */
function fileBoundIssues(files: Readonly<Record<string, { dataBase64: string }>>): string[] {
  const entries = Object.values(files)
  const carried = entries.reduce((sum, file) => sum + base64ByteLength(file.dataBase64), 0)
  return [
    ...(entries.length > CLIPBOARD_FILES_MAX_COUNT
      ? [`more than ${CLIPBOARD_FILES_MAX_COUNT} pictures`]
      : []),
    ...(carried > CLIPBOARD_FILES_MAX_BYTES
      ? [`pictures past ${CLIPBOARD_FILES_MAX_BYTES} bytes together`]
      : []),
  ]
}

const clipboardFilesSchema = z
  .record(
    utf16Max(z.string(), NODE_LOCATION_MAX_CHARS).refine(
      isImageRef,
      'not a stored-picture reference',
    ),
    clipboardFileAssetSchema,
  )
  .superRefine((files, ctx) => {
    for (const message of fileBoundIssues(files)) ctx.addIssue({ code: 'custom', message })
  })

export const clipboardFragmentSchema = z
  .object({
    type: z.literal('whiteboard/clipboard'),
    version: z.literal(1),
    nodes: z.array(spatialNodeSchema),
    edges: z.array(canvasEdgeSchema),
    /**
     * The strokes travelling with the selection.
     *
     * OPTIONAL rather than required, and not for the reason `SpatialCanvas`'s
     * is: a fragment written by a tab that has not reloaded yet is pasted
     * into one that has, and a required field would refuse it. `version` is
     * the knob for a shape that really changed; a field nobody wrote yet is
     * not that.
     */
    lines: z.array(canvasLineSchema).optional(),
    /** Inline picture bytes keyed by the stored-picture reference the nodes carry. */
    files: clipboardFilesSchema.optional(),
    source: clipboardSourceSchema.optional(),
    /**
     * Present only on a CUT fragment: the cut surface. `boundaryEdges` are
     * the edges the cut severed — exactly one endpoint in the fragment, the
     * other a peer left behind on the source canvas. A same-canvas paste
     * reconnects them to peers that still exist (cut is a move, not a
     * delete); anywhere else the peers are absent and they drop silently.
     * `id` is minted per cut so the reconnect happens on the FIRST paste
     * only — later pastes are plain copies.
     */
    cut: z
      .object({
        id: z.string().min(1),
        boundaryEdges: z.array(canvasEdgeSchema),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Same integrity rules as spatialCanvasSchema: unique ids, and every
    // edge endpoint present IN THE FRAGMENT (a fragment is self-contained
    // by construction — the copy builder only includes fully-selected
    // edges, and paste remints against exactly this node set).
    const seen = new Set<string>()
    for (const node of value.nodes) {
      if (seen.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate node id "${node.id}"`,
          path: ['nodes'],
        })
        break
      }
      seen.add(node.id)
    }
    const edgeIds = new Set<string>()
    value.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate edge id "${edge.id}"`, path: ['edges'] })
      }
      edgeIds.add(edge.id)
      // A point end names nothing, so it is never outside the fragment: it
      // travels with the edge exactly as a coordinate does.
      for (const side of ['from', 'to'] as const) {
        const node = endNode(edge[side])
        if (node === undefined || seen.has(node)) continue
        ctx.addIssue({
          code: 'custom',
          message: `edge "${edge.id}" references ${side} node "${node}" outside the fragment`,
          path: ['edges', index, side, 'node'],
        })
      }
    })
    value.cut?.boundaryEdges.forEach((edge, index) => {
      // A boundary edge must CROSS the border: exactly one endpoint inside.
      const inFragment = (['from', 'to'] as const).filter((side) => {
        const node = endNode(edge[side])
        return node !== undefined && seen.has(node)
      }).length
      if (inFragment !== 1) {
        ctx.addIssue({
          code: 'custom',
          message: `boundary edge "${edge.id}" must have exactly one endpoint in the fragment`,
          path: ['cut', 'boundaryEdges', index],
        })
      }
    })
  })

export type ClipboardFragment = z.infer<typeof clipboardFragmentSchema>
