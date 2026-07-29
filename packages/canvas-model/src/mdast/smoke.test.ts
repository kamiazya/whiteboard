import { describe, expect, it } from 'vitest'
// Imported by its published specifier, not a relative path, to exercise
// package.json `exports` resolution the way a real consumer will.
import { mdastRootSchema } from '@kamiazya/whiteboard-canvas-model/mdast'

describe('canvas-model /mdast subpath export', () => {
  it('resolves the published specifier and validates a root node', () => {
    const root = { type: 'root', children: [] }

    expect(mdastRootSchema.parse(root)).toEqual(root)
  })
})
