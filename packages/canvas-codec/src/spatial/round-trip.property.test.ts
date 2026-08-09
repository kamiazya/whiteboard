import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe, expect } from 'vitest'
import { fcTest, withDefaults } from '../test-utils/fast-check.js'
import { parseSpatial } from './parse.js'
import { serializeSpatial } from './serialize.js'

describe('extended JSON Canvas round-trip property (lossless)', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'parseSpatial(serializeSpatial(x, "extended")) deep-equals x',
    (canvas) => {
      const text = serializeSpatial(canvas, 'extended')
      const result = parseSpatial(text)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual(canvas)
    },
  )
})
