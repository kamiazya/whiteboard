/**
 * The touch long-press → object menu contract, in a real browser: jsdom
 * cannot express the pointer/click ordering this hook exists to manage,
 * and its failure mode is a real wrong-navigation bug — the trailing click
 * a released long-press still dispatches would OPEN the document the menu
 * just asked about.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LONG_PRESS_MS, useLongPressMenu } from './use-long-press.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function Host({
  onLongPress,
  onOpen,
}: {
  onLongPress: (path: string, x: number, y: number) => void
  onOpen: () => void
}) {
  const longPress = useLongPressMenu(onLongPress)
  return (
    <div data-testid="list" {...longPress}>
      <button type="button" data-doc-path="plan/doc" onClick={onOpen}>
        card
      </button>
    </div>
  )
}

function mount() {
  const onLongPress = vi.fn()
  const onOpen = vi.fn()
  const { getByText } = render(<Host onLongPress={onLongPress} onOpen={onOpen} />)
  return { onLongPress, onOpen, card: getByText('card') }
}

const touch = { pointerId: 7, pointerType: 'touch', clientX: 40, clientY: 60 }

it('a touch held past the threshold opens the menu for the card, and the trailing click does not open the document', () => {
  vi.useFakeTimers()
  const { onLongPress, onOpen, card } = mount()

  fireEvent.pointerDown(card, touch)
  vi.advanceTimersByTime(LONG_PRESS_MS)
  expect(onLongPress).toHaveBeenCalledWith('plan/doc', 40, 60)

  // Releasing a long-press still dispatches a click; suppressed, or it
  // would open the document under the menu that just asked what to do.
  fireEvent.pointerUp(card, touch)
  fireEvent.click(card)
  expect(onOpen).not.toHaveBeenCalled()

  // The NEXT genuine tap opens normally — suppression is one-shot.
  fireEvent.pointerDown(card, touch)
  fireEvent.pointerUp(card, touch)
  fireEvent.click(card)
  expect(onOpen).toHaveBeenCalledTimes(1)
})

it('a hold that drifts past the slop is a scroll: no menu, and the click opens normally', () => {
  vi.useFakeTimers()
  const { onLongPress, onOpen, card } = mount()

  fireEvent.pointerDown(card, touch)
  fireEvent.pointerMove(card, { ...touch, clientX: 40 + 9, clientY: 60 })
  vi.advanceTimersByTime(LONG_PRESS_MS)
  expect(onLongPress).not.toHaveBeenCalled()

  fireEvent.pointerUp(card, touch)
  fireEvent.click(card)
  expect(onOpen).toHaveBeenCalledTimes(1)
})

it('a mouse held down is not a long-press — right-click already reaches the menu', () => {
  vi.useFakeTimers()
  const { onLongPress, card } = mount()

  fireEvent.pointerDown(card, { ...touch, pointerType: 'mouse' })
  vi.advanceTimersByTime(LONG_PRESS_MS * 2)
  expect(onLongPress).not.toHaveBeenCalled()
})

it('a release before the threshold cancels the hold', () => {
  vi.useFakeTimers()
  const { onLongPress, card } = mount()

  fireEvent.pointerDown(card, touch)
  vi.advanceTimersByTime(LONG_PRESS_MS - 1)
  fireEvent.pointerUp(card, touch)
  vi.advanceTimersByTime(LONG_PRESS_MS)
  expect(onLongPress).not.toHaveBeenCalled()
})
