import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSpatial } from '@kamiazya/whiteboard-codec'
import { endpointNodes } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'

// The two spatial-canvas diagram sources rendered by architecture.docs-snapshot,
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
    //
    // `endpointNodes` rather than two field reads: a JSON Canvas file can
    // only author NODE ends, so every edge here names two — but the check is
    // "does what this names exist", and since ADR-0035 slice 3 an end may
    // name nothing. Reading `edge.fromNode` off the parsed MODEL answered
    // `undefined` and this assertion failed without saying why.
    const nodeIds = new Set(result.value.nodes.map((node) => node.id))
    for (const edge of result.value.edges) {
      const named = endpointNodes(edge)
      expect(named).toHaveLength(2)
      for (const node of named) expect(nodeIds.has(node)).toBe(true)
    }
    expect(result.value.nodes.length).toBeGreaterThan(0)
  })
})
