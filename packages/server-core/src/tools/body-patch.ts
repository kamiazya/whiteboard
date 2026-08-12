import {
  canvasIdSchema,
  nodeIdSchema,
  spatialCanvasSchema,
  spatialNodeSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadCanvasDoc, saveCanvasDoc } from './canvas-doc-io.js'
import { NodeNotFoundError, NotATextNodeError, PatchValidationError } from './errors.js'
import { assertCanvasInWorkspace } from './workspace-tree-io.js'

export const bodyPatchRangeSchema = z
  .object({
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    replacement: z.string(),
  })
  .strict()
  .refine((value) => value.startLine <= value.endLine, {
    message: 'startLine must be <= endLine',
  })
export type BodyPatchRange = z.infer<typeof bodyPatchRangeSchema>

/**
 * `mode` is a discriminant rather than two optional sibling fields
 * (`body` / `range`+`replacement`) so the schema itself rules out an
 * ambiguous "both present" or "neither present" input, instead of
 * `execute` branching on which optional field happened to show up.
 */
export const bodyPatchInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('full'),
      workspaceId: workspaceIdSchema,
      canvasId: canvasIdSchema,
      nodeId: nodeIdSchema,
      body: z.string(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('range'),
      workspaceId: workspaceIdSchema,
      canvasId: canvasIdSchema,
      nodeId: nodeIdSchema,
      range: bodyPatchRangeSchema,
    })
    .strict(),
])
export type BodyPatchInput = z.infer<typeof bodyPatchInputSchema>

export const bodyPatchOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    node: spatialNodeSchema,
  })
  .strict()
export type BodyPatchOutput = z.infer<typeof bodyPatchOutputSchema>

/**
 * Splices lines `[startLine, endLine]` (inclusive, 0-indexed) out of
 * `text` and inserts `replacement`'s lines in their place. Out-of-range
 * indices are rejected by the caller before this runs — silently
 * clamping would partial-apply the patch without telling the caller,
 * which is the failure mode canvas-codec's own parsers reject rather
 * than degrade.
 */
function spliceLines(text: string, range: BodyPatchRange): string {
  const lines = text.split('\n')
  const replacementLines = range.replacement.split('\n')
  const before = lines.slice(0, range.startLine)
  const after = lines.slice(range.endLine + 1)
  return [...before, ...replacementLines, ...after].join('\n')
}

export function createBodyPatchTool(deps: ServerDeps) {
  return {
    name: 'wb_body_patch' as const,
    description:
      'Patch the markdown body of a text node. Either replace the whole body or replace a line range; the schema rules out passing both.',
    inputSchema: bodyPatchInputSchema,
    outputSchema: bodyPatchOutputSchema,
    execute: async (input: BodyPatchInput): Promise<BodyPatchOutput> => {
      await assertCanvasInWorkspace(deps.canvasDocStore, input.workspaceId, input.canvasId)
      const { doc, canvas } = await loadCanvasDoc(deps, input.canvasId)

      const node = canvas.nodes.find((candidate) => candidate.id === input.nodeId)
      if (node === undefined) throw new NodeNotFoundError(input.canvasId, input.nodeId)
      if (node.type !== 'text') {
        throw new NotATextNodeError(input.canvasId, input.nodeId, node.type)
      }

      let newText: string
      if (input.mode === 'full') {
        newText = input.body
      } else {
        const lineCount = node.text.split('\n').length
        if (input.range.startLine >= lineCount || input.range.endLine >= lineCount) {
          throw new PatchValidationError([
            {
              code: 'custom',
              message: `range [${input.range.startLine}, ${input.range.endLine}] is out of bounds for a ${lineCount}-line body`,
              path: ['range'],
              input: input.range,
            },
          ])
        }
        newText = spliceLines(node.text, input.range)
      }

      const mergedRaw = { ...node, text: newText }
      const candidateCanvas = {
        nodes: canvas.nodes.map((existing) =>
          existing.id === input.nodeId ? mergedRaw : existing,
        ),
        edges: canvas.edges,
      }

      const parsed = spatialCanvasSchema.safeParse(candidateCanvas)
      if (!parsed.success) throw new PatchValidationError(parsed.error.issues)

      const updatedNode = parsed.data.nodes.find((existing) => existing.id === input.nodeId)
      if (updatedNode === undefined) {
        throw new NodeNotFoundError(input.canvasId, input.nodeId)
      }

      await saveCanvasDoc(deps, input.canvasId, doc, parsed.data)

      return { canvasId: input.canvasId, node: updatedNode }
    },
  }
}
