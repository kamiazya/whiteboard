import { documentPathSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fc, fcTest } from '../shared/test-utils/fast-check.js'
import {
  validateDocumentPath,
  validateFileId,
  validateVersionId,
  validateWorkspaceId,
} from './validators.js'

describe('shared validators', () => {
  it('accepts valid session ids, paths, and ids', () => {
    expect(validateWorkspaceId('sess_1-abc')).toBe('sess_1-abc')
    expect(validateDocumentPath('621/header-v2')).toBe('621/header-v2')
    expect(validateVersionId('ver-1')).toBe('ver-1')
    expect(validateFileId('file_1-abc')).toBe('file_1-abc')
  })

  it('rejects invalid route/store identifiers', () => {
    expect(() => validateWorkspaceId('../escape')).toThrow(/Invalid workspaceId/)
    expect(() => validateDocumentPath('../escape')).toThrow(/Invalid path/)
    expect(() => validateVersionId('bad.id')).toThrow(/Invalid version id/)
    expect(() => validateFileId('bad/id')).toThrow(/Invalid file id/)
  })
})

describe('validateDocumentPath / documentPathSchema conformance', () => {
  // Two expressions of one rule: the schema is what the shared layer parses
  // with, validateDocumentPath is what explains a rejection per cause. They are
  // single-sourced on DOCUMENT_PATH_SEGMENT_PATTERN, and this is what keeps
  // the composition around it — the split on '/', the empty-segment case —
  // from drifting away from the schema's own refine.
  const accepts = (path: string): boolean => {
    try {
      validateDocumentPath(path)
      return true
    } catch {
      return false
    }
  }

  fcTest.prop([
    fc.oneof(
      // Dense enough to reach the interesting arrangements: bare segments,
      // real paths, and the separator abuse (leading/trailing/doubled '/')
      // that a generic string arbitrary would essentially never produce.
      fc.string(),
      fc
        .array(fc.stringMatching(/^[a-zA-Z0-9-]{0,4}$/), { minLength: 1, maxLength: 3 })
        .map((parts) => parts.join('/')),
      fc
        .array(fc.stringMatching(/^[a-zA-Z0-9-]{0,4}$/), { minLength: 1, maxLength: 3 })
        .map((parts) => `/${parts.join('//')}/`),
    ),
  ])('accept exactly the same strings', (path) => {
    expect(documentPathSchema.safeParse(path).success).toBe(accepts(path))
  })
})
