// The oracle is the WHATWG URL parser fetch itself runs, not this module: a
// URL it would normalise reaches a different same-origin path than the one
// built, so the builders either answer a stable URL or refuse.

import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { documentByIdApiUrl, documentFileByIdApiUrl } from './document-url.js'

const isDotSegment = (segment: string) => segment === '.' || segment === '..'

/**
 * Segments dense in what the URL parser rewrites: both dot segments, their
 * percent-encoded spellings, and near misses that must survive as data —
 * beside the separators and a percent sign, which a segment may carry.
 */
const dottySegmentArb = fc.constantFrom(
  '.',
  '..',
  '%2e',
  '%2E%2e',
  '.%2e',
  '...',
  'a',
  'a.b',
  '/',
  '%',
  'a/b',
  ' ',
  '導線',
)

/** Whether a builder's answer is one the URL parser leaves exactly as written. */
function urlParserKeeps(build: () => string): boolean {
  let url: string
  try {
    url = build()
  } catch {
    return true
  }
  return new URL(url, 'http://localhost').pathname === url
}

describe('document-url builders and the URL parser', () => {
  fcTest.prop([dottySegmentArb, dottySegmentArb, dottySegmentArb], withDefaults())(
    'every URL a builder answers is left unchanged by the URL parser',
    (workspaceId, documentId, fileId) => {
      expect(urlParserKeeps(() => documentByIdApiUrl(workspaceId, documentId, 'snapshot'))).toBe(
        true,
      )
      expect(urlParserKeeps(() => documentFileByIdApiUrl(workspaceId, documentId, fileId))).toBe(
        true,
      )
    },
  )

  // The near misses (`...`, `a.b`, a literal `%2e`) are data, so the refusal
  // is no wider than the dot segments themselves.
  fcTest.prop([dottySegmentArb], withDefaults())(
    'refuses exactly the ids that are a dot segment',
    (documentId) => {
      const build = () => documentByIdApiUrl('ws', documentId, 'snapshot')
      if (isDotSegment(documentId)) expect(build).toThrow(/dot segment/)
      else expect(build).not.toThrow()
    },
  )
})
