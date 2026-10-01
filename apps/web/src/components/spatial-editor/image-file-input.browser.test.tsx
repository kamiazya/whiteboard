// The editor's one hidden image input, driven by real file picks. What a
// pick does is decided by two refs the affordance that opened it left set,
// and each is spent by the pick it steered.

import { cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { Point } from '../../lib/spatial/viewport.js'
import { ImageFileInput } from './image-file-input.js'

afterEach(cleanup)

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' })

function mount() {
  const inputRef = createRef<HTMLInputElement>()
  const backgroundRef: { current: string | null } = { current: null }
  const pointRef: { current: Point | null } = { current: null }
  const addImageFile = vi.fn()
  const onAddImage = vi.fn(async () => 'blob:ref')
  const apply = vi.fn()
  const { container } = render(
    <ImageFileInput
      inputRef={inputRef}
      onAddImage={onAddImage}
      pendingBackgroundGroupIdRef={backgroundRef}
      pendingImagePointRef={pointRef}
      addImageFile={addImageFile}
      apply={apply}
    />,
  )
  const input = container.querySelector('input') as HTMLInputElement
  return { input, backgroundRef, pointRef, addImageFile, onAddImage, apply }
}

it('a pick clears the input, so the same file can be picked again', async () => {
  // A browser fires no `change` when the chosen file equals the input's
  // current value, so a second pick of the same image would do nothing.
  const { input, addImageFile } = mount()
  const file = png()
  await userEvent.upload(input, file)
  expect(input.value).toBe('')
  await userEvent.upload(input, file)
  expect(addImageFile).toHaveBeenCalledTimes(2)
})

it('lands the image at the point the menu recorded, once', async () => {
  const { input, pointRef, addImageFile } = mount()
  pointRef.current = { x: 120, y: 80 }
  await userEvent.upload(input, png())
  expect(addImageFile).toHaveBeenLastCalledWith(expect.any(File), { x: 120, y: 80 })
  await userEvent.upload(input, png())
  expect(addImageFile).toHaveBeenLastCalledWith(expect.any(File), undefined)
})

it('paints a requested group background, and the next pick is an ordinary image', async () => {
  const { input, backgroundRef, apply, addImageFile } = mount()
  backgroundRef.current = 'g1'
  await userEvent.upload(input, png())
  await vi.waitFor(() =>
    expect(apply).toHaveBeenCalledWith({
      state: { kind: 'idle' },
      commands: [{ kind: 'set-group-background', id: 'g1', background: 'blob:ref' }],
    }),
  )
  expect(addImageFile).not.toHaveBeenCalled()
  await userEvent.upload(input, png())
  expect(addImageFile).toHaveBeenCalledTimes(1)
})

it('a file that is not an image paints no background', async () => {
  const { input, backgroundRef, onAddImage } = mount()
  // `accept` is a hint to the picker, not a rule the input enforces.
  input.removeAttribute('accept')
  backgroundRef.current = 'g1'
  await userEvent.upload(input, new File(['x'], 'a.txt', { type: 'text/plain' }))
  expect(onAddImage).not.toHaveBeenCalled()
})
