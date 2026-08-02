// The hand-authored JSON Canvas sources under docs/assets/ are the source of
// truth for every diagram the doc snapshots render. Parsing them here once
// keeps the parse-or-throw contract in a single place: a hand-edited .canvas
// file that stops parsing fails loudly at import time instead of silently
// rendering an empty PNG.

import architectureRaw from '@docs-assets/architecture.canvas?raw'
import authFlowRaw from '@docs-assets/canvas-auth-flow.canvas?raw'
import { parseSpatial } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'

function parseCanvasSource(raw: string, fileName: string): SpatialCanvas {
  const parsed = parseSpatial(raw)
  if (!parsed.ok) {
    throw new Error(`${fileName} failed to parse: ${parsed.error.message}`)
  }
  return parsed.value
}

export const ARCHITECTURE_SCENE = parseCanvasSource(architectureRaw, 'architecture.canvas')
export const AUTH_FLOW_SCENE = parseCanvasSource(authFlowRaw, 'canvas-auth-flow.canvas')
