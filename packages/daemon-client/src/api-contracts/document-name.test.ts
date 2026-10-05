import {
  DOCUMENT_NAME_MAX_LENGTH,
  documentNameSchema,
  WORKSPACE_DISPLAY_NAME_MAX_LENGTH,
} from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { setNameRequestSchema } from './document.js'

const overLimit = 'x'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1)

/**
 * A document is renamed through this route (the browser's rename dialog) and
 * through `wb_workspace_edit` (an agent). Each is held to `documentNameSchema`
 * in that schema's own words — the tool side by server-core's
 * `workspace-edit.name-limit.test.ts`, this route here — so the two cannot
 * drift apart without one of them failing. This package may not import
 * server-core's root barrel, which is where the tool lives.
 */
const rename = (name: string) => setNameRequestSchema.safeParse({ name })

function refusalMessages(parsed: unknown): string[] {
  const result = parsed as { success: boolean; error?: { issues: { message: string }[] } }
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? [])
}

describe('the document rename route', () => {
  it("refuses one character past the limit, in the shared schema's words", () => {
    const expected = refusalMessages(documentNameSchema.safeParse(overLimit))
    expect(expected).toHaveLength(1)
    expect(refusalMessages(rename(overLimit))).toEqual(expected)
  })

  it('still takes the blank that clears a name', () => {
    expect(rename('').success).toBe(true)
  })
})

describe('the rename body the workspace route shares', () => {
  // `PUT /api/workspaces/:id/name` reads the same body, so the bound must not
  // refuse a workspace name its own schema admits.
  it('admits the longest workspace display name', () => {
    const longest = 'x'.repeat(WORKSPACE_DISPLAY_NAME_MAX_LENGTH)
    expect(setNameRequestSchema.safeParse({ name: longest }).success).toBe(true)
  })
})
