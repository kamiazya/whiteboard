import { expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { setViewport } from './viewport.js'

/**
 * Resizing has a precondition, and the whole cost of missing it is that the
 * failure names the wrong thing. See `viewport.ts` for the mechanism.
 *
 * Measured before the helper existed, with a `page.viewport` in place of the
 * call below: `Test timed out in 60000ms`, pointing at the `it` rather than
 * at the state that refused, with the real reason arriving separately as an
 * "Unhandled Rejection" attributed to no test. The same call resolves in 6ms
 * once the window is out of fullscreen.
 */

/** Real fullscreen, which needs the transient activation a real click carries. */
async function enterFullscreen(): Promise<void> {
  const button = document.createElement('button')
  button.textContent = 'enter fullscreen'
  button.style.cssText = 'position:fixed;inset:0 auto auto 0;width:120px;height:40px;z-index:9999'
  document.body.append(button)
  const entered = new Promise<void>((resolve, reject) => {
    button.addEventListener('click', () => {
      document.documentElement.requestFullscreen().then(resolve, reject)
    })
  })
  await userEvent.click(button)
  await entered
  button.remove()
}

it('resizes a window that is in fullscreen instead of hanging on it', async () => {
  await enterFullscreen()
  expect(document.fullscreenElement).not.toBeNull()

  await setViewport(375, 900)

  expect(window.innerWidth).toBe(375)
  await setViewport(1280, 900)
})
