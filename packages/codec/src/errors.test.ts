import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type CodecParseResult, codecFailure } from './errors.js'

describe('codecFailure', () => {
  it('builds a typed ok:false result carrying stage, message, and issues', () => {
    const zodError = new z.ZodError([{ code: 'custom', message: 'missing type', path: ['type'] }])

    const result: CodecParseResult<{ ok: true }> = codecFailure(
      'frontmatter-schema',
      'frontmatter is missing a required core facet',
      zodError,
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure result')
    expect(result.error.stage).toBe('frontmatter-schema')
    expect(result.error.message).toBe('frontmatter is missing a required core facet')
    expect(result.error.issues).toEqual(zodError.issues)
  })

  it('defaults issues to an empty array for non-schema failure stages', () => {
    const result = codecFailure('yaml', 'malformed YAML')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure result')
    expect(result.error.issues).toEqual([])
  })
})
