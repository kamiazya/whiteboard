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

  it('headlines an unnamed document with the title box placeholder, not its address', () => {
    expect(documentHeading(null)).toBe('Untitled')
    expect(documentHeading('')).toBe('Untitled')
    expect(documentHeading('Plan')).toBe('Plan')
  })
})
