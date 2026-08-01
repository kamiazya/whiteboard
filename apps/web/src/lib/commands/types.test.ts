import { describe, expectTypeOf, it } from 'vitest'
import type { CommandErrorCode } from './types.js'

describe('CommandErrorCode', () => {
  // Pins the error-code union to exactly the codes some surviving command
  // path can construct. A member with no producer is a contract lie — this
  // is what turns that into a compile-time failure instead of something
  // only grep would catch (see create-commands.ts for every producer).
  it('equals exactly the set of codes a surviving code path can construct', () => {
    expectTypeOf<CommandErrorCode>().toEqualTypeOf<
      'no-api' | 'no-canvas' | 'invalid-input' | 'export-failed' | 'invalid-provider-state'
    >()
  })

  it('is exhaustively handled by every code path (never-asserted switch)', () => {
    const ALL_CODES: readonly CommandErrorCode[] = [
      'no-api',
      'no-canvas',
      'invalid-input',
      'export-failed',
      'invalid-provider-state',
    ]

    for (const code of ALL_CODES) {
      switch (code) {
        case 'no-api':
        case 'no-canvas':
        case 'invalid-input':
        case 'export-failed':
        case 'invalid-provider-state':
          break
        default: {
          const exhaustive: never = code
          throw new Error(`unhandled CommandErrorCode: ${String(exhaustive)}`)
        }
      }
    }
  })
})
