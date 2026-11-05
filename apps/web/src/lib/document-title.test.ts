import { describe, expect, it } from 'vitest'
import { documentArrival, documentHeading, pageTitle } from './document-title.js'

describe('document title', () => {
  it('puts the page first and the app after', () => {
    expect(pageTitle('Roadmap')).toBe('Roadmap · Whiteboard')
  })

  it('names the kind a screen reader arrives at', () => {
    expect(documentArrival('Roadmap', 'markdown')).toBe('Roadmap, markdown note')
    expect(documentArrival('Plan', 'spatial')).toBe('Plan, canvas')
  })

  it('headlines an unnamed document with the name the list shows for it', () => {
    expect(documentHeading(null, 'untitled')).toBe('Untitled')
    expect(documentHeading('', 'projects/untitled-2')).toBe('Untitled 2')
    expect(documentHeading(undefined, 'notes/plan')).toBe('plan')
    expect(documentHeading('Plan', 'untitled-2')).toBe('Plan')
  })
})
