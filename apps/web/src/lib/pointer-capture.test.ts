// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { trySetPointerCapture } from './pointer-capture.js'

const rootWith = (setPointerCapture: (id: number) => void): HTMLElement =>
  ({ setPointerCapture }) as unknown as HTMLElement

describe('trySetPointerCapture', () => {
  it('captures the pointer on the root', () => {
    const setPointerCapture = vi.fn()
    trySetPointerCapture(rootWith(setPointerCapture), 7)
    expect(setPointerCapture).toHaveBeenCalledWith(7)
  })

  it('swallows the rejection a pointerId with no active record raises', () => {
    const root = rootWith(() => {
      throw new DOMException('no such pointer', 'NotFoundError')
    })
    expect(() => trySetPointerCapture(root, 7)).not.toThrow()
  })
})
