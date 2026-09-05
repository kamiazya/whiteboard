// @vitest-environment node
import { describe } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { deriveNewDocumentPath } from './derive-new-document-path.js'

const PROPERTY_PARAMS = withDefaults({ numRuns: 100 })

describe('deriveNewDocumentPath (fast-check)', () => {
  fcTest.prop([fc.array(fc.string())], PROPERTY_PARAMS)(
    'never returns a path already in the existing set',
    (existing) => {
      const result = deriveNewDocumentPath(existing)
      return !existing.includes(result)
    },
  )

  fcTest.prop([fc.array(fc.string())], PROPERTY_PARAMS)(
    'always matches the server-accepted path charset',
    (existing) => {
      const result = deriveNewDocumentPath(existing)
      return /^[a-zA-Z0-9-]+$/.test(result)
    },
  )

  fcTest.prop([fc.array(fc.string())], PROPERTY_PARAMS)(
    'is deterministic for the same input set',
    (existing) => {
      const first = deriveNewDocumentPath(existing)
      const second = deriveNewDocumentPath([...existing])
      return first === second
    },
  )
})
