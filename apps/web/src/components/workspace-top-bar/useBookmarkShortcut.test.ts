/**
 * ⌘/Ctrl+S is the advertised way into "Bookmark this point". What the chord
 * must do is narrow: ask for the naming field, keep the browser's own Save
 * Page dialog shut, and leave every neighbouring chord alone.
 */
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBookmarkShortcut } from './useBookmarkShortcut.js'

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('useBookmarkShortcut', () => {
  let unmount: () => void = () => {}
  afterEach(() => {
    unmount()
    unmount = () => {}
  })

  function listen(enabled: boolean) {
    const onRequest = vi.fn()
    unmount = renderHook(() => useBookmarkShortcut(enabled, onRequest)).unmount
    return onRequest
  }

  it('asks for a bookmark on Ctrl+S and Cmd+S and keeps Save Page shut', () => {
    const onRequest = listen(true)
    expect(press({ key: 's', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(press({ key: 's', metaKey: true }).defaultPrevented).toBe(true)
    expect(onRequest).toHaveBeenCalledTimes(2)
  })

  it('reads a Caps Lock S as the same chord', () => {
    const onRequest = listen(true)
    expect(press({ key: 'S', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(onRequest).toHaveBeenCalledTimes(1)
  })

  it('leaves Ctrl+Shift+S to whoever else wants it', () => {
    const onRequest = listen(true)
    expect(press({ key: 'S', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false)
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('does nothing where versions are disabled', () => {
    const onRequest = listen(false)
    expect(press({ key: 's', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('hears the chord before a focused element can swallow it, and stops it there', () => {
    // The canvas focuses an offscreen editable for clipboard and IME work; a
    // bubbling listener would never hear a chord that element stops.
    const onRequest = listen(true)
    const editable = document.createElement('div')
    document.body.append(editable)
    const reached = vi.fn()
    editable.addEventListener('keydown', (e) => {
      reached()
      e.stopPropagation()
    })
    try {
      press({ key: 's', ctrlKey: true }, editable)
    } finally {
      editable.remove()
    }
    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(reached).not.toHaveBeenCalled()
  })
})
