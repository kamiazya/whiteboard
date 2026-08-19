import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOnScreen } from './useOnScreen.js'

afterEach(cleanup)

/** Captures the observers a render creates so a test can fire them by hand. */
function installObserver() {
  const instances: {
    callback: (entries: { isIntersecting: boolean }[]) => void
    target: Element | null
    disconnected: boolean
  }[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      readonly #self = { callback: () => {}, target: null as Element | null, disconnected: false }
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        this.#self.callback = callback as never
        instances.push(this.#self)
      }
      observe(target: Element) {
        this.#self.target = target
      }
      disconnect() {
        this.#self.disconnected = true
      }
      unobserve() {}
    },
  )
  return instances
}

function Probe() {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>()
  return (
    <div ref={ref} data-testid="probe">
      {onScreen ? 'seen' : 'unseen'}
    </div>
  )
}

describe('useOnScreen', () => {
  it('starts unseen, so nothing is fetched for a row nobody looked at', () => {
    installObserver()
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('probe').textContent).toBe('unseen')
  })

  it('reports seen once the element intersects', () => {
    const observers = installObserver()
    const { getByTestId } = render(<Probe />)
    act(() => observers[0]?.callback([{ isIntersecting: true }]))
    expect(getByTestId('probe').textContent).toBe('seen')
  })

  // Scrolling away must not undo the work already done: a row that has been
  // seen keeps whatever it loaded, rather than fetching again on the way back.
  it('stays seen after the element scrolls away', () => {
    const observers = installObserver()
    const { getByTestId } = render(<Probe />)
    act(() => observers[0]?.callback([{ isIntersecting: true }]))
    act(() => observers[0]?.callback([{ isIntersecting: false }]))
    expect(getByTestId('probe').textContent).toBe('seen')
  })

  it('stops observing once it has been seen', () => {
    const observers = installObserver()
    render(<Probe />)
    act(() => observers[0]?.callback([{ isIntersecting: true }]))
    expect(observers[0]?.disconnected).toBe(true)
  })

  it('disconnects on unmount', () => {
    const observers = installObserver()
    const { unmount } = render(<Probe />)
    unmount()
    expect(observers[0]?.disconnected).toBe(true)
  })

  // A browser without the API must not leave every row blank forever.
  it('reports seen immediately where IntersectionObserver does not exist', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('probe').textContent).toBe('seen')
  })
})
