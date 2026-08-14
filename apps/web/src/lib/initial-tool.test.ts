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
  it('round-trips select and hand within the tab', () => {
    writeLastTool('select')
    expect(readLastTool()).toBe('select')
    writeLastTool('hand')
    expect(readLastTool()).toBe('hand')
  })

  it('does not persist connect', () => {
    writeLastTool('hand')
    writeLastTool('connect')
    expect(readLastTool()).toBe('hand')
  })

  it('reads null when nothing is stored or the value is junk', () => {
    expect(readLastTool()).toBeNull()
    sessionStorage.setItem('wb.lastTool', 'lasso')
    expect(readLastTool()).toBeNull()
  })

  it('survives a storage that throws (private mode, quota)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      expect(() => writeLastTool('select')).not.toThrow()
      expect(readLastTool()).toBeNull()
    } finally {
      setItem.mockRestore()
      getItem.mockRestore()
    }
  })
})
