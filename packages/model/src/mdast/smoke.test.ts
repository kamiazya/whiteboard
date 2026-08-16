import { mdastRootSchema } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'

describe('model /mdast subpath export', () => {
  it('resolves the published specifier and validates a root node', () => {
    const root = { type: 'root', children: [] }

    expect(mdastRootSchema.parse(root)).toEqual(root)
  })
})
