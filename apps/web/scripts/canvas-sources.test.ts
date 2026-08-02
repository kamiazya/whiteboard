import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSpatial } from '@kamiazya/whiteboard-canvas-codec'
import { describe, expect, it } from 'vitest'

// The two OpenCanvas diagram sources rendered by architecture.docs-snapshot,
// canvas-presentation.docs-snapshot, and canvas-auth-flow.docs-snapshot. A
// hand-edited .canvas file that fails to parse must fail loudly here rather
// than silently rendering an empty PNG.

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = resolve(__dirname, '..', '..', '..', 'docs', 'assets')

describe('docs/assets diagram sources', () => {
  it.each([
    'architecture.canvas',
    'canvas-auth-flow.canvas',
  ] as const)('%s parses as a valid JSON Canvas document', (fileName) => {
    const raw = readFileSync(resolve(ASSETS_DIR, fileName), 'utf-8')
    const result = parseSpatial(raw)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Referential integrity beyond spatialCanvasSchema's own duplicate-id
    // refinement: every edge endpoint must resolve to a node that exists
    // in the same document, or the diagram silently degrades in
    // layoutSpatialCanvas rather than failing this test.
    const nodeIds = new Set(result.value.nodes.map((node) => node.id))
    for (const edge of result.value.edges) {
      expect(nodeIds.has(edge.fromNode)).toBe(true)
      expect(nodeIds.has(edge.toNode)).toBe(true)
    }
    expect(result.value.nodes.length).toBeGreaterThan(0)
  })
})
