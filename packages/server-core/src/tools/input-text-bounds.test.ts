// Free-text inputs a tool only looks up by are still bounded, so a request
// cannot hand a lookup an arbitrarily long string. Each bound is the one the
// thing looked up was written under.

import { ID_MAX_CHARS, LABEL_MAX_CHARS, TAG_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { canvasRenderSvgInputSchema } from './canvas-render-svg.js'
import { facetSetInputSchema } from './facet-set.schemas.js'
import { versionRestoreInputSchema } from './version-restore.js'

const WS = 'ws-1'
const DOC = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const of = (length: number) => 'a'.repeat(length)

const CASES = [
  {
    field: 'wb_scene_render fragment',
    bound: LABEL_MAX_CHARS,
    parse: (value: string) =>
      canvasRenderSvgInputSchema.safeParse({ workspaceId: WS, documentId: DOC, fragment: value }),
  },
  {
    field: 'wb_version_restore versionId',
    bound: ID_MAX_CHARS,
    parse: (value: string) =>
      versionRestoreInputSchema.safeParse({ workspaceId: WS, documentId: DOC, versionId: value }),
  },
  {
    field: 'wb_facet_set tags.remove[]',
    bound: TAG_MAX_CHARS,
    parse: (value: string) =>
      facetSetInputSchema.safeParse({
        workspaceId: WS,
        documentIds: [DOC],
        tags: { remove: [value] },
      }),
  },
  {
    field: 'wb_facet_set tags.rename[].from',
    bound: TAG_MAX_CHARS,
    parse: (value: string) =>
      facetSetInputSchema.safeParse({
        workspaceId: WS,
        documentIds: [DOC],
        tags: { rename: [{ from: value, to: 'b' }] },
      }),
  },
]

describe.each(CASES)('$field', ({ bound, parse }) => {
  it('accepts a value at its bound', () => {
    expect(parse(of(bound)).success).toBe(true)
  })

  it('refuses a value one past its bound', () => {
    expect(parse(of(bound + 1)).success).toBe(false)
  })
})
