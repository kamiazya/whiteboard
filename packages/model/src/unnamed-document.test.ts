import { describe, expect, it } from 'vitest'
import { documentShownName, isGeneratedDocumentPath } from './unnamed-document.js'

describe('isGeneratedDocumentPath', () => {
  it('reads the last segment as the new-document flow writes it', () => {
    for (const path of ['untitled', 'untitled-2', 'untitled-12', 'design/untitled-3']) {
      expect(isGeneratedDocumentPath(path), path).toBe(true)
    }
    for (const path of ['untitled-1', 'untitled-02', 'my-untitled', 'untitled/plan', 'plan']) {
      expect(isGeneratedDocumentPath(path), path).toBe(false)
    }
  })
})

describe('documentShownName', () => {
  it('is the chosen name whenever there is one, even "untitled"', () => {
    expect(documentShownName({ name: 'untitled', path: 'untitled-3' })).toBe('untitled')
    expect(documentShownName({ name: 'Plan', path: 'notes/untitled' })).toBe('Plan')
  })

  it('reads a generated address as "Untitled"', () => {
    expect(documentShownName({ path: 'untitled-3' })).toBe('Untitled')
    expect(documentShownName({ name: null, path: 'notes/untitled' })).toBe('Untitled')
  })

  it('reads any other unnamed address as the address itself', () => {
    expect(documentShownName({ path: 'plan' })).toBe('plan')
    expect(documentShownName({ path: 'notes/roadmap' })).toBe('notes/roadmap')
  })
})
