// The URL builders and the path parser are one contract written in two
// directions (the file's own docblock says so), which is exactly the
// parser/serializer shape that earns a round-trip property: every segment
// the builders encode, the parser must hand back verbatim — including the
// adversarial cases the docblock calls out (slashes and percent signs
// INSIDE a segment, a document whose last segment collides with an action
// name).

import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  documentApiUrl,
  documentFileApiUrl,
  documentPathForAction,
  documentPathForFile,
  parseDocumentApiPath,
} from './document-url.js'

const ACTIONS = [
  'snapshot',
  'exists',
  'update',
  'export',
  'export-svg',
  'viewport',
  'client-count',
] as const

/**
 * A path segment as data: non-empty, and deliberately DENSE in the
 * characters that break naive URL handling — the separators themselves,
 * percent signs, spaces, unicode — plus the action names, so the
 * "document named like an action" collision is generated rather than
 * hand-picked.
 */
const segmentArb = fc.oneof(
  { arbitrary: fc.string({ minLength: 1, maxLength: 12 }), weight: 3 },
  {
    arbitrary: fc.constantFrom('/', '%', '%2F', 'a/b', 'file', '..', ' ', '導線', ...ACTIONS),
    weight: 1,
  },
)

const documentPathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join('/'))
  // A segment that is itself '/' produces an empty segment once joined,
  // which the parser rejects by contract ("not-a-match rather than a
  // throw") — keep the generator on paths every segment of which is data.
  .filter((path) => path.split('/').every((segment) => segment.length > 0))

const workspaceIdArb = segmentArb

describe('document-url round trip', () => {
  fcTest.prop([workspaceIdArb, documentPathArb, fc.constantFrom(...ACTIONS)], withDefaults())(
    'documentApiUrl -> parseDocumentApiPath -> documentPathForAction recovers the input',
    (workspaceId, path, action) => {
      const parsed = parseDocumentApiPath(documentApiUrl(workspaceId, path, action))
      expect(parsed).not.toBeNull()
      expect(parsed?.workspaceId).toBe(workspaceId)
      expect(documentPathForAction(parsed?.tail ?? [], action)).toBe(path)
    },
  )

  fcTest.prop([workspaceIdArb, documentPathArb, segmentArb], withDefaults())(
    'documentFileApiUrl -> parseDocumentApiPath -> documentPathForFile recovers path and fileId',
    (workspaceId, path, fileId) => {
      const parsed = parseDocumentApiPath(documentFileApiUrl(workspaceId, path, fileId))
      expect(parsed).not.toBeNull()
      expect(parsed?.workspaceId).toBe(workspaceId)
      expect(documentPathForFile(parsed?.tail ?? [])).toEqual({ path, fileId })
    },
  )
})
