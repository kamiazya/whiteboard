import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectionOverlay } from './SelectionOverlay.js'

afterEach(() => {
  cleanup()
})

const BOX = { x: 10, y: 20, width: 100, height: 50 }

describe('SelectionOverlay', () => {
  it('invokes onHandlePointerDown with the handle kind and its own (zoom-scaled) box', () => {
    const onHandlePointerDown = vi.fn()
    render(
      <SelectionOverlay
        box={BOX}
        zoom={1}
        onHandlePointerDown={onHandlePointerDown}
        onConnectPointerDown={vi.fn()}
      />,
    )
    fireEvent.pointerDown(screen.getByTestId('resize-handle-se'))
    expect(onHandlePointerDown).toHaveBeenCalledTimes(1)
    const [handle, box] = onHandlePointerDown.mock.calls[0] as [string, typeof BOX, unknown]
    expect(handle).toBe('se')
    // The HIT box (24px, centered on the corner), not the 8px marker: the
    // interactive element is the hit shape now. Its only consumer names the
    // parameter _handleBox and anchors resize on selectionBox instead, so
    // this pins the callback contract, not resize math.
    expect(box).toEqual({ x: 98, y: 58, width: 24, height: 24 })
  })

  it('scales the handle box by zoom (constant on-screen size)', () => {
    const onHandlePointerDown = vi.fn()
    render(
      <SelectionOverlay
        box={BOX}
        zoom={2}
        onHandlePointerDown={onHandlePointerDown}
        onConnectPointerDown={vi.fn()}
      />,
    )
    fireEvent.pointerDown(screen.getByTestId('resize-handle-nw'))
    const [, box] = onHandlePointerDown.mock.calls[0] as [string, typeof BOX, unknown]
    // Handle size is HANDLE_SIZE_PX / zoom = 8 / 2 = 4, centered on (x, y).
    // 24 screen px at zoom 2 → 12 canvas units, still corner-centered.
    expect(box).toEqual({ x: 4, y: 14, width: 12, height: 12 })
  })

  it('invokes onConnectPointerDown when the connect handle is pressed', () => {
    const onConnectPointerDown = vi.fn()
    render(
      <SelectionOverlay
        box={BOX}
        zoom={1}
        onHandlePointerDown={vi.fn()}
        onConnectPointerDown={onConnectPointerDown}
      />,
    )
    fireEvent.pointerDown(screen.getByTestId('connect-handle'))
    expect(onConnectPointerDown).toHaveBeenCalledTimes(1)
  })

  it('ignores a non-left-button pointerdown on a resize handle', () => {
    const onHandlePointerDown = vi.fn()
    render(
      <SelectionOverlay
        box={BOX}
        zoom={1}
        onHandlePointerDown={onHandlePointerDown}
        onConnectPointerDown={vi.fn()}
      />,
    )
    fireEvent.pointerDown(screen.getByTestId('resize-handle-se'), { button: 2 })
    expect(onHandlePointerDown).not.toHaveBeenCalled()
  })

  it('ignores a non-left-button pointerdown on the connect handle', () => {
    const onConnectPointerDown = vi.fn()
    render(
      <SelectionOverlay
        box={BOX}
        zoom={1}
        onHandlePointerDown={vi.fn()}
        onConnectPointerDown={onConnectPointerDown}
      />,
    )
    fireEvent.pointerDown(screen.getByTestId('connect-handle'), { button: 2 })
    expect(onConnectPointerDown).not.toHaveBeenCalled()
  })

  it('exposes every resize handle and the connect handle as a focusable, labeled control', () => {
    render(
      <SelectionOverlay
        box={BOX}
        zoom={1}
        onHandlePointerDown={vi.fn()}
        onConnectPointerDown={vi.fn()}
        onHandleKeyDown={vi.fn()}
        onConnectKeyDown={vi.fn()}
      />,
    )
    const handle = screen.getByTestId('resize-handle-se')
    expect(handle.getAttribute('role')).toBe('button')
    expect(handle.getAttribute('tabindex')).toBe('0')
    expect(handle.getAttribute('aria-label')).toMatch(/resize/i)
    const connect = screen.getByTestId('connect-handle')
    expect(connect.getAttribute('role')).toBe('button')
    expect(connect.getAttribute('tabindex')).toBe('0')
    expect(connect.getAttribute('aria-label')).toMatch(/connect/i)
  })

  it('invokes onHandleKeyDown with the handle kind and box on an arrow key, ignoring other keys', () => {
    const onHandleKeyDown = vi.fn()
    render(
      <SelectionOverlay
        box={BOX}
        zoom={1}
        onHandlePointerDown={vi.fn()}
        onConnectPointerDown={vi.fn()}
        onHandleKeyDown={onHandleKeyDown}
        onConnectKeyDown={vi.fn()}
      />,
    )
    const handle = screen.getByTestId('resize-handle-se')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onHandleKeyDown).toHaveBeenCalledTimes(1)
    const [kind, box] = onHandleKeyDown.mock.calls[0] as [string, typeof BOX, unknown]
    expect(kind).toBe('se')
    expect(box).toEqual({ x: 98, y: 58, width: 24, height: 24 })
    fireEvent.keyDown(handle, { key: 'Tab' })
    expect(onHandleKeyDown).toHaveBeenCalledTimes(1)
  })

  it('invokes onConnectKeyDown on Enter/Space, ignoring other keys', () => {
    const onConnectKeyDown = vi.fn()
    render(
      <SelectionOverlay
        box={BOX}
        zoom={1}
        onHandlePointerDown={vi.fn()}
        onConnectPointerDown={vi.fn()}
        onHandleKeyDown={vi.fn()}
        onConnectKeyDown={onConnectKeyDown}
      />,
    )
    const connect = screen.getByTestId('connect-handle')
    fireEvent.keyDown(connect, { key: 'Enter' })
    expect(onConnectKeyDown).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(connect, { key: ' ' })
    expect(onConnectKeyDown).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(connect, { key: 'Tab' })
    expect(onConnectKeyDown).toHaveBeenCalledTimes(2)
  })
})

it('grows the hit boxes to 32px where the pointer is coarse', () => {
  const original = window.matchMedia
  // The repo already stubs matchMedia in jsdom (useThemeMode.test.tsx) —
  // this branch is plain JS, so unlike dock-button's CSS-only variant it
  // is testable and therefore tested.
  window.matchMedia = ((query: string) =>
    ({
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia
  try {
    const onHandlePointerDown = vi.fn()
    render(
      <SelectionOverlay
        box={BOX}
        zoom={1}
        onHandlePointerDown={onHandlePointerDown}
        onConnectPointerDown={vi.fn()}
      />,
    )
    fireEvent.pointerDown(screen.getByTestId('resize-handle-se'))
    const [, box] = onHandlePointerDown.mock.calls[0] as [string, typeof BOX]
    expect(box.width).toBe(32)
  } finally {
    window.matchMedia = original
  }
})
