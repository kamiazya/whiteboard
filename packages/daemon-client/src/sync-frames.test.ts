import { describe, expect, it, vi } from 'vitest'
import { parseServerTextMessage } from './sync-frame-text.js'
import { versionCreatedMessageSchema } from './sync-frames.js'

const VALID_VERSION_CREATED = {
  type: 'version_created' as const,
  version: {
    id: 'ver-1',
    path: 'my-canvas',
    createdAt: '2026-07-30T00:00:00.000Z',
    elementCount: 42,
    auto: false,
    branchName: 'main',
  },
}

describe('versionCreatedMessageSchema', () => {
  it('accepts valid version_created with branchName', () => {
    const result = versionCreatedMessageSchema.safeParse(VALID_VERSION_CREATED)
    expect(result.success).toBe(true)
  })

  it('preserves branchName through parse', () => {
    const result = versionCreatedMessageSchema.parse(VALID_VERSION_CREATED)
    expect(result.version.branchName).toBe('main')
  })

  it('accepts with optional label and operator', () => {
    const result = versionCreatedMessageSchema.safeParse({
      ...VALID_VERSION_CREATED,
      version: {
        ...VALID_VERSION_CREATED.version,
        label: 'snapshot',
        operator: { kind: 'ai', actor: 'process:agent-1' },
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a version row that carries no branchName', () => {
    const { branchName: _, ...versionWithout } = VALID_VERSION_CREATED.version
    const result = versionCreatedMessageSchema.safeParse({
      ...VALID_VERSION_CREATED,
      version: versionWithout,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing elementCount', () => {
    const { elementCount: _, ...versionWithout } = VALID_VERSION_CREATED.version
    const result = versionCreatedMessageSchema.safeParse({
      ...VALID_VERSION_CREATED,
      version: versionWithout,
    })
    expect(result.success).toBe(false)
  })
})

describe('parseServerTextMessage', () => {
  it('refuses valid JSON of the wrong shape with a warning carrying the schema message', () => {
    const warn = vi.fn()
    expect(parseServerTextMessage('{"type":"nonsense"}', warn)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const [, reason] = warn.mock.calls[0] as [string, string]
    expect(reason.length).toBeGreaterThan(0)
    expect(reason).not.toBe('schema mismatch')
  })

  it('refuses malformed JSON with a warning', () => {
    const warn = vi.fn()
    expect(parseServerTextMessage('{', warn)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'malformed JSON', '{')
  })
})
