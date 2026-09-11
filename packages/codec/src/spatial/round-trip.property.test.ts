import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { fcTest, withDefaults } from '../test-utils/fast-check.js'
import { parseSpatial } from './parse.js'
import { fromJsonCanvas, toJsonCanvas } from './projection.js'
import { serializeSpatial } from './serialize.js'

describe('extended JSON Canvas round-trip property', () => {
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'parseSpatial(serializeSpatial(x, "extended")) deep-equals x, once x is what the format can state',
    (canvas) => {
      // Extended mode is lossless over what the FORMAT can express, which
      // stopped being everything the model can hold when geometry went
      // sub-pixel (ADR-0035 slice 4): JSON Canvas 1.0 specifies integer
      // pixels, so the projection rounds. Putting the canvas through the
      // projection first is what names that subset, and the equality below
      // is exact inside it.
      const expressible = fromJsonCanvas(toJsonCanvas(canvas))
      const result = parseSpatial(serializeSpatial(expressible, 'extended'))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual(expressible)
    },
  )
})
