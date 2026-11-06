import {
  DOCUMENT_PATH_MAX_LENGTH,
  documentPathSchema,
  workspaceCanonicalIdSchema,
  workspaceSegmentSchema,
} from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fc, fcTest } from '../shared/test-utils/fast-check.js'
import {
  ValidationError,
  validateDocumentPath,
  validateFileId,
  validateVersionId,
  validateWorkspaceHandle,
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

const WORKSPACE_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('shared validators', () => {
  it('accepts valid workspace ids and handles, paths, and ids', () => {
    expect(validateWorkspaceId(WORKSPACE_ULID)).toBe(WORKSPACE_ULID)
    expect(validateWorkspaceHandle(WORKSPACE_ULID)).toBe(WORKSPACE_ULID)
    expect(validateWorkspaceHandle('team-plans')).toBe('team-plans')
    expect(validateDocumentPath('621/header-v2')).toBe('621/header-v2')
    expect(validateVersionId('ver-1')).toBe('ver-1')
    expect(validateFileId('file_1-abc')).toBe('file_1-abc')
  })

  it('rejects invalid route/store identifiers', () => {
    expect(() => validateWorkspaceId('../escape')).toThrow(/Invalid workspaceId/)
    expect(() => validateWorkspaceHandle('../escape')).toThrow(/Invalid workspaceId/)
    expect(() => validateDocumentPath('../escape')).toThrow(/Invalid path/)
    expect(() => validateVersionId('bad.id')).toThrow(/Invalid version id/)
    expect(() => validateFileId('bad/id')).toThrow(/Invalid file id/)
  })
})

describe('workspace validators / model schema conformance', () => {
  // The schemas are what the shared layer parses with, the validators are what
  // explain a rejection. This keeps the two from drifting apart: an id is the
  // canonical ULID and nothing else, a handle is that id or a segment.
  const accepts = (validate: (value: string) => string, value: string): boolean => {
    try {
      validate(value)
      return true
    } catch {
      return false
    }
  }

  // A safe string with one hostile character spliced in is the arrangement a
  // generic string arbitrary would almost never produce; `_` is there because
  // a nanoid-minted legacy id carries it and neither grammar admits one.
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
    '_',
  )
  const spliced = fc
    .tuple(
      fc.stringMatching(/^[a-zA-Z0-9-]{0,6}$/),
      hostile,
      fc.stringMatching(/^[a-zA-Z0-9-]{0,6}$/),
    )
    .map(([head, bad, tail]) => `${head}${bad}${tail}`)
  const ulid = fc.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
  const candidates = fc.oneof(
    fc.string(),
    fc.stringMatching(/^[a-zA-Z0-9_-]{0,12}$/),
    spliced,
    ulid,
    ulid.map((id) => id.toLowerCase()),
  )

  fcTest.prop([candidates])('validateWorkspaceId accepts exactly the canonical ids', (id) => {
    expect(workspaceCanonicalIdSchema.safeParse(id).success).toBe(accepts(validateWorkspaceId, id))
  })

  fcTest.prop([candidates])(
    'validateWorkspaceHandle accepts exactly a canonical id or a segment',
    (handle) => {
      const either =
        workspaceCanonicalIdSchema.safeParse(handle).success ||
        workspaceSegmentSchema.safeParse(handle).success
      expect(either).toBe(accepts(validateWorkspaceHandle, handle))
    },
  )

  it('refuses a legacy id the daemon held before the re-key onto ULIDs', () => {
    for (const legacy of ['default', 'V1StGXR8_Z5jdHi6B-myT']) {
      expect(rejection(() => validateWorkspaceId(legacy)).error).toBe('invalid_workspace_id')
    }
    expect(rejection(() => validateWorkspaceHandle('V1StGXR8_Z5jdHi6B-myT')).error).toBe(
      'invalid_workspace_id',
    )
  })

  it('both refuse the empty string', () => {
    expect(accepts(validateWorkspaceId, '')).toBe(false)
    expect(accepts(validateWorkspaceHandle, '')).toBe(false)
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
      // Either side of the length bound, in segments both rules otherwise admit.
      fc
        .integer({ min: DOCUMENT_PATH_MAX_LENGTH - 8, max: DOCUMENT_PATH_MAX_LENGTH + 8 })
        .map((length) => 'a'.repeat(length)),
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

  it('validateDocumentPath says a path past the bound is too long, without echoing it', () => {
    const error = rejection(() => validateDocumentPath('a'.repeat(DOCUMENT_PATH_MAX_LENGTH + 1)))
    expect(error.error).toBe('invalid_document_path')
    expect(error.message).toBe(
      'Invalid path: path is 1025 characters, past the 1024-character limit',
    )
  })

  it.each([
    ['', /workspaceId is empty/],
    ['a b', /a workspace id is a canonical ULID/],
    ['default', /a workspace id is a canonical ULID/],
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
