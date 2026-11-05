import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readLastTool, resolveInitialTool, writeLastTool } from './initial-tool.js'

beforeEach(() => {
  sessionStorage.clear()
})

describe('resolveInitialTool', () => {
  it('opens in select when this tab has no tool remembered for the canvas', () => {
    expect(resolveInitialTool({ lastTool: null })).toBe('select')
  })

  it("returns to this tab's last resting tool for the canvas", () => {
    expect(resolveInitialTool({ lastTool: 'hand' })).toBe('hand')
    expect(resolveInitialTool({ lastTool: 'select' })).toBe('select')
  })

  it('never restores connect or draw — a transient marking mode is not a resting state', () => {
    expect(resolveInitialTool({ lastTool: 'connect' })).toBe('select')
    expect(resolveInitialTool({ lastTool: 'draw' })).toBe('select')
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
