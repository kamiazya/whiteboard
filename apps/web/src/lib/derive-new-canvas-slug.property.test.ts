import { describe } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { deriveNewCanvasSlug } from './derive-new-canvas-slug.js'

const PROPERTY_PARAMS = withDefaults({ numRuns: 100 })

describe('deriveNewCanvasSlug (fast-check)', () => {
  fcTest.prop([fc.array(fc.string())], PROPERTY_PARAMS)(
    'never returns a slug already in the existing set',
    (existing) => {
      const result = deriveNewCanvasSlug(existing)
      return !existing.includes(result)
    },
  )

  fcTest.prop([fc.array(fc.string())], PROPERTY_PARAMS)(
    'always matches the server-accepted slug charset',
    (existing) => {
      const result = deriveNewCanvasSlug(existing)
      return /^[a-zA-Z0-9-]+$/.test(result)
    },
  )

  fcTest.prop([fc.array(fc.string())], PROPERTY_PARAMS)(
    'is deterministic for the same input set',
    (existing) => {
      const first = deriveNewCanvasSlug(existing)
      const second = deriveNewCanvasSlug([...existing])
      return first === second
    },
  )
})
