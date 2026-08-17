// The extension contract: a document this codec emits is JSON Canvas 1.0
// plus AT MOST the single `x-whiteboard` key (canvas level and node level).
// Foreign keys on an incoming document — another tool's vendor fields, a
// future format's additions — are stripped on parse, never re-emitted.
// The machine-readable half of this contract is
// docs/reference/x-whiteboard.schema.json (generated from model).
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { fcTest, withDefaults } from '../test-utils/fast-check.js'
import { parseSpatial } from './parse.js'
import { serializeSpatial } from './serialize.js'

const CANVAS_KEYS = new Set(['nodes', 'edges', 'x-whiteboard'])
const SHARED_NODE_KEYS = ['id', 'x', 'y', 'width', 'height', 'color', 'x-whiteboard', 'type']
const NODE_KEYS: Record<string, Set<string>> = {
  text: new Set([...SHARED_NODE_KEYS, 'text']),
  file: new Set([...SHARED_NODE_KEYS, 'file', 'subpath']),
  link: new Set([...SHARED_NODE_KEYS, 'url']),
  group: new Set([...SHARED_NODE_KEYS, 'label', 'background', 'backgroundStyle']),
}
const EDGE_KEYS = new Set([
  'id',
  'fromNode',
  'toNode',
  'fromSide',
  'toSide',
  'fromEnd',
  'toEnd',
  'color',
  'label',
])

const JUNK = { 'x-vendor': { custom: true }, obsidianField: 'v' }

/** The canvas as JSON text with foreign keys injected at every level. */
function withForeignKeys(canvas: SpatialCanvas): string {
  const doc = JSON.parse(JSON.stringify(canvas)) as {
    nodes: Record<string, unknown>[]
    edges: Record<string, unknown>[]
  }
  Object.assign(doc, JUNK)
  for (const node of doc.nodes) Object.assign(node, JUNK)
  for (const edge of doc.edges) Object.assign(edge, JUNK)
  return JSON.stringify(doc)
}

function foreignKeysOf(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key))
}

describe('extension contract: x-whiteboard is the only non-standard key ever emitted', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'parse strips foreign keys at every level and re-emission stays within the contract',
    (canvas) => {
      const result = parseSpatial(withForeignKeys(canvas))
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const emitted = JSON.parse(serializeSpatial(result.value, 'extended')) as {
        nodes: Record<string, unknown>[]
        edges: Record<string, unknown>[]
      }
      expect(foreignKeysOf(emitted, CANVAS_KEYS)).toEqual([])
      for (const node of emitted.nodes) {
        expect(foreignKeysOf(node, NODE_KEYS[node.type as string] ?? new Set())).toEqual([])
      }
      for (const edge of emitted.edges) {
        expect(foreignKeysOf(edge, EDGE_KEYS)).toEqual([])
      }
    },
  )
})
