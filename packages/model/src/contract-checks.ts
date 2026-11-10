import type { z } from 'zod'
import { EXTENSION_FACET_KEY_PATTERN, RESERVED_ROOT_KEYS } from './facet-keys.js'

// The named checks of `contracts/model`'s `x-wb-check` keyword, in the
// camelCase the generated Zod imports. Each is a `superRefine` callback so a
// check can report several issues at paths of its own, and each has a Rust
// twin of the snake_case name in `whiteboard-model`'s `checks.rs`; the pair is
// held equal by the differential, not by this file.
//
// This module never imports the generated schemas, which is what lets them
// import it without a cycle.

/** OKF section 7's actor: a non-blank, single-line string with no surrounding whitespace. */
export function okfActor(value: string, ctx: z.core.$RefinementCtx<string>): void {
  if (value.trim() !== value || /[\r\n]/.test(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'an OKF actor is a single-line string with no surrounding whitespace',
    })
  }
}

/**
 * A malformed key is an issue rather than a silent drop, so a bad key fails the
 * whole parse instead of losing data.
 */
export function extensionFacetKeys(
  value: Record<string, unknown>,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  for (const key of Object.keys(value)) {
    if (!EXTENSION_FACET_KEY_PATTERN.test(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `extension facet key "${key}" must match {namespace}.{name}/v{n}, e.g. "visual.shape/v0"`,
        path: [key],
      })
    }
  }
}

/** A reserved root key lives in its own bucket, never in `facetsRaw` too. */
export function facetsRawKeys(
  value: Record<string, unknown>,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  for (const key of Object.keys(value)) {
    if ((RESERVED_ROOT_KEYS as readonly string[]).includes(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${key}" is a reserved root key and cannot appear in facetsRaw`,
        path: [key],
      })
    }
  }
}

/** The first id that repeats an earlier one in the list, if any. */
export function findDuplicateId(ids: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return undefined
}

interface FrameFields {
  readonly resource?: unknown
  readonly label?: unknown
  readonly background?: unknown
  readonly backgroundStyle?: unknown
}

/**
 * The frame's fields belong to the frame: a node that shows a resource is not
 * one, and carrying them anyway made one document read as two different things
 * depending on which format it crossed first.
 */
export function resourceNodeIsNotFrame(
  node: FrameFields,
  ctx: z.core.$RefinementCtx<FrameFields>,
): void {
  const framed =
    node.label !== undefined || node.background !== undefined || node.backgroundStyle !== undefined
  if (node.resource === undefined || !framed) return
  ctx.addIssue({
    code: 'custom',
    message: "a node that shows a resource is not a frame and has no frame's fields",
  })
}

interface Target {
  readonly targetNodeId?: string
  readonly targetEdgeId?: string
}

/**
 * The thread a comment becomes carries both targets onto one spatial anchor,
 * which an anchor naming two objects refuses; accepted here, the comment was
 * written and then dropped by every reader.
 */
export function namesOneTarget(comment: Target, ctx: z.core.$RefinementCtx<Target>): void {
  if (comment.targetNodeId === undefined || comment.targetEdgeId === undefined) return
  ctx.addIssue({ code: 'custom', message: 'a comment is about a node or an edge, not both' })
}

interface End {
  readonly kind?: string
  readonly node?: string
}

interface Ended {
  readonly id: string
  readonly from: End
  readonly to: End
}

interface CanvasShape {
  readonly nodes: readonly { readonly id: string }[]
  readonly edges: readonly Ended[]
  readonly lines?: readonly Ended[] | undefined
}

// Only a node end can dangle: a point end names nothing to be missing.
const nodeOf = (end: End): string | undefined => (end.kind === 'point' ? undefined : end.node)

/**
 * Ids are unique among nodes, and across edges AND lines (an anchor names an
 * element id, so two elements answering to one makes it ambiguous), and every
 * node an end names exists.
 */
export function spatialCanvasIntegrity(
  value: CanvasShape,
  ctx: z.core.$RefinementCtx<CanvasShape>,
): void {
  const lines = value.lines ?? []
  const duplicateNodeId = findDuplicateId(value.nodes.map((node) => node.id))
  if (duplicateNodeId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `duplicate node id "${duplicateNodeId}"`,
      path: ['nodes'],
    })
  }
  const duplicateElementId = findDuplicateId([...value.edges, ...lines].map((e) => e.id))
  if (duplicateElementId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `duplicate edge or line id "${duplicateElementId}"`,
      path: ['edges'],
    })
  }
  const nodeIds = new Set(value.nodes.map((node) => node.id))
  const dangling = (elements: readonly Ended[], collection: 'edges' | 'lines') => {
    elements.forEach((element, index) => {
      for (const side of ['from', 'to'] as const) {
        const node = nodeOf(element[side])
        if (node === undefined || nodeIds.has(node)) continue
        ctx.addIssue({
          code: 'custom',
          message: `${collection === 'edges' ? 'edge' : 'line'} "${element.id}" references nonexistent ${side} node "${node}"`,
          path: [collection, index, side, 'node'],
        })
      }
    })
  }
  dangling(value.edges, 'edges')
  dangling(lines, 'lines')
}
