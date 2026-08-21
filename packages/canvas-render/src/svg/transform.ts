/**
 * The VNode optimization-pass seam: byte-level rewrites applied between
 * rendering (scene -> VNode) and canonical serialization (VNode -> bytes).
 *
 * A registered pass must honour four contracts, in addition to its own
 * render-equivalence oracle (each pass ships one; see hoist.test.ts):
 *
 * - RENDER-EQUIVALENT: the output draws identically to the input. Passes
 *   optimize the byte encoding, never the picture. Anything that decides
 *   how something LOOKS (theme, style) belongs upstream in the scene
 *   layer, which still has the semantic provenance a paint decision
 *   needs — a VNode carries only tags and resolved values.
 * - GROUP-LOCAL by construction: a pass receives ONE top-level scene
 *   entry's subtree and never its siblings, because the keyed projection
 *   (svg/keyed.ts) uses string equality as change detection — a pass
 *   whose output for one entry depended on another would dirty unrelated
 *   groups on every edit and destroy the patch layer's DOM reuse.
 *   Cross-entry sharing goes through the defs mechanism (content-derived
 *   ids) instead.
 * - DETERMINISTIC and platform-free: byte-identical output on Node, the
 *   browser, and Workers, per this package's headline guarantee.
 * - TOTAL: never throws, on any tree including degenerate ones.
 *
 * transform.test.ts holds the generic half of this contract (determinism,
 * idempotence, serializability) for every registered pass; registering a
 * pass there is part of adding one.
 */

import { hoistInheritedAttrs } from './hoist.js'
import type { SvgChild } from './vnode.js'

export type SvgNodeTransform = (child: SvgChild) => SvgChild

export const OPTIMIZATION_PASSES: readonly SvgNodeTransform[] = [hoistInheritedAttrs]

export function applyOptimizationPasses(
  child: SvgChild,
  passes: readonly SvgNodeTransform[] = OPTIMIZATION_PASSES,
): SvgChild {
  let current = child
  for (const pass of passes) current = pass(current)
  return current
}
