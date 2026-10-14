/**
 * A body type is the route's input minus the keys its URL carries. These
 * hold that subtraction to exactly those keys: an over-broad `Omit` would
 * leave the client's `satisfies` checking nothing, and an under-broad one
 * would demand a key the route refuses from a body.
 */
import {
  linkifyMentionsInputSchema,
  wbDocumentCreateInputSchema,
} from '@kamiazya/whiteboard-server-core/contracts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { CreateDocumentV1Request, LinkifyMentionsV1Request } from './index.js'

const WORKSPACE_ID = '01HZX3K9Q5V8N2M4P6R7S8T9WA'
const SOURCE_ID = '01HZX3K9Q5V8N2M4P6R7S8T9WB'
const TARGET_ID = '01HZX3K9Q5V8N2M4P6R7S8T9WC'

describe('LinkifyMentionsV1Request', () => {
  it('is the input without the workspace and source the path carries', () => {
    expectTypeOf<keyof LinkifyMentionsV1Request>().toEqualTypeOf<'targetDocumentId'>()
    const body: LinkifyMentionsV1Request = { targetDocumentId: TARGET_ID }
    const parsed = linkifyMentionsInputSchema.safeParse({
      ...body,
      workspaceId: WORKSPACE_ID,
      documentId: SOURCE_ID,
    })
    expect(parsed.success).toBe(true)
  })
})

describe('CreateDocumentV1Request', () => {
  it('drops the workspace from every kind and keeps each kind its own keys', () => {
    type Markdown = Extract<CreateDocumentV1Request, { kind: 'markdown' }>
    type Spatial = Extract<CreateDocumentV1Request, { kind: 'spatial' }>
    expectTypeOf<'workspaceId' extends keyof Markdown ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<'workspaceId' extends keyof Spatial ? true : false>().toEqualTypeOf<false>()
    expectTypeOf<'markdown' extends keyof Markdown ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<'markdown' extends keyof Spatial ? true : false>().toEqualTypeOf<false>()

    const bodies: CreateDocumentV1Request[] = [
      { path: 'notes/a', kind: 'markdown', name: 'A' },
      { path: 'board', kind: 'spatial' },
    ]
    for (const body of bodies) {
      const parsed = wbDocumentCreateInputSchema.safeParse({ ...body, workspaceId: WORKSPACE_ID })
      expect(parsed.success).toBe(true)
    }
  })
})
