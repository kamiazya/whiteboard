/**
 * The ONE producer of stable top-level scene-entry keys, shared by the
 * keyed SVG renderer (svg/keyed.ts) and the scene-diff scoreboard.
 * Identified entries — chrome shapes, edges — key by their id; the content
 * entries that follow a node's chrome inherit that owner id plus an
 * ordinal, matching the documented emission order (shape, then its
 * content, then all edges). Entries before any identified one fall under
 * the `preamble` owner, so a hand-built scene with no ids still keys by
 * position — the same last-resort naming `sceneDigest` uses.
 *
 * The same walk answers whether an entry belongs to the ANNOTATION LAYER
 * (ADR-0024/0025): a patch layer treats a conversation's groups as one
 * thing, because they arrive and leave together — with the default
 * `showResolved`, resolving a thread takes the pin, its count, the leader
 * and the whole bubble out of the scene at once. That question is answered
 * from `commentChrome` and never from the key's shape: a stored comment id
 * may contain a `/` exactly like a document node id can.
 *
 * Ownership carries it, which is the point of doing it in this walk rather
 * than beside it — the count sitting on a pin and the body sitting in a
 * bubble have no id of their own to be marked by.
 */

import type { Scene, SceneNode } from './scene-graph.js'

export interface SceneEntry {
  readonly key: string
  /** Part of the annotation layer rather than of the drawn canvas. */
  readonly annotation: boolean
}

function isCommentChrome(node: SceneNode): boolean {
  return (node.kind === 'shape' || node.kind === 'edge') && node.commentChrome === true
}

export function sceneEntries(scene: Scene): readonly SceneEntry[] {
  const entries: SceneEntry[] = []
  let owner = 'preamble'
  let ownerAnnotation = false
  let ordinal = 0
  for (const node of scene.nodes) {
    const id = 'id' in node && typeof node.id === 'string' ? node.id : undefined
    if (id !== undefined) {
      owner = id
      ownerAnnotation = isCommentChrome(node)
      ordinal = 0
      entries.push({ key: id, annotation: ownerAnnotation })
    } else {
      ordinal += 1
      entries.push({ key: `${owner}#${ordinal}`, annotation: ownerAnnotation })
    }
  }
  return entries
}

export function sceneEntryKeys(scene: Scene): readonly string[] {
  return sceneEntries(scene).map((entry) => entry.key)
}
