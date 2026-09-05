import { describe, expect, it } from 'vitest'
import { isEditorOverlayTarget } from './editor-overlay.js'

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

describe('isEditorOverlayTarget', () => {
  it('recognises a control by what it is, with no attribute to forget', () => {
    const host = mount(
      '<div role="dialog"><p><button>Close</button></p></div><textarea></textarea><a href="#x">l</a>',
    )
    expect(isEditorOverlayTarget(host.querySelector('button'))).toBe(true)
    expect(isEditorOverlayTarget(host.querySelector('p'))).toBe(true)
    expect(isEditorOverlayTarget(host.querySelector('textarea'))).toBe(true)
    expect(isEditorOverlayTarget(host.querySelector('a'))).toBe(true)
  })

  it('still honours the explicit opt-in on a container that is not a control', () => {
    const host = mount('<div data-editor-overlay><span>minimap</span></div><span>canvas</span>')
    expect(isEditorOverlayTarget(host.querySelector('span'))).toBe(true)
    expect(isEditorOverlayTarget(host.querySelectorAll('span')[1] ?? null)).toBe(false)
  })

  it('leaves an SVG handle wearing role=button to the canvas gestures', () => {
    const host = mount('<svg><rect role="button" tabindex="0"></rect></svg>')
    expect(isEditorOverlayTarget(host.querySelector('rect'))).toBe(false)
  })

  it('answers false for a non-element target', () => {
    expect(isEditorOverlayTarget(null)).toBe(false)
    expect(isEditorOverlayTarget(document)).toBe(false)
  })
})
