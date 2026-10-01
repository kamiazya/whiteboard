import { fireEvent } from '@testing-library/react'

/** A context-menu gesture at (x, y) in `el`'s own coordinates. */
export function rightClick(el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + x,
      clientY: r.top + y,
      button: 2,
    }),
  )
}

/** One mouse-button pointer event of `type` at (x, y), pointer id 7. Returns `dispatchEvent`'s answer. */
export function press(el: HTMLElement, type: string, x: number, y: number): boolean {
  const r = el.getBoundingClientRect()
  return el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: r.left + x,
      clientY: r.top + y,
      pointerId: 7,
      button: 0,
    }),
  )
}

/** One primary-touch pointer event of `type` at (x, y). */
export function touch(el: HTMLElement, type: string, x: number, y: number, pointerId = 7): void {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: r.left + x,
      clientY: r.top + y,
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: type === 'pointerdown' ? 0 : -1,
      buttons: type === 'pointerup' ? 0 : 1,
    }),
  )
}

/** A click (pointer down then up) at (x, y); `shift` extends the selection. */
export function selectAt(root: HTMLElement, x: number, y: number, shift = false): void {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    shiftKey: shift,
    clientX: r.left + x,
    clientY: r.top + y,
  })
  fireEvent.pointerUp(root, {
    pointerId: 1,
    shiftKey: shift,
    clientX: r.left + x,
    clientY: r.top + y,
  })
}
