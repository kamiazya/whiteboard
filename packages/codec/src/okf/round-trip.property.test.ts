import { coreFacetsArbitrary, facetsRawArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { parseOkf } from './parse.js'
import type { OkfMarkdownFrontmatter } from './schema.js'
import { serializeOkf } from './serialize.js'

// Facet payloads must stay yaml-safe (see yaml-safe.ts) — jsonValue() already
// excludes undefined/NaN/bigint/function/symbol, so the model's own
// extensionFacetsArbitrary (fc.jsonValue()-valued) is already a yaml-safe
// generator; no separate "yaml-safe" arbitrary is needed here.
// `facetsRaw` carries the root keys this package does not model — every OKF
// v0.2 family (`sources`, `generated`, `verified`, `status`, `stale_after`)
// among them. It is generated here rather than pinned as an example because
// preservation is a property of the bucket, not of the fields that happen to
// be in the spec today.
const frontmatterArbitrary: fc.Arbitrary<OkfMarkdownFrontmatter> = fc
  .tuple(coreFacetsArbitrary, fc.option(facetsRawArbitrary, { nil: undefined }))
  .map(([core, facetsRaw]) => (facetsRaw === undefined ? core : { ...core, facetsRaw }))

const okfDocumentArbitrary = fc.record({
  frontmatter: frontmatterArbitrary,
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
      // An empty bucket is not preserved as an empty bucket: it contributes
      // no root keys, so nothing distinguishes it from having had none.
      const expectedRaw =
        doc.frontmatter.facetsRaw === undefined ||
        Object.keys(doc.frontmatter.facetsRaw).length === 0
          ? undefined
          : doc.frontmatter.facetsRaw
      expect(result.value.frontmatter.facetsRaw).toEqual(expectedRaw)
    },
  )
})
