/**
 * The ONE producer of stable top-level scene-entry keys, shared by the
 * keyed SVG renderer (svg/keyed.ts) and the scene-diff scoreboard.
 * Identified entries — chrome shapes, edges — key by their id; the content
 * entries that follow a node's chrome inherit that owner id plus an
 * ordinal, matching the documented emission order (shape, then its
 * content, then all edges). Entries before any identified one fall under
 * the `preamble` owner, so a hand-built scene with no ids still keys by
 * position — the same last-resort naming `sceneDigest` uses.
 */

import type { Scene } from './scene-graph.js'

export function sceneEntryKeys(scene: Scene): readonly string[] {
  const keys: string[] = []
  let owner = 'preamble'
  let ordinal = 0
  for (const node of scene.nodes) {
    const id = 'id' in node && typeof node.id === 'string' ? node.id : undefined
    if (id !== undefined) {
      owner = id
      ordinal = 0
      keys.push(id)
    } else {
      ordinal += 1
      keys.push(`${owner}#${ordinal}`)
    }
  }
  return keys
}
