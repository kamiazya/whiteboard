import { describe, expectTypeOf, it } from 'vitest'
import type { CommandErrorCode } from './types.js'

describe('CommandErrorCode', () => {
  // Pins the error-code union to exactly the codes some surviving command
  // path can construct. A member with no producer is a contract lie — this
  // is what turns that into a compile-time failure instead of something
  // only grep would catch (see create-commands.ts for every producer).
  it('equals exactly the set of codes a surviving code path can construct', () => {
    expectTypeOf<CommandErrorCode>().toEqualTypeOf<'invalid-input' | 'invalid-provider-state'>()
  })
})
