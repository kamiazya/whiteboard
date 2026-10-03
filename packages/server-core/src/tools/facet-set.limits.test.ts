// The ceiling `wb_facet_set` puts on one request. The number is part of the
// published input schema, so it is pinned as a literal rather than imported.

import { describe, expect, test } from 'vitest'
import { facetSetInputSchema } from './facet-set.js'

describe('wb_facet_set — documents per request', () => {
  const request = (count: number) => ({
    workspaceId: 'ws-1',
    tags: { add: ['x'] },
    documentIds: Array.from(
      { length: count },
      (_, i) => `01H8XJZ9K5N4M3P2Q1R0S9T8${String(i).padStart(2, '0')}`,
    ),
  })

  test('accepts 50 documents', () => {
    expect(facetSetInputSchema.safeParse(request(50)).success).toBe(true)
  })

  test('refuses 51 documents', () => {
    expect(facetSetInputSchema.safeParse(request(51)).success).toBe(false)
  })
})
