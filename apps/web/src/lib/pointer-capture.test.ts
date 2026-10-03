// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { trySetPointerCapture } from './pointer-capture.js'

type Root = Parameters<typeof trySetPointerCapture>[0]

const rootWith = (setPointerCapture: (id: number) => void): Root =>
  ({ setPointerCapture }) as unknown as Root

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
