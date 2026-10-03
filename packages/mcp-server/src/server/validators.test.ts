import { documentPathSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fc, fcTest } from '../shared/test-utils/fast-check.js'
import {
  ValidationError,
  validateDocumentPath,
  validateFileId,
  validateVersionId,
  validateWorkspaceId,
} from './validators.js'

function rejection(run: () => unknown): ValidationError {
  try {
    run()
  } catch (error) {
    if (error instanceof ValidationError) return error
    throw error
  }
  throw new Error('expected a ValidationError, but nothing was thrown')
}

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

describe('validateWorkspaceId / workspaceIdSchema conformance', () => {
  // The schema is what the shared layer parses with, validateWorkspaceId is
  // what explains a rejection. They share WORKSPACE_ID_PATTERN, and this keeps
  // the empty-string case and any future extra rule from drifting apart.
  const accepts = (id: string): boolean => {
    try {
      validateWorkspaceId(id)
      return true
    } catch {
      return false
    }
  }

  // A safe id with one hostile character spliced in is the arrangement a
  // generic string arbitrary would almost never produce.
  const hostile = fc.constantFrom(
    '.',
    '/',
    '\\',
    ' ',
    '\n',
    '\0',
    '\u00e9',
    '\u3042',
    '%',
    '\u200b',
  )
  const spliced = fc
    .tuple(
      fc.stringMatching(/^[a-zA-Z0-9_-]{0,6}$/),
      hostile,
      fc.stringMatching(/^[a-zA-Z0-9_-]{0,6}$/),
    )
    .map(([head, bad, tail]) => `${head}${bad}${tail}`)

  fcTest.prop([fc.oneof(fc.string(), fc.stringMatching(/^[a-zA-Z0-9_-]{0,12}$/), spliced)])(
    'accept exactly the same strings',
    (id) => {
      expect(workspaceIdSchema.safeParse(id).success).toBe(accepts(id))
    },
  )

  it('both refuse the empty string', () => {
    expect(accepts('')).toBe(false)
    expect(workspaceIdSchema.safeParse('').success).toBe(false)
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

// The conformance blocks above pin WHICH strings are refused. These pin WHY, since
// the validator's whole job over the schema is the per-cause explanation a caller reads.
describe('validator rejection reasons', () => {
  it.each([
    ['', 'invalid_document_path', /path is empty/],
    ['a b', 'invalid_document_path', /segment "a b" contains whitespace/],
    ['a/b\tc', 'invalid_document_path', /segment "b\tc" contains whitespace/],
    ['a.b', 'invalid_document_path', /segment "a\.b" contains '\.'/],
    ['-a', 'invalid_document_path', /segment "-a" leading hyphen is not allowed/],
    ['a/-b', 'invalid_document_path', /segment "-b" leading hyphen is not allowed/],
    ['a-', 'invalid_document_path', /segment "a-" trailing hyphen is not allowed/],
    ['a-/b', 'invalid_document_path', /segment "a-" trailing hyphen is not allowed/],
    ['a//b', 'invalid_document_path', /segment "" empty segment/],
    ['/a', 'invalid_document_path', /segment "" empty segment/],
    ['a\u00e9', 'invalid_document_path', /segment "a\u00e9" contains invalid character/],
  ])('validateDocumentPath(%j) says why', (path, code, message) => {
    const error = rejection(() => validateDocumentPath(path))
    expect(error.error).toBe(code)
    expect(error.message).toMatch(message)
  })

  it.each([
    ['', /workspaceId is empty/],
    ['a b', /only ASCII letters, digits, "_" and "-" are allowed/],
    ['a.b', /only ASCII letters, digits, "_" and "-" are allowed/],
  ])('validateWorkspaceId(%j) says why', (id, message) => {
    const error = rejection(() => validateWorkspaceId(id))
    expect(error.error).toBe('invalid_workspace_id')
    expect(error.message).toMatch(message)
  })

  it('names the kind of identifier in the error code', () => {
    expect(rejection(() => validateVersionId('a.b')).error).toBe('invalid_version_id')
    expect(rejection(() => validateFileId('a.b')).error).toBe('invalid_file_id')
  })

  // The cap is a second rule behind the character class: an over-long id is
  // made only of allowed characters, so only its length can refuse it.
  it.each([
    { kind: 'version id', validate: validateVersionId, cap: 64 },
    { kind: 'file id', validate: validateFileId, cap: 128 },
  ])('caps a $kind at $cap characters', ({ kind, validate, cap }) => {
    expect(validate('a'.repeat(cap))).toHaveLength(cap)
    const error = rejection(() => validate('a'.repeat(cap + 1)))
    expect(error.error).toBe(`invalid_${kind.replace(' ', '_')}`)
    expect(error.message).toContain(`exceeds ${cap} character limit`)
  })
})
