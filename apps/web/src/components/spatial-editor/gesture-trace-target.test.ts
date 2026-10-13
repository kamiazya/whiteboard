/**
 * What the flight recorder keeps of a pressed element. The trace is always
 * on and is pasted into bug reports, so it promises to carry no document
 * content — and accessible names do: they interpolate URLs, folder names and
 * titles. Only content-free identity (tag, test-id, role) may survive.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { describeTarget } from './gesture-trace.js'

const SECRET = 'https://example.test/private/Quarterly-Plan'

afterEach(() => {
  document.body.replaceChildren()
})

describe('describeTarget', () => {
  it('keeps no accessible name from the pressed element', () => {
    const button = document.createElement('button')
    button.setAttribute('aria-label', `Load ${SECRET}`)
    button.setAttribute('role', 'menuitem')
    document.body.append(button)

    const descriptor = describeTarget(button)

    expect(JSON.stringify(descriptor)).not.toContain(SECRET)
    expect(descriptor).toEqual({ tag: 'button', role: 'menuitem' })
  })

  it('names an unlabelled-by-test-id overlay without its accessible name', () => {
    const overlay = document.createElement('div')
    overlay.setAttribute('data-editor-overlay', '')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-label', `Editing ${SECRET}`)
    const inner = document.createElement('span')
    overlay.append(inner)
    document.body.append(overlay)

    const descriptor = describeTarget(inner)

    expect(JSON.stringify(descriptor)).not.toContain(SECRET)
    expect(descriptor.overlay).toBe('dialog')
  })

  it('still names an overlay by its test-id first', () => {
    const overlay = document.createElement('div')
    overlay.setAttribute('data-editor-overlay', '')
    overlay.setAttribute('data-testid', 'link-url-dialog')
    overlay.setAttribute('aria-label', `Open folder ${SECRET}`)
    document.body.append(overlay)

    const descriptor = describeTarget(overlay)

    expect(descriptor).toEqual({
      tag: 'div',
      testId: 'link-url-dialog',
      overlay: 'link-url-dialog',
    })
  })
})
