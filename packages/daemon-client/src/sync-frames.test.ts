import { describe, expect, it, vi } from 'vitest'
import { parseServerTextMessage } from './sync-frame-text.js'
import { agentActivityMessageSchema, versionCreatedMessageSchema } from './sync-frames.js'

const VALID_VERSION_CREATED = {
  type: 'version_created' as const,
  version: {
    id: 'ver-1',
    path: 'my-canvas',
    createdAt: '2026-07-30T00:00:00.000Z',
    elementCount: 42,
    auto: false,
  },
}

describe('versionCreatedMessageSchema', () => {
  it('accepts a valid version_created', () => {
    const result = versionCreatedMessageSchema.safeParse(VALID_VERSION_CREATED)
    expect(result.success).toBe(true)
  })

  it('drops a branchName an older daemon still sends', () => {
    const result = versionCreatedMessageSchema.parse({
      ...VALID_VERSION_CREATED,
      version: { ...VALID_VERSION_CREATED.version, branchName: 'main' },
    })
    expect(result.version).not.toHaveProperty('branchName')
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

describe('agentActivityMessageSchema', () => {
  const OPERATOR = { kind: 'ai', actor: 'process:agent-1' } as const
  const FRAME = {
    type: 'agent_activity' as const,
    operator: OPERATOR,
    touched: { nodes: ['n'], edges: ['e'], lines: ['l'], comments: ['c'] },
    summary: 'added 4',
  }

  it('carries touched lines and comments through parse', () => {
    expect(agentActivityMessageSchema.parse(FRAME).touched).toEqual(FRAME.touched)
  })

  it('still parses a frame from a daemon that names no lines or comments', () => {
    const { lines: _l, comments: _c, ...older } = FRAME.touched
    const parsed = agentActivityMessageSchema.safeParse({ ...FRAME, touched: older })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.touched.lines).toBeUndefined()
  })

  it('reaches a page through the one text-frame parser', () => {
    const parsed = parseServerTextMessage(JSON.stringify(FRAME), vi.fn())
    expect(parsed).toMatchObject({ type: 'agent_activity', touched: FRAME.touched })
  })
})
