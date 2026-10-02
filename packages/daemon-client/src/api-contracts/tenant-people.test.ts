import { apiErrorBodySchema, apiErrorReason } from '@kamiazya/whiteboard-server-core/api-errors'
import { describe, expect, it } from 'vitest'
import { tenantPeopleRefusalSchema } from './tenant-people.js'

describe('tenantPeopleRefusalSchema', () => {
  const codes = tenantPeopleRefusalSchema.shape.error.options

  it('is a narrowing of apiErrorBodySchema: every refusal it admits parses there and reads back its message', () => {
    expect(codes.length).toBeGreaterThan(5)
    for (const error of codes) {
      const refusal = { error, message: `refused: ${error}` }
      expect(tenantPeopleRefusalSchema.safeParse(refusal).success).toBe(true)
      expect(apiErrorBodySchema.safeParse(refusal).success).toBe(true)
      expect(apiErrorReason(refusal)).toBe(refusal.message)
    }
  })

  it('admits the workspaces a sole owner still holds, and the shared contract carries them too', () => {
    const refusal = {
      error: 'sole_owner',
      message: 'still the only owner',
      workspaceIds: ['ws-a', 'ws-b'],
    }
    expect(tenantPeopleRefusalSchema.safeParse(refusal).success).toBe(true)
    expect(apiErrorBodySchema.safeParse(refusal).success).toBe(true)
    expect(apiErrorReason(refusal)).toBe('still the only owner')
  })
})
