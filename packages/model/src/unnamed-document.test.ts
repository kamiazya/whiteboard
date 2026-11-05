import { describe, expect, it } from 'vitest'
import { isGeneratedDocumentPath } from './unnamed-document.js'

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
