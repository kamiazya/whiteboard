import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageSize } from '../lib/image-natural-size.js'
import { useImageSizes } from './use-image-sizes.js'

const decodes = vi.hoisted(() => new Map<string, (size: ImageSize | undefined) => void>())
vi.mock('../lib/image-natural-size.js', () => ({
  decodeNaturalSize: (href: string) =>
    new Promise<ImageSize | undefined>((resolve) => {
      decodes.set(href, resolve)
    }),
}))

afterEach(() => {
  decodes.clear()
})

describe('useImageSizes', () => {
  it('keeps a size that decoded after the set of pictures changed', async () => {
    const { result, rerender } = renderHook(({ hrefs }) => useImageSizes(hrefs), {
      initialProps: { hrefs: ['blob:a'] },
    })
    await waitFor(() => expect(decodes.has('blob:a')).toBe(true))
    // A second picture arrives while the first is still decoding.
    rerender({ hrefs: ['blob:a', 'blob:b'] })
    await waitFor(() => expect(decodes.has('blob:b')).toBe(true))
    decodes.get('blob:a')?.({ width: 640, height: 480 })
    decodes.get('blob:b')?.({ width: 20, height: 10 })
    await waitFor(() => expect(result.current.get('blob:b')).toEqual({ width: 20, height: 10 }))
    await waitFor(() => expect(result.current.get('blob:a')).toEqual({ width: 640, height: 480 }))
  })
})
