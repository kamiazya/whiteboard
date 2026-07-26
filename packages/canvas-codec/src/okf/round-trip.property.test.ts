import { coreFacetsArbitrary } from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { parseOkf } from './parse.js'
import { serializeOkf } from './serialize.js'

// Facet payloads must stay yaml-safe (see yaml-safe.ts) — jsonValue() already
// excludes undefined/NaN/bigint/function/symbol, so the model's own
// extensionFacetsArbitrary (fc.jsonValue()-valued) is already a yaml-safe
// generator; no separate "yaml-safe" arbitrary is needed here.
const okfDocumentArbitrary = fc.record({
  frontmatter: coreFacetsArbitrary,
  body: fc.string({ maxLength: 200 }),
})

describe('OKF round-trip property', () => {
  fcTest.prop([okfDocumentArbitrary], withDefaults())(
    'parseOkf(serializeOkf(x)) equals x up to canonical facet-key ordering and body verbatim',
    (doc) => {
      const text = serializeOkf(doc)
      const result = parseOkf(text)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.body).toBe(doc.body)
      expect(result.value.frontmatter.type).toBe(doc.frontmatter.type)
      expect(result.value.frontmatter.title).toBe(doc.frontmatter.title)
      expect(result.value.frontmatter.tags).toEqual(doc.frontmatter.tags)
      expect(result.value.frontmatter.view).toBe(doc.frontmatter.view)
    },
  )
})
