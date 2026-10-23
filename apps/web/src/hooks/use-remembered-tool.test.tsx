import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readLastTool } from '../lib/initial-tool.js'
import { useRememberedTool } from './use-remembered-tool.js'

beforeEach(() => sessionStorage.clear())
afterEach(() => sessionStorage.clear())

describe('useRememberedTool', () => {
  it('remembers the default tool the board opened in when the document is left', () => {
    const { unmount } = renderHook(() => useRememberedTool('doc-a', 'select'))
    expect(readLastTool('doc-a')).toBeNull()
    unmount()
    expect(readLastTool('doc-a')).toBe('select')
  })

  it('keeps the opening tool after the board gains content and the guess changes', () => {
    const { rerender, unmount } = renderHook(({ initial }) => useRememberedTool('doc-a', initial), {
      initialProps: { initial: 'select' as 'select' | 'hand' },
    })
    rerender({ initial: 'hand' })
    unmount()
    expect(readLastTool('doc-a')).toBe('select')
  })

  it('prefers the tool the person chose over the opening one', () => {
    const { result, unmount } = renderHook(() => useRememberedTool('doc-a', 'select'))
    act(() => result.current('hand'))
    unmount()
    expect(readLastTool('doc-a')).toBe('hand')
  })

  it('writes on pagehide, before unload', () => {
    renderHook(() => useRememberedTool('doc-a', 'select'))
    window.dispatchEvent(new Event('pagehide'))
    expect(readLastTool('doc-a')).toBe('select')
  })

  it('writes the document being left when the key changes', () => {
    const { rerender } = renderHook(({ key }) => useRememberedTool(key, 'select'), {
      initialProps: { key: 'doc-a' },
    })
    rerender({ key: 'doc-b' })
    expect(readLastTool('doc-a')).toBe('select')
    expect(readLastTool('doc-b')).toBeNull()
  })

  it('writes nothing before the document has loaded and the tool is unknown', () => {
    const { unmount } = renderHook(() => useRememberedTool('doc-a', undefined))
    unmount()
    expect(readLastTool('doc-a')).toBeNull()
  })
})
