import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readLastTool, resolveInitialTool, writeLastTool } from './initial-tool.js'

beforeEach(() => {
  sessionStorage.clear()
})

describe('resolveInitialTool', () => {
  it('starts an empty canvas in select — nothing to pan, everything to make', () => {
    expect(resolveInitialTool({ isEmpty: true, lastTool: null })).toBe('select')
  })

  it('starts a canvas that already has content in hand — reading before editing', () => {
    expect(resolveInitialTool({ isEmpty: false, lastTool: null })).toBe('hand')
  })

  it("prefers this tab's last tool over the emptiness guess, in both directions", () => {
    expect(resolveInitialTool({ isEmpty: true, lastTool: 'hand' })).toBe('hand')
    expect(resolveInitialTool({ isEmpty: false, lastTool: 'select' })).toBe('select')
  })

  it('never restores connect — a transient drawing mode is not a resting state', () => {
    expect(resolveInitialTool({ isEmpty: false, lastTool: 'connect' })).toBe('hand')
    expect(resolveInitialTool({ isEmpty: true, lastTool: 'connect' })).toBe('select')
  })
})

describe('last-tool session storage', () => {
  it('round-trips select and hand per document within the session', () => {
    writeLastTool('doc-a', 'select')
    writeLastTool('doc-b', 'hand')
    expect(readLastTool('doc-a')).toBe('select')
    expect(readLastTool('doc-b')).toBe('hand')
    writeLastTool('doc-a', 'hand')
    expect(readLastTool('doc-a')).toBe('hand')
  })

  it('reads null for a document never opened, whatever another one chose', () => {
    writeLastTool('doc-a', 'select')
    expect(readLastTool('doc-other')).toBeNull()
  })

  it('reads null once the session storage is cleared', () => {
    writeLastTool('doc-a', 'select')
    sessionStorage.clear()
    expect(readLastTool('doc-a')).toBeNull()
  })

  it('does not persist connect', () => {
    writeLastTool('doc-a', 'hand')
    writeLastTool('doc-a', 'connect')
    expect(readLastTool('doc-a')).toBe('hand')
  })

  it('reads null when the value is junk', () => {
    writeLastTool('doc-a', 'hand')
    const [key] = Object.keys(sessionStorage)
    sessionStorage.setItem(key as string, 'lasso')
    expect(readLastTool('doc-a')).toBeNull()
  })

  it('survives a storage that throws (private mode, quota)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      expect(() => writeLastTool('doc-a', 'select')).not.toThrow()
      expect(readLastTool('doc-a')).toBeNull()
    } finally {
      setItem.mockRestore()
      getItem.mockRestore()
    }
  })
})
