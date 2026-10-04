import { describe, expect, it } from 'vitest'
import { operatorRefusal } from './named-user.js'

describe('operatorRefusal', () => {
  it('reads a user deleted between lookup and operation as unknown, with no candidates', () => {
    expect(operatorRefusal({ kind: 'refused', reason: 'unknown_user' })).toEqual({
      kind: 'unknown-user',
      users: [],
    })
  })

  it('throws naming a self-refusal, which the operator can never be answered with', () => {
    expect(() => operatorRefusal({ kind: 'refused', reason: 'cannot_deactivate_self' })).toThrow(
      'the operator cannot be refused as acting on themselves: cannot_deactivate_self',
    )
  })
})
