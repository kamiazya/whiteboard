import { describe, expect, it } from 'vitest'
import { versionCreatedMessageSchema } from './ws-messages.js'

const VALID_VERSION_CREATED = {
  type: 'version_created' as const,
  version: {
    id: 'ver-1',
    slug: 'my-canvas',
    createdAt: '2026-07-30T00:00:00.000Z',
    elementCount: 42,
    auto: false,
    hasThumbnail: true,
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
        operator: { kind: 'ai', peerId: 'agent-1' },
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing branchName', () => {
    const { branchName: _, ...versionWithout } = VALID_VERSION_CREATED.version
    const result = versionCreatedMessageSchema.safeParse({
      ...VALID_VERSION_CREATED,
      version: versionWithout,
    })
    expect(result.success).toBe(false)
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
