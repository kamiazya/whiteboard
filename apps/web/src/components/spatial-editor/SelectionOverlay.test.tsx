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
    // se handle is centered on the box's bottom-right corner (x+width, y+height).
    expect(box).toEqual({ x: 106, y: 66, width: 8, height: 8 })
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
    expect(box).toEqual({ x: 8, y: 18, width: 4, height: 4 })
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
})
