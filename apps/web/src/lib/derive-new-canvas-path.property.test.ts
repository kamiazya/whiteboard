import { describe } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { deriveNewCanvasPath } from './derive-new-canvas-path.js'

const PROPERTY_PARAMS = withDefaults({ numRuns: 100 })

describe('deriveNewCanvasPath (fast-check)', () => {
  fcTest.prop([fc.array(fc.string())], PROPERTY_PARAMS)(
    'never returns a path already in the existing set',
    (existing) => {
      const result = deriveNewCanvasPath(existing)
      return !existing.includes(result)
    },
  )

  fcTest.prop([fc.array(fc.string())], PROPERTY_PARAMS)(
    'always matches the server-accepted path charset',
    (existing) => {
      const result = deriveNewCanvasPath(existing)
      return /^[a-zA-Z0-9-]+$/.test(result)
    },
  )

  fcTest.prop([fc.array(fc.string())], PROPERTY_PARAMS)(
    'is deterministic for the same input set',
    (existing) => {
      const first = deriveNewCanvasPath(existing)
      const second = deriveNewCanvasPath([...existing])
      return first === second
    },
  )
})
